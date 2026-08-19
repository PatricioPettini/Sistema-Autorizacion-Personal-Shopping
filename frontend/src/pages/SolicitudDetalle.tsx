import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useFetch } from '../hooks';
import { api, fmtFecha, fmtSoloFecha, tipoLabel } from '../api';
import { Badge, Spinner, Modal, useToast } from '../ui';
import { DocList } from '../components/DocList';
import { EmailInline } from '../components/EmailInline';
import { useAuth } from '../auth';

type AccionModal = { tipo: 'observar' | 'rechazar'; personaId: number; solicitudId: number; nombre: string };

/** Extrae el nombre del local del asunto (mismo criterio flexible que el backend). */
function localFromAsunto(asunto?: string | null): string | null {
  if (!asunto) return null;
  const s = asunto.trim();
  const limpiar = (x: string) =>
    x.replace(/\b(empresas?|monotributistas?|mono)\b/gi, '')
      .replace(/[()\-–—:]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  if (/\bfao\b/i.test(s)) {
    const par = s.match(/\(([^)]+)\)/);
    if (par) { const n = limpiar(par[1]); if (n) return n; }
  }
  const m = s.match(/\bfao\b\s*(.+)$/i);
  if (m) {
    let rest = m[1].replace(/^[\s\-–—:]+/, '');
    rest = rest.split(/\b(?:para|de\s+ingreso|ingreso|egreso)\b|[-–—:|]/i)[0];
    const n = limpiar(rest);
    if (n) return n;
  }
  return null;
}

export default function SolicitudDetalle() {
  const { id } = useParams();
  const { data, reload } = useFetch<any>(`/solicitudes/${id}`, [id]);
  const { data: locales } = useFetch<any[]>('/locales', []);
  const { data: tiposDoc } = useFetch<any[]>('/tipos-documento', []);
  const isAdmin = useAuth().user?.rol === 'ADMIN';
  const { notify } = useToast();
  const nav = useNavigate();

  // Catálogo de requisitos EXTRA que se pueden agregar durante la revisión.
  const catalogoExtra = (tiposDoc ?? []).filter((t: any) => t.categoria === 'EXTRA' && t.activo);

  const [revisando, setRevisando] = useState(false);
  const [confirmarTerminar, setConfirmarTerminar] = useState(false);
  const [resultado, setResultado] = useState<{ nroOrden: string | null; emailEnviado: boolean; to: string; motivo: string | null } | null>(null);
  const [venc, setVenc] = useState('');
  const [accion, setAccion] = useState<AccionModal | null>(null);
  const [comentario, setComentario] = useState('');
  const [nuevoComentario, setNuevoComentario] = useState('');
  const [busy, setBusy] = useState(false);
  const [agregar, setAgregar] = useState(false);
  const [nuevaPersona, setNuevaPersona] = useState({ cuil: '', nombre: '', apellido: '', categoria: '' });
  const [edit, setEdit] = useState<{ personaId: number; cuil: string; nombre: string; apellido: string } | null>(null);
  const [nuevoLocal, setNuevoLocal] = useState('');
  const [cambiandoLocal, setCambiandoLocal] = useState(false);
  const [reqPersona, setReqPersona] = useState<{ personaId: number; nombre: string } | null>(null);
  const [reqSel, setReqSel] = useState('');
  const [reqNombre, setReqNombre] = useState('');

  // Sincronizar el campo de vencimiento con lo que trae la solicitud.
  useEffect(() => { if (data?.solicitud) setVenc(data.solicitud.fechaVencimiento ?? ''); }, [data?.solicitud?.fechaVencimiento]);

  if (!data) return <Spinner />;
  const { solicitud, local, email, comentarios, personas } = data;
  const sinLocal = local?.nombre === '(Sin asignar)';
  const localSugerido = localFromAsunto(email?.asunto);
  const catsSolicitud = new Set<string>(personas.map((p: any) => p.docStatus?.categoria).filter(Boolean));
  const tipoSolicitud = catsSolicitud.size === 0 ? null : catsSolicitud.size === 1 ? [...catsSolicitud][0] : 'MIXTO';
  // No se puede terminar la revisión si a alguna persona le falta el tipo (empresa/monotributo).
  const personasSinTipo = (personas as any[]).filter((p: any) => !p.docStatus?.categoria);
  const faltaTipo = personasSinTipo.length > 0;
  const fechaVenc = solicitud.fechaVencimiento as string | null;

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
    if (tipo === 'observar') await run(() => api.post(`/solicitudes/${solicitudId}/personas/${personaId}/observar`, { comentario }), 'Persona observada.');
    else if (tipo === 'rechazar') await run(() => api.post(`/solicitudes/${solicitudId}/personas/${personaId}/rechazar`, { motivo: comentario }), 'Persona rechazada.');
    cerrarAccion();
  };

  const guardarVencimiento = () => run(() => api.post(`/solicitudes/${solicitud.id}/vencimiento`, { fechaVencimiento: venc || null }), venc ? 'Fecha de vigencia guardada. Se autorizó a quienes tienen la documentación completa.' : 'Fecha de vigencia quitada.');
  const terminarRevision = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ nroOrden: string | null; emailEnviado: boolean; to: string; motivo: string | null }>(`/solicitudes/${solicitud.id}/terminar-revision`);
      setConfirmarTerminar(false);
      setResultado(r);
      reload();
    } catch (e: any) { notify(e.message, 'error'); } finally { setBusy(false); }
  };

  const asignarLocal = (localId: number) => { if (localId) run(() => api.post(`/solicitudes/${solicitud.id}/local`, { localId }), 'Local asignado.').then(() => setCambiandoLocal(false)); };
  const crearYAsignarLocal = (nombre: string) => run(async () => {
    const nuevo = await api.post<{ id: number }>('/locales', { nombre });
    await api.post(`/solicitudes/${solicitud.id}/local`, { localId: nuevo.id });
  }, `Local "${nombre}" creado y asignado.`).then(() => setCambiandoLocal(false));
  const crearLocalLibre = () => {
    const nombre = nuevoLocal.trim();
    if (!nombre) { notify('Escribí el nombre del local.', 'error'); return; }
    crearYAsignarLocal(nombre).then(() => setNuevoLocal(''));
  };
  const definirTipo = (categoria: string) => { if (categoria) run(() => api.post(`/solicitudes/${solicitud.id}/tipo`, { categoria }), 'Tipo de contratista definido.'); };
  const abrirAgregarReq = (personaId: number, nombre: string) => { setReqPersona({ personaId, nombre }); setReqSel(''); setReqNombre(''); };
  const agregarRequisito = async () => {
    if (!reqPersona) return;
    const body: any = { personaId: reqPersona.personaId, solicitudId: solicitud.id };
    if (reqNombre.trim()) body.nombre = reqNombre.trim();
    else if (reqSel) body.tipoDocumentoId = Number(reqSel);
    else { notify('Elegí un requisito de la lista o escribí uno nuevo.', 'error'); return; }
    await run(() => api.post('/documentos/requisitos', body), 'Requisito agregado.');
    setReqPersona(null); setReqSel(''); setReqNombre('');
  };
  const quitarRequisito = (personaId: number, tipoDocumentoId: number, nombre: string) => {
    if (!confirm(`¿Quitar el requisito "${nombre}"?`)) return;
    run(() => api.del(`/documentos/requisitos/${personaId}/${tipoDocumentoId}`), 'Requisito quitado.');
  };
  const addComentario = () => { if (!nuevoComentario.trim()) return; run(() => api.post(`/solicitudes/${solicitud.id}/comentarios`, { contenido: nuevoComentario }), 'Comentario agregado.').then(() => setNuevoComentario('')); };
  const agregarPersona = async () => {
    if (!nuevaPersona.cuil || !nuevaPersona.nombre || !nuevaPersona.apellido) { notify('Completá CUIL, nombre y apellido.', 'error'); return; }
    await run(() => api.post(`/solicitudes/${solicitud.id}/personas`, { ...nuevaPersona, categoria: nuevaPersona.categoria || undefined }), 'Persona agregada.');
    setAgregar(false); setNuevaPersona({ cuil: '', nombre: '', apellido: '', categoria: '' });
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

  // Tarjeta de una persona (checklist + acciones). Se reutiliza en el modal de revisión.
  const PersonaCard = ({ p }: { p: any }) => (
    <div className="card" style={{ marginBottom: 14 }}>
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
            <button className="btn ghost sm" onClick={() => quitarPersona(p.solicitudId, p.personaId, `${p.apellido}, ${p.nombre}`)} title="Quitar de la solicitud">Quitar</button>
          </span>
        )}
      </div>
      <div className="card-body">
        <DocList docStatus={p.docStatus} personaId={p.personaId} onChanged={reload}
          onQuitarRequisito={isAdmin ? (tipoId, nombre) => quitarRequisito(p.personaId, tipoId, nombre) : undefined} />
        {isAdmin && (
          <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => abrirAgregarReq(p.personaId, `${p.apellido}, ${p.nombre}`)}>➕ Agregar requisito</button>
        )}
        {p.estado === 'RECHAZADA' && p.motivoRechazo && <div className="alert error" style={{ marginTop: 10 }}>Rechazada: {p.motivoRechazo}</div>}
        {isAdmin && (
          <>
            {p.docStatus.todosVerificados && !fechaVenc && (
              <div className="alert warn" style={{ marginTop: 10 }}>✅ Documentación completa. Cargá la <strong>"Vigencia hasta"</strong> (arriba) para autorizarla.</div>
            )}
            {p.docStatus.todosVerificados && fechaVenc && p.estado === 'AUTORIZADA' && (
              <div className="alert success" style={{ marginTop: 10 }}>🟢 Autorizada automáticamente. Puede ingresar hasta el <strong>{fmtSoloFecha(fechaVenc)}</strong>.</div>
            )}
            {!p.docStatus.todosVerificados && (
              <div className="alert warn" style={{ marginTop: 10 }}>Faltan aprobar {p.docStatus.totalObligatorios - p.docStatus.verificadosObligatorios} de {p.docStatus.totalObligatorios} documentos obligatorios.</div>
            )}
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button className="btn warning sm" onClick={() => setAccion({ tipo: 'observar', personaId: p.personaId, solicitudId: p.solicitudId, nombre: `${p.apellido}, ${p.nombre}` })}>Observar</button>
              <button className="btn danger sm" onClick={() => setAccion({ tipo: 'rechazar', personaId: p.personaId, solicitudId: p.solicitudId, nombre: `${p.apellido}, ${p.nombre}` })}>Rechazar</button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <a className="muted" onClick={() => nav('/solicitudes')} style={{ cursor: 'pointer' }}>← Solicitudes</a>
          <h1 style={{ marginTop: 6 }}>{sinLocal ? <span className="badge orange">Local sin asignar</span> : local.nombre}
            {isAdmin && !sinLocal && <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={() => setCambiandoLocal((v) => !v)} title="Cambiar el local de esta solicitud">✎ Cambiar local</button>}
          </h1>
          <div className="subtitle">
            {solicitud.nroOrden && <><span className="chip" title="Número de orden de la revisión">Orden {solicitud.nroOrden}</span>{' · '}</>}
            {personas.length} {personas.length === 1 ? 'persona' : 'personas'}
            {' · '}Tipo:{' '}
            {isAdmin && personas.length > 0
              ? <select value={tipoSolicitud === 'EMPRESA' || tipoSolicitud === 'MONOTRIBUTISTA' ? tipoSolicitud : ''} disabled={busy}
                  onChange={(e) => definirTipo(e.target.value)} title="Cambiar tipo de contratista (define la documentación exigida)"
                  style={{ padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 6 }}>
                  <option value="" disabled>{tipoSolicitud === 'MIXTO' ? 'Mixto — elegir…' : 'definir…'}</option>
                  <option value="EMPRESA">Empresa</option>
                  <option value="MONOTRIBUTISTA">Monotributista</option>
                </select>
              : <strong>{tipoLabel(tipoSolicitud)}</strong>}
            {' · '}<Badge estado={solicitud.estado} />
            {fechaVenc && <> {' · '}Vigencia hasta <strong>{fmtSoloFecha(fechaVenc)}</strong></>}
          </div>
        </div>
        <div className="btn-row">
          {isAdmin && <button className="btn" onClick={() => setAgregar(true)}>+ Agregar persona</button>}
          {isAdmin && personas.length > 0 && <button className="btn primary" onClick={() => setRevisando(true)}>🔍 Revisar documentación</button>}
        </div>
      </div>

      {isAdmin && (sinLocal || cambiandoLocal) && (
        <div className={`alert ${sinLocal ? 'warn' : 'info'}`} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {sinLocal
            ? <span>⚠️ El local del asunto no coincide con ninguno cargado{localSugerido && <> — el email dice: <strong>“{localSugerido}”</strong></>}. Asignalo para poder autorizar:</span>
            : <span>Cambiar el local de esta solicitud (hoy: <strong>{local.nombre}</strong>). Elegí uno cargado o escribí uno nuevo:</span>}
          {sinLocal && localSugerido && <button className="btn sm primary" disabled={busy} onClick={() => crearYAsignarLocal(localSugerido)}>➕ Crear “{localSugerido}” y asignar</button>}
          <select className="btn sm" onChange={(e) => asignarLocal(Number(e.target.value))} defaultValue="" disabled={busy}>
            <option value="" disabled>elegir uno existente…</option>
            {(locales ?? []).filter((l) => l.nombre !== '(Sin asignar)' && l.id !== local.id).map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
          </select>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input value={nuevoLocal} onChange={(e) => setNuevoLocal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') crearLocalLibre(); }} placeholder="o escribir un local nuevo…" style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 8 }} />
            <button className="btn sm" disabled={busy || !nuevoLocal.trim()} onClick={crearLocalLibre}>➕ Crear y asignar</button>
          </span>
          {!sinLocal && <button className="btn ghost sm" disabled={busy} onClick={() => { setCambiandoLocal(false); setNuevoLocal(''); }}>Cancelar</button>}
        </div>
      )}

      {/* Definir el tipo de contratista si el asunto/cuerpo no lo declaró (define la documentación exigida). */}
      {isAdmin && personas.length > 0 && (tipoSolicitud === null || tipoSolicitud === 'MIXTO') && (
        <div className="alert info" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>{tipoSolicitud === 'MIXTO' ? 'La solicitud tiene personas de distinto tipo.' : 'No se pudo determinar si es empresa o monotributista.'} Definí el tipo de contratista (fija qué documentación se exige):</span>
          <button className="btn sm" disabled={busy} onClick={() => definirTipo('EMPRESA')}>Empresa</button>
          <button className="btn sm" disabled={busy} onClick={() => definirTipo('MONOTRIBUTISTA')}>Monotributista</button>
        </div>
      )}

      {email?.aviso && personas.length === 0 && (
        <div className="alert warn">📄 {email.aviso}{isAdmin && ' Usá "+ Agregar persona" (los adjuntos del email se ven más abajo).'}</div>
      )}

      {/* Resumen de personas (la revisión completa se hace en el modal). */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12, marginBottom: 16, alignItems: 'start' }}>
        {personas.map((p: any) => (
          <div className="card" key={p.spId}>
            <div className="card-body" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div>
                <div><strong>{p.apellido}, {p.nombre}</strong> <span className="muted" style={{ fontSize: 12.5 }}>CUIL {p.cuilFormat}</span></div>
                <div style={{ marginTop: 4 }}>
                  <Badge estado={p.estado} />{' '}
                  <span className="muted" style={{ fontSize: 12.5 }}>{p.docStatus.verificadosObligatorios}/{p.docStatus.totalObligatorios} docs aprobados</span>
                  {p.vigencia === 'AUTORIZADO' && <span className="badge green" style={{ marginLeft: 6 }}>🟢 vigente</span>}
                </div>
              </div>
              <button className="btn ghost sm" onClick={() => nav(`/personas/${p.personaId}`)}>Ver ficha</button>
            </div>
          </div>
        ))}
      </div>

      {personas.length === 0 && (
        <div className="card"><div className="card-body empty">
          Esta solicitud todavía no tiene personas.
          {isAdmin && <> <button className="btn sm primary" style={{ marginLeft: 8 }} onClick={() => setAgregar(true)}>+ Agregar persona</button></>}
        </div></div>
      )}

      {/* Comentarios */}
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

      {/* ===== Modal de revisión: 2 columnas (izq. aprobar docs / der. PDFs) ===== */}
      {revisando && (
        <Modal full title={`Revisión — ${sinLocal ? 'Local sin asignar' : local.nombre}`} onClose={() => setRevisando(false)}
          footer={<>
            <button className="btn" onClick={() => setRevisando(false)}>Cerrar</button>
            {faltaTipo && <span className="muted" style={{ fontSize: 12.5, alignSelf: 'center' }}>⚠ Definí si es empresa o monotributista para poder terminar.</span>}
            <button className="btn primary" onClick={() => setConfirmarTerminar(true)} disabled={busy || faltaTipo} title={faltaTipo ? 'Falta definir el tipo de contratista (empresa/monotributista).' : undefined}>✅ Terminar revisión y avisar al remitente</button>
          </>}>
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Barra de vigencia (fecha única de la solicitud) */}
            <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', background: 'var(--panel-2)' }}>
              <label style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                🗓 Vigencia hasta:
                <input type="date" value={venc} onChange={(e) => setVenc(e.target.value)} style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 8 }} />
              </label>
              <button className="btn primary sm" onClick={guardarVencimiento} disabled={busy}>Guardar</button>
              <span className="muted" style={{ fontSize: 12.5 }}>Las personas con toda la documentación aprobada quedan <strong>autorizadas hasta esta fecha</strong>.</span>
            </div>
            {/* 2 columnas */}
            <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
              <div style={{ flex: '1 1 55%', overflow: 'auto', padding: 16, borderRight: '1px solid var(--border)' }}>
                <div className="muted" style={{ marginBottom: 10 }}>Aprobá cada requisito contra los PDF de la derecha. Al completar todos, la persona queda autorizada sola.</div>
                {personas.map((p: any) => <PersonaCard key={p.spId} p={p} />)}
              </div>
              <div style={{ flex: '1 1 45%', overflow: 'auto', padding: 16 }}>
                <div style={{ fontWeight: 650, marginBottom: 10 }}>📄 Documentación (PDF)</div>
                {solicitud.emailMessageId
                  ? <EmailInline emailId={solicitud.emailMessageId} wide />
                  : <p className="muted">Esta solicitud es manual (sin email). Cargá los documentos desde la ficha de cada persona.</p>}
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* Modales de acción por persona */}
      {accion?.tipo === 'observar' && (
        <Modal title={`Observar — ${accion.nombre}`} onClose={cerrarAccion}
          footer={<><button className="btn" onClick={cerrarAccion}>Cancelar</button><button className="btn warning" onClick={confirmarAccion} disabled={busy}>Confirmar</button></>}>
          <div className="field"><label>Observación</label><textarea rows={3} value={comentario} onChange={(e) => setComentario(e.target.value)} placeholder="Ej: Falta presentar el Formulario 931 actualizado." /></div>
        </Modal>
      )}
      {accion?.tipo === 'rechazar' && (
        <Modal title={`Rechazar — ${accion.nombre}`} onClose={cerrarAccion}
          footer={<><button className="btn" onClick={cerrarAccion}>Cancelar</button><button className="btn danger" onClick={confirmarAccion} disabled={busy || !comentario.trim()}>Confirmar rechazo</button></>}>
          <div className="alert warn">El motivo es obligatorio y quedará registrado en la auditoría.</div>
          <div className="field"><label>Motivo del rechazo *</label><textarea rows={3} value={comentario} onChange={(e) => setComentario(e.target.value)} /></div>
        </Modal>
      )}

      {/* Confirmación de "Terminar revisión" (reemplaza el alert del navegador) */}
      {confirmarTerminar && (
        <Modal title="Terminar revisión" onClose={() => setConfirmarTerminar(false)}
          footer={<>
            <button className="btn" onClick={() => setConfirmarTerminar(false)}>Cancelar</button>
            {!fechaVenc
              ? <button className="btn primary" onClick={() => { setConfirmarTerminar(false); setRevisando(true); }}>Cargar fecha de vencimiento</button>
              : <button className="btn primary" onClick={terminarRevision} disabled={busy}>Terminar y enviar email</button>}
          </>}>
          {!fechaVenc && (
            <div className="alert warn">⚠️ <strong>Falta cargar la fecha de vencimiento</strong> (hasta cuándo pueden ingresar). Es obligatoria: sin esa fecha nadie queda autorizado. Cargala en la ventana de revisión y volvé a terminar.</div>
          )}
          {fechaVenc && (
            <p>Se va a enviar un email al <strong>remitente del correo original</strong>{email?.remitente ? <> (<span className="muted">{email.remitente}</span>)</> : ''} con el resultado por persona: quién quedó autorizado (y hasta cuándo) y qué documentación falta.</p>
          )}
        </Modal>
      )}

      {/* Resultado del envío */}
      {resultado && (
        <Modal title="Revisión terminada" onClose={() => setResultado(null)}
          footer={<button className="btn primary" onClick={() => setResultado(null)}>Cerrar</button>}>
          {resultado.nroOrden && (
            <div className="alert info" style={{ fontSize: 15 }}>
              Número de orden: <strong>{resultado.nroOrden}</strong>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>Identifica esta revisión. Va en el asunto y en el cuerpo del email, y no cambia si reenviás.</div>
            </div>
          )}
          {resultado.emailEnviado
            ? <div className="alert success">✅ Email de resultado enviado a <strong>{resultado.to}</strong>.</div>
            : <div className="alert warn">No se envió el email: {resultado.motivo}<br /><span className="muted" style={{ fontSize: 12.5 }}>La revisión quedó guardada igual. Podés reenviar cuando el email esté configurado.</span></div>}
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
          <div className="form-row">
            <div className="field"><label>CUIL *</label><input value={nuevaPersona.cuil} onChange={(e) => setNuevaPersona({ ...nuevaPersona, cuil: e.target.value })} placeholder="20-30123456-7" /></div>
            <div className="field"><label>Tipo de contratista</label>
              <select value={nuevaPersona.categoria} onChange={(e) => setNuevaPersona({ ...nuevaPersona, categoria: e.target.value })}>
                <option value="">Sin cambios</option>
                <option value="EMPRESA">Empresa</option>
                <option value="MONOTRIBUTISTA">Monotributista</option>
              </select>
              <div className="hint">Define qué documentación se le exige.</div>
            </div>
          </div>
        </Modal>
      )}

      {reqPersona && (
        <Modal title={`Agregar requisito — ${reqPersona.nombre}`} onClose={() => setReqPersona(null)}
          footer={<><button className="btn" onClick={() => setReqPersona(null)}>Cancelar</button><button className="btn primary" onClick={agregarRequisito} disabled={busy}>Agregar</button></>}>
          <div className="alert info">Documentación extra que se le exige solo a esta persona (ej. trabajo en altura). Queda como obligatoria hasta aprobarla.</div>
          <div className="field">
            <label>Elegir de la lista</label>
            <select value={reqSel} onChange={(e) => { setReqSel(e.target.value); if (e.target.value) setReqNombre(''); }}>
              <option value="">— elegir —</option>
              {catalogoExtra.map((t: any) => <option key={t.id} value={t.id}>{t.nombre}</option>)}
            </select>
          </div>
          <div className="field">
            <label>o escribir uno nuevo</label>
            <input value={reqNombre} onChange={(e) => { setReqNombre(e.target.value); if (e.target.value) setReqSel(''); }} placeholder="Ej: Permiso de trabajo en caliente" />
          </div>
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
