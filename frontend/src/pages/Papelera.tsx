import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFetch } from '../hooks';
import { api, fmtFecha } from '../api';
import { Spinner, useToast, useConfirm } from '../ui';

interface Row {
  id: number; nroOrden: string | null; estado: string; deletedAt: string; local: string;
  asunto: string | null; personasCount: number; personasLabel: string | null;
}

/** Papelera: solicitudes enviadas a la papelera (borrado lógico), recuperables. */
export default function Papelera() {
  const { data, loading, reload } = useFetch<Row[]>('/solicitudes/papelera', []);
  const nav = useNavigate();
  const { notify } = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<number | null>(null);

  const restaurar = async (r: Row) => {
    if (!await confirm({ title: 'Restaurar solicitud', message: `¿Restaurar la solicitud de "${r.local}"${r.nroOrden ? ` (${r.nroOrden})` : ''}? Vuelve al listado y a las personas se les recalcula la autorización.`, confirmLabel: 'Restaurar' })) return;
    setBusy(r.id);
    try { await api.post(`/solicitudes/${r.id}/restaurar`); notify('Solicitud restaurada.', 'success'); reload(); }
    catch (e: any) { notify(e.message, 'error'); } finally { setBusy(null); }
  };

  const purgar = async (r: Row) => {
    if (!await confirm({ title: 'Borrar definitivamente', danger: true, confirmLabel: 'Borrar definitivo',
      message: `¿Borrar DEFINITIVAMENTE la solicitud de "${r.local}"${r.nroOrden ? ` (${r.nroOrden})` : ''}?\n\nEsta acción NO se puede deshacer: se borra la solicitud y las personas que no tengan otra solicitud ni ingresos.` })) return;
    setBusy(r.id);
    try { await api.del(`/solicitudes/${r.id}/purgar`); notify('Solicitud borrada definitivamente.', 'success'); reload(); }
    catch (e: any) { notify(e.message, 'error'); } finally { setBusy(null); }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Papelera</h1><div className="subtitle">Solicitudes eliminadas. Podés restaurarlas.</div></div>
      </div>

      <div className="alert info" style={{ marginBottom: 16 }}>
        Al eliminar una solicitud no se borra de verdad: queda acá y se puede <strong>restaurar</strong>. Mientras está en la papelera, sus autorizaciones quedan revocadas (no habilita ingresos).
      </div>

      <div className="card">
        <div className="table-wrap">
          {loading ? <div className="card-body"><Spinner /></div> : (
            <table className="tbl">
              <thead><tr><th>Orden</th><th>Local</th><th>Personas</th><th>Eliminada</th><th></th></tr></thead>
              <tbody>
                {data?.length === 0 && <tr><td colSpan={5} className="empty">La papelera está vacía. 🎉</td></tr>}
                {data?.map((r) => (
                  <tr key={r.id}>
                    <td>{r.nroOrden ? <span className="chip">{r.nroOrden}</span> : <span className="muted">—</span>}</td>
                    <td><strong>{r.local}</strong>{r.asunto && <div className="muted" style={{ fontSize: 12 }}>{r.asunto}</div>}</td>
                    <td>
                      <span className="chip">{r.personasCount} {r.personasCount === 1 ? 'persona' : 'personas'}</span>
                      <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>{r.personasLabel || '—'}</div>
                    </td>
                    <td className="muted">{fmtFecha(r.deletedAt)}</td>
                    <td>
                      <span className="btn-row">
                        <button className="btn ghost sm" onClick={() => nav(`/solicitudes/${r.id}`)}>Ver</button>
                        <button className="btn primary sm" disabled={busy === r.id} onClick={() => restaurar(r)}>↩ Restaurar</button>
                        <button className="btn danger sm" disabled={busy === r.id} onClick={() => purgar(r)}>🗑 Borrar definitivo</button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
