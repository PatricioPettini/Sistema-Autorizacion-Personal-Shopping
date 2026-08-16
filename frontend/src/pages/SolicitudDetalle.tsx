import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useFetch } from '../hooks';
import { api, fmtFecha, fmtSoloFecha, hoy, tipoLabel } from '../api';
import { Badge, Spinner, Modal, useToast } from '../ui';
import { DocList } from '../components/DocList';
import { EmailInline } from '../components/EmailInline';
import { useAuth } from '../auth';

type AccionModal = { tipo: 'autorizar' | 'observar' | 'rechazar'; personaId: number; solicitudId: number; nombre: string };

/** Extrae el nombre del local del asunto "Solicitud FAO (Local) Tipo" (igual que el backend). */
function localFromAsunto(asunto?: string | null): string | null {
  if (!asunto) return null;
  const s = asunto.trim();
  let m = s.match(/solicitud\s+fao\s*\(([^)]+)\)/i);
  if (m) return m[1].trim().replace(/\s+/g, ' ');
  m = s.match(/solicitud\s+fao\s*[-–—]\s*([^-–—]+?)\s*(?:[-–—]|$)/i);
  if (m) return m[1].trim().replace(/\s+/g, ' ');
  m = s.match(/solicitud\s+fao\s+(\S+)/i);
  if (m && !/^(empresas?|monotributistas?)$/i.test(m[1])) return m[1].trim();
  return null;
}

export default function SolicitudDetalle() {
  const { id } = useParams();
  const { data, loading, reload } = useFetch<any>(`/solicitudes/${id}`, [id]);
  const { data: locales } = useFetch<any[]>('/locales', []);
  const isAdmin = useAuth().user?.rol === 'ADMIN';
  const { notify } = useToast();
  const nav = useNavigate();

  const [accion, setAccion] = useState<AccionModal | null>(null);
  const [comentario, setComentario] = useState('');
  const [fecha, setFecha] = useState(hoy());
  const [fechaHasta, setFechaHasta] = useState(hoy());
  const [desde, setDesde] = useState('08:00');
  const [hasta, setHasta] = useState('18:00');
  const [nuevoComentario, setNuevoComentario] = useState('');
  const [busy, setBusy] = useState(false);
  const [agregar, setAgregar] = useState(false);
  const [nuevaPersona, setNuevaPersona] = useState({ cuil: '', nombre: '', apellido: '' });
  const [edit, setEdit] = useState<{ personaId: number; cuil: string; nombre: string; apellido: string } | null>(null);

  if (!data) return <Spinner />;
  const { solicitud, local, email, comentarios, personas } = data;
  const sinLocal = local?.nombre === '(Sin asignar)';
  const localSugerido = localFromAsunto(email?.asunto);
  // Tipo de contratista de la solicitud (común a todas sus personas). Campo de solo lectura.
  const catsSolicitud = new Set<string>(personas.map((p: any) => p.docStatus?.categoria).filter(Boolean));
  const tipoSolicitud = catsSolicitud.size === 0 ? null : catsSolicitud.size === 1 ? [...catsSolicitud][0] : 'MIXTO';

  const run = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true);
    try { await fn(); notify(ok, 'success'); reload(); }
    catch (e: any) { notify(e.message, 'error'); }
    finally { setBusy(false); }
  };

  const cerrarAccion = () => { setAccion(null); setComentario(''); };

  const confirmarAccion = async () => {
    if (!accion) return;
    const { tipo, personaId, solicitudId } = accion;
    if (tipo === 'autorizar') {
      await run(() => api.post('/autorizaciones', { solicitudId, personaId, fecha, fechaHasta, horaDesde: desde, horaHasta: hasta, comentario }), 'Ingreso autorizado.');
    } else if (tipo === 'observar') {
      await run(() => api.post(`/solicitudes/${solicitudId}/personas/${personaId}/observar`, { comentario }), 'Persona observada.');
    } else if (tipo === 'rechazar') {
      await run(() => api.post(`/solicitudes/${solicitudId}/personas/${personaId}/rechazar`, { motivo: comentario }), 'Persona rechazada.');
    }
    cerrarAccion();
  };

  const asignarLocal = (localId: number) => { if (localId) run(() => api.post(`/solicitudes/${solicitud.id}/local`, { localId }), 'Local asignado.'); };
  const crearYAsignarLocal = (nombre: string) => run(async () => {
    const nuevo = await api.post<{ id: number }>('/locales', { nombre });
    await api.post(`/solicitudes/${solicitud.id}/local`, { localId: nuevo.id });
  }, `Local "${nombre}" creado y asignado.`);
  const addComentario = () => { if (!nuevoComentario.trim()) return; run(() => api.post(`/solicitudes/${solicitud.id}/comentarios`, { contenido: nuevoComentario }), 'Comentario agregado.').then(() => setNuevoComentario('')); };
  const agregarPersona = async () => {
    if (!nuevaPersona.cuil || !nuevaPersona.nombre || !nuevaPersona.apellido) { notify('Completá CUIL, nombre y apellido.', 'error'); return; }
    await run(() => api.post(`/solicitudes/${solicitud.id}/personas`, nuevaPersona), 'Persona agregada.');
    setAgregar(false); setNuevaPersona({ cuil: '', nombre: '', apellido: '' });
  };
  const quitarPersona = (solicitudId: number, personaId: number, nombre: string) => {
    if (!confirm(`¿Quitar a ${nombre} de esta solicitud? (No se borra la persona ni su documentación.)`)) return;
    run(() => api.del(`/solicitudes/${solicitudId}/personas/${personaId}`), 'Persona quitada.');
  };
  const guardarEdit = async () => {
    if (!edit) return;
    await run(() => api.patch(`/personas/${edit.personaId}`, { cuil: edit.cuil, nombre: edit.nombre, apellido: edit.apellido }), 'Datos actualizados.');
    setEdit(null);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <a className="muted" onClick={() => nav('/solicitudes')} style={{ cursor: 'pointer' }}>← Solicitudes</a>
          <h1 style={{ marginTop: 6 }}>{sinLocal ? <span className="badge orange">Local sin asignar</span> : local.nombre}</h1>
          <div className="subtitle">
            {personas.length} {personas.length === 1 ? 'persona' : 'personas'}
            {' · '}Tipo: <strong>{tipoLabel(tipoSolicitud)}</strong>
            {' · '}<Badge estado={solicitud.estado} />
          </div>
        </div>
        {isAdmin && <button className="btn primary" onClick={() => setAgregar(true)}>+ Agregar persona</button>}
      </div>

      {isAdmin && sinLocal && (
        <div className="alert warn" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>
            ⚠️ El local del asunto no coincide con ninguno cargado{localSugerido && <> — el email dice: <strong>“{localSugerido}”</strong></>}. Asignalo para poder autorizar:
          </span>
          {localSugerido && <button className="btn sm primary" disabled={busy} onClick={() => crearYAsignarLocal(localSugerido)}>➕ Crear “{localSugerido}” y asignar</button>}
          <select className="btn sm" onChange={(e) => asignarLocal(Number(e.target.value))} defaultValue="" disabled={busy}>
            <option value="" disabled>o elegir uno existente…</option>
            {(locales ?? []).filter((l) => l.nombre !== '(Sin asignar)').map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
          </select>
        </div>
      )}

      {/* Email de origen, embebido y a lo ancho, para revisar la documentación mientras se verifica cada persona. */}
      {solicitud.emailMessageId && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">✉️ Email de origen (documentación recibida)</div>
          <div className="card-body"><EmailInline emailId={solicitud.emailMessageId} wide /></div>
        </div>
      )}

      {/* Una tarjeta por persona: checklist manual + acciones. En pantallas anchas, 2 por fila. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(430px, 1fr))', gap: 16, marginBottom: 16, alignItems: 'start' }}>
      {personas.map((p: any) => {
        const puedeAutorizar = !sinLocal && p.docStatus.todosVerificados;
        const motivo = sinLocal ? 'Asigná primero el local' : !p.docStatus.todosVerificados ? 'Aprobá toda la documentación obligatoria' : '';
        const autorizada = p.estado === 'AUTORIZADA';
        return (
          <div className="card" key={p.spId}>
            <div className="card-head" style={{ flexWrap: 'wrap', gap: 8 }}>
              <span>
                <strong>{p.apellido}, {p.nombre}</strong>{' '}
                <span className="muted" style={{ fontWeight: 400 }}>CUIL {p.cuilFormat}</span>{' '}
                <Badge estado={p.estado} />
                {p.vigencia === 'AUTORIZADO' && <span className="badge green" style={{ marginLeft: 6 }}>🟢 Ingreso vigente</span>}
              </span>
              {isAdmin && (
                <span className="btn-row">
                  <button className="btn ghost sm" onClick={() => setEdit({ personaId: p.personaId, cuil: p.cuil ?? '', nombre: p.nombre, apellido: p.apellido })} title="Corregir datos">✎ Editar</button>
                  <button className="btn ghost sm" onClick={() => nav(`/personas/${p.personaId}`)}>Ver ficha</button>
                  <button className="btn ghost sm" onClick={() => quitarPersona(p.solicitudId, p.personaId, `${p.apellido}, ${p.nombre}`)} title="Quitar de la solicitud">Quitar</button>
                </span>
              )}
            </div>
            <div className="card-body">
              <div style={{ marginBottom: 8 }} className="muted">Revisá cada requisito contra la documentación del email. Un requisito solo cuenta como cumplido cuando lo aprobás.</div>
              <DocList docStatus={p.docStatus} personaId={p.personaId} onChanged={reload} />

              {p.estado === 'RECHAZADA' && p.motivoRechazo && <div className="alert error" style={{ marginTop: 10 }}>Rechazada: {p.motivoRechazo}</div>}

              {isAdmin && (
                <>
                  {!sinLocal && !p.docStatus.todosVerificados && (
                    <div className="alert warn" style={{ marginTop: 10 }}>
                      🔒 Para autorizar, aprobá toda la documentación: {p.docStatus.verificadosObligatorios} de {p.docStatus.totalObligatorios} aprobados.
                    </div>
                  )}
                  <div className="btn-row" style={{ marginTop: 12 }}>
                    <button className="btn warning sm" onClick={() => setAccion({ tipo: 'observar', personaId: p.personaId, solicitudId: p.solicitudId, nombre: `${p.apellido}, ${p.nombre}` })}>Observar</button>
                    <button className="btn danger sm" onClick={() => setAccion({ tipo: 'rechazar', personaId: p.personaId, solicitudId: p.solicitudId, nombre: `${p.apellido}, ${p.nombre}` })}>Rechazar</button>
                    {!autorizada && <button className="btn success sm" disabled={!puedeAutorizar} title={motivo} onClick={() => { setFecha(hoy()); setFechaHasta(hoy()); setAccion({ tipo: 'autorizar', personaId: p.personaId, solicitudId: p.solicitudId, nombre: `${p.apellido}, ${p.nombre}` }); }}>Autorizar</button>}
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })}
      </div>

      {personas.length === 0 && <div className="card"><div className="card-body empty">Esta solicitud no tiene personas. {isAdmin && 'Agregá al menos una.'}</div></div>}

      {/* Comentarios de la solicitud */}
      <div className="card">
        <div className="card-head">💬 Comentarios</div>
        <div className="card-body">
          {isAdmin && (
            <div style={{ marginBottom: 14 }}>
              <textarea rows={2} placeholder="Escribir un comentario…" value={nuevoComentario} onChange={(e) => setNuevoComentario(e.target.value)} style={{ width: '100%', padding: 10, border: '1px solid var(--border)', borderRadius: 9 }} />
              <button className="btn sm primary" style={{ marginTop: 8 }} onClick={addComentario} disabled={busy}>Agregar comentario</button>
            </div>
          )}
          {comentarios.length === 0 && <p className="muted">Sin comentarios.</p>}
          {comentarios.map((c: any) => (
            <div key={c.id} style={{ padding: '10px 0', borderTop: '1px dashed var(--border)' }}>
              <div className="muted" style={{ fontSize: 12 }}>{fmtFecha(c.createdAt)} · {c.userNombre ?? 'Sistema'}</div>
              <div>{c.contenido}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Modal de acciones por persona */}
      {accion?.tipo === 'autorizar' && (
        <Modal title={`Autorizar ingreso — ${accion.nombre}`} onClose={cerrarAccion}
          footer={<><button className="btn" onClick={cerrarAccion}>Cancelar</button><button className="btn success" onClick={confirmarAccion} disabled={busy || fechaHasta < fecha}>Confirmar autorización</button></>}>
          <div className="alert info">La autorización vale para todo el rango de fechas indicado. Para un solo día, poné la misma fecha en "desde" y "hasta".</div>
          <div className="form-row">
            <div className="field"><label>Fecha desde</label><input type="date" value={fecha} onChange={(e) => { setFecha(e.target.value); if (fechaHasta < e.target.value) setFechaHasta(e.target.value); }} /></div>
            <div className="field"><label>Fecha hasta</label><input type="date" value={fechaHasta} min={fecha} onChange={(e) => setFechaHasta(e.target.value)} /></div>
          </div>
          <div className="form-row">
            <div className="field"><label>Hora desde</label><input type="time" value={desde} onChange={(e) => setDesde(e.target.value)} /></div>
            <div className="field"><label>Hora hasta</label><input type="time" value={hasta} onChange={(e) => setHasta(e.target.value)} /></div>
          </div>
          <div className="field"><label>Comentario (opcional)</label><textarea rows={2} value={comentario} onChange={(e) => setComentario(e.target.value)} /></div>
        </Modal>
      )}
      {accion?.tipo === 'observar' && (
        <Modal title={`Observar — ${accion.nombre}`} onClose={cerrarAccion}
          footer={<><button className="btn" onClick={cerrarAccion}>Cancelar</button><button className="btn warning" onClick={confirmarAccion} disabled={busy}>Confirmar</button></>}>
          <div className="field"><label>Observación</label><textarea rows={3} value={comentario} onChange={(e) => setComentario(e.target.value)} placeholder="Ej: Falta presentar seguro de vida actualizado." /></div>
        </Modal>
      )}
      {accion?.tipo === 'rechazar' && (
        <Modal title={`Rechazar — ${accion.nombre}`} onClose={cerrarAccion}
          footer={<><button className="btn" onClick={cerrarAccion}>Cancelar</button><button className="btn danger" onClick={confirmarAccion} disabled={busy || !comentario.trim()}>Confirmar rechazo</button></>}>
          <div className="alert warn">El motivo es obligatorio y quedará registrado en la auditoría.</div>
          <div className="field"><label>Motivo del rechazo *</label><textarea rows={3} value={comentario} onChange={(e) => setComentario(e.target.value)} /></div>
        </Modal>
      )}

      {agregar && (
        <Modal title="Agregar persona a la solicitud" onClose={() => setAgregar(false)}
          footer={<><button className="btn" onClick={() => setAgregar(false)}>Cancelar</button><button className="btn primary" onClick={agregarPersona} disabled={busy}>Agregar</button></>}>
          <div className="alert info">Si el CUIL ya existe, se usa esa persona (no se duplica).</div>
          <div className="form-row">
            <div className="field"><label>Apellido *</label><input value={nuevaPersona.apellido} onChange={(e) => setNuevaPersona({ ...nuevaPersona, apellido: e.target.value })} /></div>
            <div className="field"><label>Nombre *</label><input value={nuevaPersona.nombre} onChange={(e) => setNuevaPersona({ ...nuevaPersona, nombre: e.target.value })} /></div>
          </div>
          <div className="field"><label>CUIL *</label><input value={nuevaPersona.cuil} onChange={(e) => setNuevaPersona({ ...nuevaPersona, cuil: e.target.value })} placeholder="20-30123456-7" /></div>
        </Modal>
      )}

      {edit && (
        <Modal title="Editar datos de la persona" onClose={() => setEdit(null)}
          footer={<><button className="btn" onClick={() => setEdit(null)}>Cancelar</button><button className="btn primary" onClick={guardarEdit} disabled={busy}>Guardar</button></>}>
          <div className="alert info">El CUIL identifica a la persona: si lo cambiás, se corrige en todo el sistema.</div>
          <div className="form-row">
            <div className="field"><label>Apellido</label><input value={edit.apellido} onChange={(e) => setEdit({ ...edit, apellido: e.target.value })} /></div>
            <div className="field"><label>Nombre</label><input value={edit.nombre} onChange={(e) => setEdit({ ...edit, nombre: e.target.value })} /></div>
          </div>
          <div className="field"><label>CUIL</label><input value={edit.cuil} onChange={(e) => setEdit({ ...edit, cuil: e.target.value })} placeholder="20-30123456-7" /></div>
        </Modal>
      )}
    </>
  );
}
