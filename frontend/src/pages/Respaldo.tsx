import { useState, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFetch } from '../hooks';
import { api, fmtFecha } from '../api';
import { Spinner, useToast, useConfirm } from '../ui';
import { EmailInline } from '../components/EmailInline';

interface SolRef { id: number; nroOrden: string | null; local: string; }
interface Row {
  id: number; remitente: string | null; asunto: string | null; fecha: string | null;
  fechaRecibido: string; estado: string; motivo: string | null; attachmentsCount: number;
  replySolicitudId: number | null; solicitud: SolRef | null;
}

const ESTADO_LABEL: Record<string, string> = { NEEDS_REVIEW: 'Para revisar', ERROR: 'Con error' };

export default function Respaldo() {
  const { data, loading, reload } = useFetch<Row[]>('/emails/respaldo', []);
  const nav = useNavigate();
  const { notify } = useToast();
  const confirm = useConfirm();
  const [abierto, setAbierto] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const procesar = async (r: Row) => {
    if (!await confirm({ title: 'Procesar igual', message: 'Procesar igual este correo y crear la solicitud automáticamente? Usalo solo si estás seguro de que es un pedido nuevo (no una respuesta o corrección).', confirmLabel: 'Procesar igual' })) return;
    setBusy(r.id);
    try {
      const res = await api.post<{ estado: string; motivo: string | null }>(`/emails/${r.id}/procesar`);
      notify(res.estado === 'PROCESSED' ? 'Correo procesado: se creó/actualizó la solicitud.' : `No se pudo procesar: ${res.motivo ?? res.estado}`, res.estado === 'PROCESSED' ? 'success' : 'error');
      reload();
    } catch (e: any) { notify(e.message, 'error'); } finally { setBusy(null); }
  };
  const descartar = async (r: Row) => {
    if (!await confirm({ title: 'Descartar correo', message: 'Descartar este correo del respaldo? Se marca como revisado y sale de la lista (no se borra).', confirmLabel: 'Descartar' })) return;
    setBusy(r.id);
    try { await api.post(`/emails/${r.id}/descartar`); notify('Correo descartado del respaldo.', 'success'); reload(); }
    catch (e: any) { notify(e.message, 'error'); } finally { setBusy(null); }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Respaldo de correos</h1><div className="subtitle">Correos que no terminaron en una solicitud automática: revisalos a mano</div></div>
      </div>

      <div className="alert info" style={{ marginBottom: 16 }}>
        Acá caen los correos con error, sin planilla legible, con demasiadas personas, o que son
        <strong> respuestas/reenvíos</strong> de un pedido anterior. Revisalos, cargá lo que corresponda
        en la solicitud original y después <strong>descartalos</strong> para sacarlos de la lista.
      </div>

      <div className="card">
        <div className="table-wrap">
          {loading ? <div className="card-body"><Spinner /></div> : (
            <table className="tbl">
              <thead><tr><th>Recibido</th><th>Remitente</th><th>Asunto</th><th>Estado</th><th>Motivo</th><th></th></tr></thead>
              <tbody>
                {data?.length === 0 && <tr><td colSpan={6} className="empty">No hay correos en respaldo. 🎉</td></tr>}
                {data?.map((r) => (
                  <Fragment key={r.id}>
                    <tr>
                      <td className="muted">{fmtFecha(r.fechaRecibido)}</td>
                      <td>{r.remitente ?? '—'}</td>
                      <td><strong>{r.asunto ?? '(sin asunto)'}</strong>{r.attachmentsCount > 0 && <span className="chip" style={{ marginLeft: 6 }}>📎 {r.attachmentsCount}</span>}</td>
                      <td><span className={`badge ${r.estado === 'ERROR' ? 'red' : 'orange'}`}>{ESTADO_LABEL[r.estado] ?? r.estado}</span></td>
                      <td style={{ maxWidth: 320, fontSize: 12.5 }}>
                        {r.motivo ?? '—'}
                        {r.solicitud && (
                          <div style={{ marginTop: 4 }}>
                            <button className="btn ghost sm" onClick={() => nav(`/solicitudes/${r.solicitud!.id}`)}>
                              → Ir a la solicitud{r.solicitud.nroOrden ? ` ${r.solicitud.nroOrden}` : ''} · {r.solicitud.local}
                            </button>
                          </div>
                        )}
                      </td>
                      <td>
                        <span className="btn-row">
                          <button className="btn ghost sm" onClick={() => setAbierto(abierto === r.id ? null : r.id)}>{abierto === r.id ? 'Ocultar' : 'Ver email'}</button>
                          <button className="btn ghost sm" disabled={busy === r.id} onClick={() => procesar(r)} title="Crear la solicitud igual (forzar)">Procesar igual</button>
                          <button className="btn ghost sm" disabled={busy === r.id} onClick={() => descartar(r)}>Descartar</button>
                        </span>
                      </td>
                    </tr>
                    {abierto === r.id && (
                      <tr>
                        <td colSpan={6} style={{ background: 'var(--panel-2)' }}>
                          <EmailInline emailId={r.id} wide />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
