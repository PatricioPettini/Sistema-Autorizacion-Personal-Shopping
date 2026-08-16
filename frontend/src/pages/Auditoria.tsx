import { useState } from 'react';
import { useFetch } from '../hooks';
import { fmtFecha } from '../api';
import { Spinner } from '../ui';

interface AuditResp {
  rows: { id: number; accion: string; descripcion: string; createdAt: string; userNombre: string | null }[];
  total: number;
  page: number;
  pageSize: number;
}

const PAGE_SIZE = 50;

export default function Auditoria() {
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [page, setPage] = useState(1);

  const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (desde) query.set('desde', desde);
  if (hasta) query.set('hasta', hasta);

  const { data, loading } = useFetch<AuditResp>(`/auditoria?${query.toString()}`, [desde, hasta, page]);
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const cambiar = (setter: (v: string) => void) => (v: string) => { setter(v); setPage(1); };

  return (
    <>
      <div className="page-head"><div><h1>Auditoría</h1><div className="subtitle">Registro de todas las acciones del sistema</div></div></div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
          <div className="field" style={{ margin: 0 }}><label>Desde</label><input type="date" value={desde} max={hasta || undefined} onChange={(e) => cambiar(setDesde)(e.target.value)} /></div>
          <div className="field" style={{ margin: 0 }}><label>Hasta</label><input type="date" value={hasta} min={desde || undefined} onChange={(e) => cambiar(setHasta)(e.target.value)} /></div>
          {(desde || hasta) && <button className="btn sm" style={{ marginBottom: 2 }} onClick={() => { setDesde(''); setHasta(''); setPage(1); }}>Limpiar fechas</button>}
          <div style={{ flex: 1 }} />
          <div className="muted" style={{ fontSize: 13 }}>{total} registro{total === 1 ? '' : 's'}</div>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          {loading ? <div className="card-body"><Spinner /></div> : (
            <table className="tbl">
              <thead><tr><th>Fecha</th><th>Usuario</th><th>Detalle</th></tr></thead>
              <tbody>
                {data?.rows.length === 0 && <tr><td colSpan={3} className="empty">Sin registros con esos filtros.</td></tr>}
                {data?.rows.map((a) => (
                  <tr key={a.id}>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtFecha(a.createdAt)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{a.userNombre ?? <span className="muted">Sistema</span>}</td>
                    <td>{a.descripcion || <span className="muted">{a.accion}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {totalPages > 1 && (
          <div className="card-body" style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'center' }}>
            <button className="btn sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Anterior</button>
            <span className="muted" style={{ fontSize: 13 }}>Página {page} de {totalPages}</span>
            <button className="btn sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Siguiente →</button>
          </div>
        )}
      </div>
    </>
  );
}
