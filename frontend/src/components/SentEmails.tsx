import { useState } from 'react';
import { useFetch } from '../hooks';
import { fmtFecha } from '../api';
import { Spinner } from '../ui';

interface Sent {
  id: number; fecha: string; destinatario: string | null; asunto: string | null;
  cuerpo: string | null; tipo: string | null; ok: boolean; error: string | null;
}

const TIPO_LABEL: Record<string, string> = {
  RESULTADO_REVISION: 'Resultado de revisión', OBSERVACION: 'Observación', RECHAZO: 'Rechazo',
  AUTORIZACION: 'Autorización', PLANILLA_EXCESIVA: 'Aviso: planilla excesiva',
};

/** Lista los correos que el sistema envió (para una solicitud, o todos si no se pasa solicitudId). */
export function SentEmails({ solicitudId }: { solicitudId?: number }) {
  const qs = solicitudId ? `?solicitudId=${solicitudId}` : '';
  const { data, loading } = useFetch<Sent[]>(`/emails/enviados${qs}`, [solicitudId]);
  const [abierto, setAbierto] = useState<number | null>(null);

  if (loading) return <Spinner />;
  if (!data || data.length === 0) return <p className="muted">Todavía no se envió ningún correo desde el sistema.</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {data.map((s) => (
        <div key={s.id} className="card" style={{ padding: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5 }}>
                <span className="chip">{s.tipo ? TIPO_LABEL[s.tipo] ?? s.tipo : 'Correo'}</span>
                {' '}
                {s.ok ? <span className="badge green">Enviado</span> : <span className="badge red">No enviado</span>}
              </div>
              <div style={{ marginTop: 4 }}><strong>{s.asunto ?? '(sin asunto)'}</strong></div>
              <div className="muted" style={{ fontSize: 12 }}>Para: {s.destinatario || '—'} · {fmtFecha(s.fecha)}</div>
              {!s.ok && s.error && <div className="muted" style={{ fontSize: 12, color: 'var(--red, #dc2626)' }}>Motivo: {s.error}</div>}
            </div>
            <button className="btn ghost sm" onClick={() => setAbierto(abierto === s.id ? null : s.id)}>{abierto === s.id ? 'Ocultar' : 'Ver texto'}</button>
          </div>
          {abierto === s.id && (
            <div className="card" style={{ marginTop: 8, padding: 10, whiteSpace: 'pre-wrap', fontSize: 13, background: 'var(--panel-2)' }}>{s.cuerpo || '(sin contenido)'}</div>
          )}
        </div>
      ))}
    </div>
  );
}
