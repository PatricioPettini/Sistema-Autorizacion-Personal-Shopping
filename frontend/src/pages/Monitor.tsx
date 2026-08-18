import { useEffect, useState } from 'react';
import { useFetch } from '../hooks';
import { fmtFecha } from '../api';
import { Badge, Spinner } from '../ui';

export default function Monitor() {
  // Se refresca solo: el lector corre en segundo plano y esta pantalla es para vigilarlo.
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  const { data, loading } = useFetch<any>('/config/monitor', [tick]);
  if (loading || !data) return <Spinner />;
  const s = data.scheduler;
  return (
    <>
      <div className="page-head"><div><h1>Monitoreo</h1><div className="subtitle">Estado del procesamiento automático de emails</div></div></div>

      <div className="grid kpis" style={{ marginBottom: 16 }}>
        <div className="kpi"><div className="label">Lector automático</div><div className="value" style={{ fontSize: 18 }}>{s.configurado ? (s.pollMinutes > 0 ? `Cada ${s.pollMinutes} min` : 'Pausado') : 'Sin configurar'}</div></div>
        <div className="kpi"><div className="label">Última sincronización</div><div className="value" style={{ fontSize: 16 }}>{s.lastSyncAt ? fmtFecha(s.lastSyncAt) : '—'}</div></div>
        <div className="kpi"><div className="label">Próxima revisión</div><div className="value" style={{ fontSize: 16 }}>{s.activo && s.nextRunAt ? fmtFecha(s.nextRunAt) : '—'}</div></div>
        <div className="kpi"><div className="label">Jobs con error</div><div className="value">{data.jobsConError}</div></div>
      </div>

      {!s.activo && (
        <div className="alert warn" style={{ marginBottom: 16 }}>
          El lector automático <strong>no está corriendo</strong> {s.configurado ? '(frecuencia en 0)' : '(falta configurar el servidor IMAP)'}.
          Configuralo en <strong>Administración → Configuración de email</strong>.
        </div>
      )}
      {s.lastResult && !s.lastResult.ok && (
        <div className="alert error" style={{ marginBottom: 16 }}>Última revisión con error: {s.lastResult.error}</div>
      )}

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
