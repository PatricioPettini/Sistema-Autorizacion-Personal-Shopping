import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, sql, isNull, inArray } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { nowIso } from '../../lib/datetime.js';
import { formatCuil, findOrCreatePersona, normalizeCuil, splitNombreCompleto } from '../personas/service.js';
import { getPersonaDocStatus } from '../documentos/service.js';
import { getVigencia, recomputeAutorizacionPersona } from '../autorizaciones/service.js';
import { recomputeSolicitudEstado, aggEstado, agruparPorEmail } from './service.js';
import { findOrCreateLocal } from '../locales/service.js';
import { notifyObservacion, notifyRechazo, notifyResultadoRevision } from '../notifications/service.js';

const TIPOS = ['EMPRESA', 'MONOTRIBUTISTA'] as const;

// Una persona se puede cargar como nombre + apellido, o como un solo "nombre completo".
const personaInput = z
  .object({
    cuil: z.string().min(1, 'Ingresá el CUIL.'),
    nombre: z.string().optional(),
    apellido: z.string().optional(),
    nombreCompleto: z.string().optional(),
    categoria: z.enum(TIPOS).optional(),
  })
  .refine((p) => !!(p.nombreCompleto?.trim() || p.nombre?.trim()), { message: 'Ingresá el nombre de la persona.' })
  .refine((p) => normalizeCuil(p.cuil).length >= 10, { message: 'CUIL inválido (11 dígitos).' });

const manualSchema = z
  .object({
    // El local se elige de los cargados (localId) o se escribe uno nuevo (localNombre),
    // que se crea en el momento. Igual que hace el lector de emails con el asunto.
    localId: z.number().int().optional(),
    localNombre: z.string().optional(),
    // Puede venir vacío: la solicitud se crea y las personas se cargan después.
    personas: z.array(personaInput).default([]),
    // Tipo de contratista para todo el grupo (define qué documentación se exige).
    categoria: z.enum(TIPOS).optional(),
  })
  .refine((d) => d.localId != null || !!d.localNombre?.trim(), { message: 'Elegí o escribí un local.' });

type PersonaInputParsed = z.infer<typeof personaInput>;

/** Normaliza una persona de entrada a { cuil, nombre, apellido, categoria }. */
function normalizarPersona(p: PersonaInputParsed, categoriaGrupo?: string) {
  const cuil = normalizeCuil(p.cuil);
  let nombre = (p.nombre ?? '').trim();
  let apellido = (p.apellido ?? '').trim();
  if (!nombre || !apellido) {
    // Vino un solo campo (o un "nombre completo"): se parte en nombre + apellido.
    const nc = splitNombreCompleto(p.nombreCompleto?.trim() || `${nombre} ${apellido}`.trim());
    nombre = nc.nombre;
    apellido = nc.apellido;
  }
  return { cuil, nombre, apellido, categoria: p.categoria ?? categoriaGrupo };
}

/** Alta/asociación de una persona en una solicitud. Devuelve el id y si es nueva. */
function agregarPersonaASolicitud(solicitudId: number, p: ReturnType<typeof normalizarPersona>) {
  const { persona, created } = findOrCreatePersona({ cuil: p.cuil, nombre: p.nombre, apellido: p.apellido });
  if (p.categoria && persona.categoria !== p.categoria) {
    db.update(schema.personas).set({ categoria: p.categoria, updatedAt: nowIso() }).where(eq(schema.personas.id, persona.id)).run();
  }
  db.insert(schema.solicitudPersonas).values({ solicitudId, personaId: persona.id }).onConflictDoNothing().run();
  return { persona, created };
}

export async function solicitudesRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.requireAuth);
  const soloAdmin = { onRequest: app.requireAdmin };

  // Listado agrupado POR EMAIL: una fila por email (varias personas adentro).
  // Las solicitudes creadas a mano (sin email) se muestran individualmente.
  app.get('/', async (req) => {
    const q = req.query as any;
    const conds = [] as any[];
    if (q.localId) conds.push(eq(schema.solicitudes.localId, Number(q.localId)));

    const rows = db
      .select({
        id: schema.solicitudes.id,
        estado: schema.solicitudes.estado,
        updatedAt: schema.solicitudes.updatedAt,
        localId: schema.locales.id,
        local: schema.locales.nombre,
        emailMessageId: schema.solicitudes.emailMessageId,
        emailAsunto: schema.emailMessages.asunto,
        fecha: sql<string>`coalesce(${schema.emailMessages.fechaEmail}, ${schema.emailMessages.fechaRecibido}, ${schema.solicitudes.createdAt})`,
        personasCount: sql<number>`count(${schema.solicitudPersonas.id})`,
        personasLabel: sql<string>`group_concat(${schema.personas.apellido} || ', ' || ${schema.personas.nombre}, ' · ')`,
        cuils: sql<string>`group_concat(${schema.personas.cuil}, ',')`,
        categorias: sql<string>`group_concat(distinct ${schema.personas.categoria})`,
      })
      .from(schema.solicitudes)
      .innerJoin(schema.locales, eq(schema.solicitudes.localId, schema.locales.id))
      .leftJoin(schema.emailMessages, eq(schema.solicitudes.emailMessageId, schema.emailMessages.id))
      .leftJoin(schema.solicitudPersonas, eq(schema.solicitudPersonas.solicitudId, schema.solicitudes.id))
      .leftJoin(schema.personas, eq(schema.personas.id, schema.solicitudPersonas.personaId))
      .where(conds.length ? and(...conds) : undefined)
      .groupBy(schema.solicitudes.id)
      .orderBy(desc(schema.solicitudes.updatedAt))
      .limit(500)
      .all();

    // Agrupar por email (o por solicitud si es manual/sin email).
    let list = agruparPorEmail(rows as any);

    if (q.estado) list = list.filter((x) => x.estado === String(q.estado));
    // Filtro por fecha de envío (día). Se compara la parte YYYY-MM-DD de la fecha del email.
    if (q.desde) list = list.filter((x) => (x.fecha ?? '').slice(0, 10) >= String(q.desde));
    if (q.hasta) list = list.filter((x) => (x.fecha ?? '').slice(0, 10) <= String(q.hasta));
    const term = String(q.q ?? '').trim().toLowerCase();
    const termDigits = term.replace(/\D/g, '');
    if (term) list = list.filter((x) => x.personasLabel.toLowerCase().includes(term) || (!!termDigits && x.cuils.includes(termDigits)));
    return list.map(({ cuils, ...x }) => x);
  });

  // Detalle: agrupa TODAS las personas del mismo email (varias solicitudes del mismo correo
  // se ven como una sola). Cada persona conserva su solicitudId para las acciones.
  app.get('/:id', async (req) => {
    const id = Number((req.params as any).id);
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');

    // Hermanas: mismas solicitudes del mismo email; si es manual, solo ésta.
    const hermanas = sol.emailMessageId != null
      ? db.select().from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, sol.emailMessageId)).all()
      : [sol];
    const solIds = hermanas.map((s) => s.id);
    const localIdPorSol = new Map(hermanas.map((s) => [s.id, s.localId] as const));

    // Local a mostrar: preferir uno real por sobre "(Sin asignar)".
    const localesGrupo = db.select().from(schema.locales).where(inArray(schema.locales.id, [...new Set(hermanas.map((s) => s.localId))])).all();
    const local = localesGrupo.find((l) => l.nombre !== '(Sin asignar)') ?? localesGrupo[0]
      ?? db.select().from(schema.locales).where(eq(schema.locales.id, sol.localId)).get()!;

    const email = sol.emailMessageId
      ? db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, sol.emailMessageId)).get()
      : null;

    const comentarios = db
      .select({
        id: schema.comentarios.id,
        contenido: schema.comentarios.contenido,
        createdAt: schema.comentarios.createdAt,
        userNombre: schema.users.nombre,
      })
      .from(schema.comentarios)
      .leftJoin(schema.users, eq(schema.comentarios.userId, schema.users.id))
      .where(inArray(schema.comentarios.solicitudId, solIds))
      .orderBy(schema.comentarios.createdAt)
      .all();

    const sps = db
      .select({
        spId: schema.solicitudPersonas.id,
        solicitudId: schema.solicitudPersonas.solicitudId,
        estado: schema.solicitudPersonas.estado,
        motivoRechazo: schema.solicitudPersonas.motivoRechazo,
        personaId: schema.personas.id,
        cuil: schema.personas.cuil,
        nombre: schema.personas.nombre,
        apellido: schema.personas.apellido,
      })
      .from(schema.solicitudPersonas)
      .innerJoin(schema.personas, eq(schema.solicitudPersonas.personaId, schema.personas.id))
      .where(inArray(schema.solicitudPersonas.solicitudId, solIds))
      .orderBy(schema.personas.apellido)
      .all();

    const personas = sps.map((p) => {
      const localId = localIdPorSol.get(p.solicitudId) ?? sol.localId;
      const docStatus = getPersonaDocStatus(p.personaId);
      const vig = getVigencia(p.personaId, localId);
      const ingresoAbierto = db
        .select()
        .from(schema.entradas)
        .where(and(eq(schema.entradas.personaId, p.personaId), isNull(schema.entradas.fechaHoraSalida)))
        .get() ?? null;
      return {
        spId: p.spId,
        solicitudId: p.solicitudId,
        personaId: p.personaId,
        cuil: p.cuil,
        cuilFormat: p.cuil ? formatCuil(p.cuil) : '—',
        nombre: p.nombre,
        apellido: p.apellido,
        estado: p.estado,
        motivoRechazo: p.motivoRechazo,
        docStatus,
        vigencia: vig.estado,
        autorizacionVigente: vig.autorizacion,
        ingresoAbierto,
      };
    });

    return {
      solicitud: { ...sol, localId: local.id, estado: aggEstado(personas.map((p) => p.estado)) },
      local,
      email: email ? { id: email.id, remitente: email.remitente, asunto: email.asunto, fecha: email.fechaEmail, adjuntos: email.attachmentsCount, aviso: email.estado === 'PROCESSED' ? email.error : null } : null,
      comentarios,
      personas,
    };
  });

  // Crear solicitud a mano: un local + una o más personas (por CUIL).
  app.post('/manual', soloAdmin, async (req) => {
    const data = manualSchema.parse(req.body);

    // Local existente por id, o uno nuevo a partir del nombre escrito.
    let local: typeof schema.locales.$inferSelect | undefined;
    let localCreado = false;
    if (data.localId != null) {
      local = db.select().from(schema.locales).where(eq(schema.locales.id, data.localId)).get();
      if (!local) throw badRequest('Local inexistente.');
    } else {
      const r = findOrCreateLocal(data.localNombre!, { origen: 'manual', userId: req.user!.id, ip: req.ip });
      if (!r) throw badRequest('Nombre de local inválido.');
      local = r.local;
      localCreado = r.created;
    }

    // CUILs repetidos dentro del mismo formulario: se cargan una sola vez.
    const vistos = new Set<string>();
    const personas = data.personas
      .map((p) => normalizarPersona(p, data.categoria))
      .filter((p) => (vistos.has(p.cuil) ? false : (vistos.add(p.cuil), true)));

    const sol = db.insert(schema.solicitudes).values({ localId: local.id, estado: 'PENDIENTE', createdByUserId: req.user!.id }).returning().get();
    for (const p of personas) {
      const { persona, created } = agregarPersonaASolicitud(sol.id, p);
      if (created) audit({ userId: req.user!.id, accion: 'PERSONA_CREADA', entidad: 'persona', entidadId: persona.id, ip: req.ip });
    }
    recomputeSolicitudEstado(sol.id);
    audit({ userId: req.user!.id, accion: 'SOLICITUD_CREADA_MANUAL', entidad: 'solicitud', entidadId: sol.id, detalle: { personas: personas.length, categoria: data.categoria, localId: local.id, localCreado }, ip: req.ip });
    return { solicitudId: sol.id, personas: personas.length, local: { id: local.id, nombre: local.nombre, creado: localCreado } };
  });

  // Agregar una persona a una solicitud existente.
  app.post('/:id/personas', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const p = normalizarPersona(personaInput.parse(req.body));
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');
    const yaEsta = db
      .select()
      .from(schema.solicitudPersonas)
      .innerJoin(schema.personas, eq(schema.solicitudPersonas.personaId, schema.personas.id))
      .where(and(eq(schema.solicitudPersonas.solicitudId, id), eq(schema.personas.cuil, p.cuil)))
      .get();
    if (yaEsta) throw badRequest('Esa persona ya está en la solicitud.');
    const { persona, created } = agregarPersonaASolicitud(id, p);
    if (created) audit({ userId: req.user!.id, accion: 'PERSONA_CREADA', entidad: 'persona', entidadId: persona.id, ip: req.ip });
    recomputeSolicitudEstado(id);
    audit({ userId: req.user!.id, accion: 'SOLICITUD_PERSONA_AGREGADA', entidad: 'solicitud', entidadId: id, detalle: { personaId: persona.id }, ip: req.ip });
    return { personaId: persona.id };
  });

  // Quitar una persona de la solicitud (no borra a la persona ni su documentación).
  app.delete('/:id/personas/:personaId', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const personaId = Number((req.params as any).personaId);
    db.delete(schema.solicitudPersonas)
      .where(and(eq(schema.solicitudPersonas.solicitudId, id), eq(schema.solicitudPersonas.personaId, personaId)))
      .run();
    recomputeSolicitudEstado(id);
    audit({ userId: req.user!.id, accion: 'SOLICITUD_PERSONA_QUITADA', entidad: 'solicitud', entidadId: id, detalle: { personaId }, ip: req.ip });
    return { ok: true };
  });

  // Agregar comentario a la solicitud (a nivel solicitud, común a todas las personas).
  app.post('/:id/comentarios', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const contenido = String((req.body as any)?.contenido ?? '').trim();
    if (!contenido) throw badRequest('El comentario no puede estar vacío.');
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');
    db.insert(schema.comentarios).values({ solicitudId: id, userId: req.user!.id, contenido }).run();
    audit({ userId: req.user!.id, accion: 'COMENTARIO_AGREGADO', entidad: 'solicitud', entidadId: id, ip: req.ip });
    return { ok: true };
  });

  // Reasignar el local de una solicitud (ej. cuando quedó "Sin asignar").
  app.post('/:id/local', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const localId = Number((req.body as any)?.localId);
    if (!localId) throw badRequest('Falta el local.');
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');
    const local = db.select().from(schema.locales).where(eq(schema.locales.id, localId)).get();
    if (!local) throw badRequest('Local inexistente.');
    db.update(schema.solicitudes).set({ localId, updatedAt: nowIso() }).where(eq(schema.solicitudes.id, id)).run();
    audit({ userId: req.user!.id, accion: 'SOLICITUD_LOCAL_ASIGNADO', entidad: 'solicitud', entidadId: id, detalle: { localId }, ip: req.ip });
    return { ok: true };
  });

  // Fijar la fecha de vencimiento ÚNICA de la solicitud (se aplica a todo el grupo del email).
  // Al cargarla, se autoriza automáticamente a quienes ya tienen la documentación completa.
  app.post('/:id/vencimiento', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const raw = String((req.body as any)?.fechaVencimiento ?? '').trim();
    const fechaVencimiento = raw || null;
    if (fechaVencimiento && !/^\d{4}-\d{2}-\d{2}$/.test(fechaVencimiento)) throw badRequest('Fecha inválida (YYYY-MM-DD).');
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');
    const hermanas = sol.emailMessageId != null
      ? db.select().from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, sol.emailMessageId)).all()
      : [sol];
    for (const h of hermanas) {
      db.update(schema.solicitudes).set({ fechaVencimiento, updatedAt: nowIso() }).where(eq(schema.solicitudes.id, h.id)).run();
      const sps = db.select({ personaId: schema.solicitudPersonas.personaId }).from(schema.solicitudPersonas).where(eq(schema.solicitudPersonas.solicitudId, h.id)).all();
      for (const sp of sps) recomputeAutorizacionPersona(h.id, sp.personaId, req.user!.id);
    }
    audit({ userId: req.user!.id, accion: 'SOLICITUD_VENCIMIENTO', entidad: 'solicitud', entidadId: id, detalle: { fechaVencimiento }, ip: req.ip });
    return { ok: true, fechaVencimiento };
  });

  // Terminar la revisión: manda un email al remitente con el resultado por persona.
  app.post('/:id/terminar-revision', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');
    const res = await notifyResultadoRevision(id);
    audit({ userId: req.user!.id, accion: 'REVISION_TERMINADA', entidad: 'solicitud', entidadId: id, detalle: { emailEnviado: res.enviado, to: res.to }, ip: req.ip });
    return {
      ok: true,
      emailEnviado: res.enviado,
      to: res.to,
      motivo: res.enviado ? null : (res.to ? 'No se pudo enviar el email (revisá la configuración de SMTP).' : 'El correo original no tiene un remitente para responderle.'),
    };
  });

  // Observar a una persona (documentación faltante / inconsistencia).
  app.post('/:id/personas/:personaId/observar', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const personaId = Number((req.params as any).personaId);
    const comentario = String((req.body as any)?.comentario ?? '').trim();
    const sp = setEstadoPersona(id, personaId, 'OBSERVADA', req.user!.id, req.ip);
    if (comentario) db.insert(schema.comentarios).values({ solicitudId: id, userId: req.user!.id, contenido: comentario }).run();
    recomputeSolicitudEstado(id);
    notifyObservacion(id, personaId, comentario).catch(() => {});
    return { ok: true, estado: sp.estado };
  });

  // Rechazar a una persona — motivo obligatorio.
  app.post('/:id/personas/:personaId/rechazar', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const personaId = Number((req.params as any).personaId);
    const motivo = String((req.body as any)?.motivo ?? '').trim();
    if (!motivo) throw badRequest('El motivo de rechazo es obligatorio.');
    const sp = db
      .select()
      .from(schema.solicitudPersonas)
      .where(and(eq(schema.solicitudPersonas.solicitudId, id), eq(schema.solicitudPersonas.personaId, personaId)))
      .get();
    if (!sp) throw notFound('La persona no pertenece a esta solicitud.');
    db.update(schema.solicitudPersonas).set({ estado: 'RECHAZADA', motivoRechazo: motivo, updatedAt: nowIso() }).where(eq(schema.solicitudPersonas.id, sp.id)).run();
    db.insert(schema.comentarios).values({ solicitudId: id, userId: req.user!.id, contenido: `RECHAZO: ${motivo}` }).run();
    recomputeSolicitudEstado(id);
    audit({ userId: req.user!.id, accion: 'RECHAZO_REALIZADO', entidad: 'solicitud', entidadId: id, detalle: { personaId, motivo }, ip: req.ip });
    notifyRechazo(id, personaId, motivo).catch(() => {});
    return { ok: true };
  });
}

function setEstadoPersona(solicitudId: number, personaId: number, estado: string, userId: number, ip: string) {
  const sp = db
    .select()
    .from(schema.solicitudPersonas)
    .where(and(eq(schema.solicitudPersonas.solicitudId, solicitudId), eq(schema.solicitudPersonas.personaId, personaId)))
    .get();
  if (!sp) throw notFound('La persona no pertenece a esta solicitud.');
  db.update(schema.solicitudPersonas).set({ estado, updatedAt: nowIso() }).where(eq(schema.solicitudPersonas.id, sp.id)).run();
  audit({ userId, accion: 'ESTADO_MODIFICADO', entidad: 'solicitud', entidadId: solicitudId, detalle: { personaId, estado }, ip });
  return { ...sp, estado };
}
