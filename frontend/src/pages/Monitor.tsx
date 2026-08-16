import { useFetch } from '../hooks';
import { fmtFecha } from '../api';
import { Badge, Spinner } from '../ui';

export default function Monitor() {
  const { data, loading } = useFetch<any>('/config/monitor');
  if (loading || !data) return <Spinner />;
  const s = data.scheduler;
  return (
    <>
      <div className="page-head"><div><h1>Monitoreo</h1><div className="subtitle">Estado del procesamiento automático de emails</div></div></div>

      <div className="grid kpis" style={{ marginBottom: 16 }}>
        <div className="kpi"><div className="label">Lector automático</div><div className="value" style={{ fontSize: 18 }}>{s.configurado ? (s.pollMinutes > 0 ? `Cada ${s.pollMinutes} min` : 'Pausado') : 'Sin configurar'}</div></div>
        <div className="kpi"><div className="label">Última sincronización</div><div className="value" style={{ fontSize: 16 }}>{s.lastSyncAt ? fmtFecha(s.lastSyncAt) : '—'}</div></div>
        <div className="kpi"><div className="label">Jobs con error</div><div className="value">{data.jobsConError}</div></div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">Emails por estado</div>
          <div className="table-wrap">
            <table className="tbl"><thead><tr><th>Estado</th><th>Cantidad</th></tr></thead>
              <tbody>
                {data.emailsPorEstado.length === 0 && <tr><td colSpan={2} className="empty">Todavía no se recibieron emails.</td></tr>}
                {data.emailsPorEstado.map((e: any) => <tr key={e.estado}><td><Badge estado={e.estado} /></td><td>{e.n}</td></tr>)}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <div className="card-head">Últimos emails</div>
          <div className="table-wrap">
            <table className="tbl"><thead><tr><th>Asunto</th><th>Estado</th><th>Recibido</th></tr></thead>
              <tbody>
                {data.ultimosEmails.length === 0 && <tr><td colSpan={3} className="empty">—</td></tr>}
                {data.ultimosEmails.map((e: any) => <tr key={e.id}><td>{e.asunto ?? '—'}</td><td><Badge estado={e.estado} /></td><td className="muted">{fmtFecha(e.fechaRecibido)}</td></tr>)}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
