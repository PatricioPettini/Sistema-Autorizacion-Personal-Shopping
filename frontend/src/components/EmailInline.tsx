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
  useEffect(() => { api.get<EmailData>(`/emails/${emailId}/adjuntos`).then(setData).catch((e) => setError(e.message)); }, [emailId]);
  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <Spinner />;
  const alto = wide ? 720 : 320;
  // Solo se muestran los PDF (la documentación). Se ignoran logos, firmas, imágenes y el Excel.
  const pdfs = data.adjuntos.filter((a) => esPdf(a.contentType, a.filename));
  return (
    <>
      <div className="stat-line"><span className="muted">Remitente:</span> <strong>{data.remitente ?? '—'}</strong></div>
      <div className="stat-line"><span className="muted">Asunto:</span> <strong>{data.asunto ?? '—'}</strong></div>
      <div className="stat-line"><span className="muted">Fecha:</span> <strong>{fmtFecha(data.fecha)}</strong></div>
      {data.cuerpo && (
        <div className="card" style={{ margin: '10px 0', padding: 10, whiteSpace: 'pre-wrap', fontSize: 13, maxHeight: 160, overflow: 'auto' }}>{data.cuerpo}</div>
      )}
      <div style={{ fontWeight: 600, margin: '6px 0 8px' }}>Documentación PDF ({pdfs.length})</div>
      {pdfs.length === 0 && <p className="muted">El email no tiene documentación en PDF.</p>}
      <div style={wide
        ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }
        : { display: 'flex', flexDirection: 'column', gap: 10 }}>
        {pdfs.map((a) => {
          const url = `/api/emails/${emailId}/adjuntos/${a.index}`;
          // En modo ancho, cada PDF ocupa toda la fila (más legible).
          const cardStyle = wide ? { padding: 8, gridColumn: '1 / -1' as const } : { padding: 8 };
          return (
            <div key={a.index} className="card" style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <strong style={{ fontSize: 12.5 }}>{a.filename}</strong>
                <a className="btn ghost sm" href={url} target="_blank" rel="noreferrer">Abrir</a>
              </div>
              <iframe src={url} title={a.filename} style={{ width: '100%', height: alto, border: '1px solid var(--border)', borderRadius: 6 }} />
            </div>
          );
        })}
      </div>
    </>
  );
}
