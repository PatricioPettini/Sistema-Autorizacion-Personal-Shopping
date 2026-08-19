import { useEffect, useState } from 'react';
import { Spinner } from '../ui';
import { api, fmtFecha } from '../api';

interface Adjunto { index: number; filename: string; contentType: string; size: number; }
interface EmailData { remitente: string | null; asunto: string | null; fecha: string | null; cuerpo: string; adjuntos: Adjunto[]; }

function esPdf(ct: string, n: string) { return /pdf/.test(ct) || /\.pdf$/i.test(n); }

/**
 * Muestra el email de origen embebido (remitente, asunto, cuerpo y adjuntos)
 * directamente dentro del detalle, sin necesidad de abrir una ventana aparte.
 */
export function EmailInline({ emailId, wide }: { emailId: number; wide?: boolean }) {
  const [data, setData] = useState<EmailData | null>(null);
  const [error, setError] = useState('');
  // Qué PDFs están efectivamente abiertos (montados como iframe). Vacío al principio:
  // así abrir la revisión NO dispara la descarga de todos los PDF de golpe.
  const [abiertos, setAbiertos] = useState<Set<number>>(new Set());
  useEffect(() => {
    setData(null); setError(''); setAbiertos(new Set());
    api.get<EmailData>(`/emails/${emailId}/adjuntos`).then(setData).catch((e) => setError(e.message));
  }, [emailId]);
  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <Spinner />;
  const alto = wide ? 720 : 320;
  // Solo se muestran los PDF (la documentación). Se ignoran logos, firmas, imágenes y el Excel.
  const pdfs = data.adjuntos.filter((a) => esPdf(a.contentType, a.filename));
  const toggle = (i: number) => setAbiertos((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });
  return (
    <>
      <div className="stat-line"><span className="muted">Remitente:</span> <strong>{data.remitente ?? '—'}</strong></div>
      <div className="stat-line"><span className="muted">Asunto:</span> <strong>{data.asunto ?? '—'}</strong></div>
      <div className="stat-line"><span className="muted">Fecha:</span> <strong>{fmtFecha(data.fecha)}</strong></div>
      {data.cuerpo && (
        <div className="card" style={{ margin: '10px 0', padding: 10, whiteSpace: 'pre-wrap', fontSize: 13, maxHeight: 160, overflow: 'auto' }}>{data.cuerpo}</div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0 8px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>Documentación PDF ({pdfs.length})</span>
        {pdfs.length > 0 && (
          abiertos.size === pdfs.length
            ? <button className="btn ghost sm" onClick={() => setAbiertos(new Set())}>Cerrar todos</button>
            : <button className="btn ghost sm" onClick={() => setAbiertos(new Set(pdfs.map((a) => a.index)))}>Ver todos</button>
        )}
      </div>
      {pdfs.length === 0 && <p className="muted">El email no tiene documentación en PDF.</p>}
      <div style={wide
        ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }
        : { display: 'flex', flexDirection: 'column', gap: 10 }}>
        {pdfs.map((a) => {
          const url = `/api/emails/${emailId}/adjuntos/${a.index}`;
          const abierto = abiertos.has(a.index);
          // En modo ancho, cada PDF ocupa toda la fila (más legible).
          const cardStyle = wide ? { padding: 8, gridColumn: '1 / -1' as const } : { padding: 8 };
          return (
            <div key={a.index} className="card" style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: abierto ? 6 : 0, gap: 8 }}>
                <strong style={{ fontSize: 12.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.filename}</strong>
                <span className="btn-row">
                  <button className="btn ghost sm" onClick={() => toggle(a.index)}>{abierto ? 'Ocultar' : 'Ver'}</button>
                  <a className="btn ghost sm" href={url} target="_blank" rel="noreferrer">Abrir</a>
                </span>
              </div>
              {/* El iframe (y por ende la descarga) se monta solo cuando el usuario lo pide. */}
              {abierto && <iframe src={url} title={a.filename} style={{ width: '100%', height: alto, border: '1px solid var(--border)', borderRadius: 6 }} />}
            </div>
          );
        })}
      </div>
    </>
  );
}
