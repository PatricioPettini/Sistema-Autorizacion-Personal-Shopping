import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useFetch } from '../hooks';
import { Badge, Spinner, Modal, useToast } from '../ui';
import { api, fmtFecha, tipoLabel, hoy } from '../api';
import { useAuth } from '../auth';

interface Row { id: number; estado: string; updatedAt: string; fecha: string | null; local: string; localId: number; emailAsunto: string | null; personasCount: number; personasLabel: string; tipo: string | null; }
interface Local { id: number; nombre: string; }

const ESTADOS = ['', 'PENDIENTE', 'EN_REVISION', 'OBSERVADA', 'AUTORIZADA', 'RECHAZADA', 'REVOCADA'];
const VACIO = { cuil: '', nombre: '', apellido: '', localId: '' };

export default function Solicitudes() {
  const [params, setParams] = useSearchParams();
  const [estado, setEstado] = useState(params.get('estado') ?? '');
  const [localId, setLocalId] = useState('');
  const [q, setQ] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  // Si llega ?estado= desde el panel, aplicarlo.
  useEffect(() => { setEstado(params.get('estado') ?? ''); }, [params.get('estado')]);

  const query = new URLSearchParams();
  if (estado) query.set('estado', estado);
  if (localId) query.set('localId', localId);
  if (q) query.set('q', q);
  if (desde) query.set('desde', desde);
  if (hasta) query.set('hasta', hasta);

  const { data, loading, reload } = useFetch<Row[]>(`/solicitudes?${query.toString()}`, [estado, localId, q, desde, hasta]);
  const { data: locales } = useFetch<Local[]>('/locales');
  const nav = useNavigate();
  const isAdmin = useAuth().user?.rol === 'ADMIN';
  const { notify } = useToast();
  const [nueva, setNueva] = useState(false);
  const [form, setForm] = useState(VACIO);
  const [busy, setBusy] = useState(false);

  const localesReales = (locales ?? []).filter((l) => l.nombre !== '(Sin asignar)');

  const cambiarEstado = (e: string) => { setEstado(e); setParams(e ? { estado: e } : {}); };

  const crear = async () => {
    if (!form.cuil || !form.nombre || !form.apellido || !form.localId) { notify('Completá CUIL, nombre, apellido y local.', 'error'); return; }
    setBusy(true);
    try {
      const r = await api.post<{ solicitudId: number }>('/solicitudes/manual', {
        localId: Number(form.localId),
        personas: [{ cuil: form.cuil, nombre: form.nombre, apellido: form.apellido }],
      });
      notify('Solicitud creada. Agregá más personas desde el detalle.', 'success');
      setNueva(false); setForm(VACIO); reload();
      nav(`/solicitudes/${r.solicitudId}`);
    } catch (e: any) { notify(e.message, 'error'); } finally { setBusy(false); }
  };

  // Atajos de fecha (rango en días, en zona local).
  const hoyStr = hoy();
  const menosDias = (n: number) => { const d = new Date(`${hoyStr}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const presets = [
    { k: 'hoy', label: 'Hoy', d: hoyStr, h: hoyStr },
    { k: 'ayer', label: 'Ayer', d: menosDias(1), h: menosDias(1) },
    { k: '7', label: 'Últimos 7 días', d: menosDias(6), h: hoyStr },
    { k: 'mes', label: 'Este mes', d: `${hoyStr.slice(0, 8)}01`, h: hoyStr },
  ];
  const hayFiltros = !!(desde || hasta || estado || localId || q);
  const limpiar = () => { setDesde(''); setHasta(''); setLocalId(''); setQ(''); cambiarEstado(''); };

  return (
    <>
      <div className="page-head">
        <div><h1>Solicitudes</h1><div className="subtitle">Cada solicitud es un local con una o varias personas a autorizar</div></div>
        {isAdmin && <button className="btn primary" onClick={() => { setForm(VACIO); setNueva(true); }}>+ Nueva solicitud</button>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head" style={{ fontSize: 13 }}>
          <span>🔎 Filtros</span>
          {hayFiltros && <button className="btn ghost sm" onClick={limpiar}>Limpiar filtros</button>}
        </div>
        <div className="card-body" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div className="field" style={{ margin: 0, minWidth: 150 }}>
            <label>Estado</label>
            <select value={estado} onChange={(e) => cambiarEstado(e.target.value)}>
              {ESTADOS.map((e) => <option key={e} value={e}>{e === '' ? 'Todos' : e.replace('_', ' ')}</option>)}
            </select>
          </div>
          <div className="field" style={{ margin: 0, minWidth: 150 }}>
            <label>Local</label>
            <select value={localId} onChange={(e) => setLocalId(e.target.value)}>
              <option value="">Todos</option>
              {locales?.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Fecha de envío</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="date" value={desde} max={hasta || undefined} onChange={(e) => setDesde(e.target.value)} style={{ width: 150 }} />
              <span className="muted">→</span>
              <input type="date" value={hasta} min={desde || undefined} onChange={(e) => setHasta(e.target.value)} style={{ width: 150 }} />
            </div>
            <div className="btn-row" style={{ marginTop: 8, gap: 6 }}>
              {presets.map((p) => {
                const activo = desde === p.d && hasta === p.h;
                return <button key={p.k} className={`btn sm ${activo ? 'primary' : 'ghost'}`} style={{ padding: '3px 10px', fontSize: 12, border: activo ? undefined : '1px solid var(--border)' }} onClick={() => { setDesde(p.d); setHasta(p.h); }}>{p.label}</button>;
              })}
            </div>
          </div>
          <div className="field" style={{ margin: 0, flex: 1, minWidth: 180 }}>
            <label>Buscar persona / CUIL</label>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nombre o CUIL" />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          {loading ? <div className="card-body"><Spinner /></div> : (
            <table className="tbl">
              <thead><tr><th>Local</th><th>Tipo</th><th>Personas</th><th>Estado</th><th>Enviado</th><th>Actualizado</th></tr></thead>
              <tbody>
                {data?.length === 0 && <tr><td colSpan={6} className="empty">No hay solicitudes con esos filtros.</td></tr>}
                {data?.map((r) => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/solicitudes/${r.id}`)}>
                    <td><strong>{r.local === '(Sin asignar)' ? <span className="badge orange">Sin asignar</span> : r.local}</strong></td>
                    <td>{r.tipo ? <span className="chip">{tipoLabel(r.tipo)}</span> : <span className="muted">—</span>}</td>
                    <td>
                      <span className="chip">{r.personasCount} {r.personasCount === 1 ? 'persona' : 'personas'}</span>
                      <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>{r.personasLabel || '—'}</div>
                    </td>
                    <td><Badge estado={r.estado} /></td>
                    <td className="muted">{fmtFecha(r.fecha)}</td>
                    <td className="muted">{fmtFecha(r.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {nueva && (
        <Modal title="Nueva solicitud" onClose={() => setNueva(false)}
          footer={<><button className="btn" onClick={() => setNueva(false)}>Cancelar</button><button className="btn primary" onClick={crear} disabled={busy}>Crear solicitud</button></>}>
          <div className="alert info">Elegí el local y cargá la primera persona (por CUIL). Después podés agregar más personas desde el detalle. Si el CUIL ya existe, se usa esa persona (no se duplica).</div>
          <div className="field"><label>Local *</label>
            <select value={form.localId} onChange={(e) => setForm({ ...form, localId: e.target.value })}>
              <option value="">Elegir local…</option>
              {localesReales.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
            </select>
          </div>
          <div className="form-row">
            <div className="field"><label>Apellido *</label><input value={form.apellido} onChange={(e) => setForm({ ...form, apellido: e.target.value })} /></div>
            <div className="field"><label>Nombre *</label><input value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} /></div>
          </div>
          <div className="field"><label>CUIL *</label><input value={form.cuil} onChange={(e) => setForm({ ...form, cuil: e.target.value })} placeholder="20-30123456-7" /></div>
          {localesReales.length === 0 && <div className="alert warn">No hay locales cargados. Pedile al Administrador que cree los locales en Administración → Locales.</div>}
        </Modal>
      )}
    </>
  );
}
