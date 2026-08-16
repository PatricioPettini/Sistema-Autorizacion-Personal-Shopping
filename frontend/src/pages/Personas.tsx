import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useFetch } from '../hooks';
import { api } from '../api';
import { Spinner, Modal, useToast } from '../ui';

interface Persona { id: number; nombre: string; apellido: string; cuilFormat: string; cuil: string; }

export default function Personas() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  // Sincroniza el buscador con el ?q= de la URL (ej. al usar la búsqueda del encabezado).
  useEffect(() => { setQ(params.get('q') ?? ''); }, [params.get('q')]);
  const { data, loading, reload } = useFetch<Persona[]>(`/personas?q=${encodeURIComponent(q)}`, [q]);
  const nav = useNavigate();
  const { notify } = useToast();
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ cuil: '', nombre: '', apellido: '' });
  const [busy, setBusy] = useState(false);

  const crear = async () => {
    setBusy(true);
    try { const p = await api.post<Persona>('/personas', form); notify('Persona creada.', 'success'); setModal(false); setForm({ cuil: '', nombre: '', apellido: '' }); nav(`/personas/${p.id}`); }
    catch (e: any) { notify(e.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Personas</h1><div className="subtitle">Personal externo: consultá si puede ingresar y registrá ingresos/salidas desde la ficha</div></div>
        <button className="btn primary" onClick={() => setModal(true)}>+ Nueva persona</button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body"><input placeholder="Buscar por nombre, apellido o DNI" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 9 }} /></div>
      </div>

      <div className="card">
        <div className="table-wrap">
          {loading ? <div className="card-body"><Spinner /></div> : (
            <table className="tbl">
              <thead><tr><th>Apellido y nombre</th><th>CUIL</th></tr></thead>
              <tbody>
                {data?.length === 0 && <tr><td colSpan={2} className="empty">No hay personas.</td></tr>}
                {data?.map((p) => (
                  <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/personas/${p.id}`)}>
                    <td><strong>{p.apellido}, {p.nombre}</strong></td>
                    <td>{p.cuilFormat}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {modal && (
        <Modal title="Nueva persona" onClose={() => setModal(false)}
          footer={<><button className="btn" onClick={() => setModal(false)}>Cancelar</button><button className="btn primary" onClick={crear} disabled={busy}>Crear</button></>}>
          <div className="field"><label>CUIL</label><input value={form.cuil} onChange={(e) => setForm({ ...form, cuil: e.target.value })} placeholder="20-30123456-7" /></div>
          <div className="form-row">
            <div className="field"><label>Nombre</label><input value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} /></div>
            <div className="field"><label>Apellido</label><input value={form.apellido} onChange={(e) => setForm({ ...form, apellido: e.target.value })} /></div>
          </div>
        </Modal>
      )}
    </>
  );
}
