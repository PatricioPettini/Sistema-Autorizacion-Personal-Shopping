import type { FastifyInstance } from 'fastify';
import { desc, eq, and, gte, lte, sql } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';

export async function auditRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.requireAdmin);

  app.get('/', async (req) => {
    const q = req.query as any;
    const conds = [] as any[];
    if (q.entidad) conds.push(eq(schema.auditLog.entidad, String(q.entidad)));
    if (q.accion) conds.push(eq(schema.auditLog.accion, String(q.accion)));
    if (q.desde) conds.push(gte(schema.auditLog.createdAt, `${String(q.desde)}T00:00:00.000Z`));
    if (q.hasta) conds.push(lte(schema.auditLog.createdAt, `${String(q.hasta)}T23:59:59.999Z`));
    const where = conds.length ? and(...conds) : undefined;

    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(10, Number(q.pageSize) || 50));
    const total = db.select({ n: sql<number>`count(*)` }).from(schema.auditLog).where(where).get()?.n ?? 0;

    const rows = db
      .select({
        id: schema.auditLog.id,
        accion: schema.auditLog.accion,
        entidad: schema.auditLog.entidad,
        entidadId: schema.auditLog.entidadId,
        detalleJson: schema.auditLog.detalleJson,
        ip: schema.auditLog.ip,
        createdAt: schema.auditLog.createdAt,
        userNombre: schema.users.nombre,
      })
      .from(schema.auditLog)
      .leftJoin(schema.users, eq(schema.auditLog.userId, schema.users.id))
      .where(where)
      .orderBy(desc(schema.auditLog.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all();

    // --- Diccionarios (tablas chicas) para resolver nombres sin N+1 pesado ---
    const personas = new Map(db.select({ id: schema.personas.id, nombre: schema.personas.nombre, apellido: schema.personas.apellido }).from(schema.personas).all().map((p) => [p.id, `${p.apellido}, ${p.nombre}`]));
    const locales = new Map(db.select({ id: schema.locales.id, nombre: schema.locales.nombre }).from(schema.locales).all().map((l) => [l.id, l.nombre]));
    const tipos = new Map(db.select({ id: schema.documentTypes.id, nombre: schema.documentTypes.nombre }).from(schema.documentTypes).all().map((t) => [t.id, t.nombre]));
    const usuarios = new Map(db.select({ id: schema.users.id, nombre: schema.users.nombre }).from(schema.users).all().map((u) => [u.id, u.nombre]));
    const documentos = new Map(db.select({ id: schema.documentos.id, personaId: schema.documentos.personaId }).from(schema.documentos).all().map((d) => [d.id, d.personaId]));
    const autorizaciones = new Map(db.select().from(schema.autorizaciones).all().map((a) => [a.id, a]));
    const entradas = new Map(db.select().from(schema.entradas).all().map((e) => [e.id, e]));
    const solicitudes = new Map(db.select({ id: schema.solicitudes.id, localId: schema.solicitudes.localId }).from(schema.solicitudes).all().map((s) => [s.id, s.localId]));
    const emails = new Map(db.select({ id: schema.emailMessages.id, asunto: schema.emailMessages.asunto }).from(schema.emailMessages).all().map((e) => [e.id, e.asunto]));

    const P = (id: any) => personas.get(Number(id)) ?? `persona #${id}`;
    const L = (id: any) => locales.get(Number(id)) ?? `local #${id}`;
    const T = (id: any) => tipos.get(Number(id)) ?? `documento #${id}`;
    const U = (id: any) => usuarios.get(Number(id)) ?? `usuario #${id}`;
    const localDeSolicitud = (id: any) => L(solicitudes.get(Number(id)));

    const describir = (r: (typeof rows)[number]): string => {
      let d: any = {};
      try { d = r.detalleJson ? JSON.parse(r.detalleJson) : {}; } catch { /* ignore */ }
      const eid = r.entidadId;
      switch (r.accion) {
        case 'LOGIN': return 'Inició sesión';
        case 'LOGOUT': return 'Cerró sesión';
        case 'SETUP_ADMIN_CREADO': return 'Creó el usuario administrador inicial';
        case 'PERSONA_CREADA': return `Creó la persona ${P(eid)}${d.origen === 'email' ? ' (desde un email)' : ''}`;
        case 'PERSONA_MODIFICADA': return `Modificó los datos de ${P(eid)}`;
        case 'SOLICITUD_CREADA': return `Creó una solicitud para ${localDeSolicitud(eid)}${d.personas ? ` (${d.personas} personas)` : ''}`;
        case 'SOLICITUD_CREADA_MANUAL': return `Creó una solicitud (manual) para ${localDeSolicitud(eid)}`;
        case 'SOLICITUD_PERSONA_AGREGADA': return `Agregó a ${P(d.personaId)} a la solicitud de ${localDeSolicitud(eid)}`;
        case 'SOLICITUD_PERSONA_QUITADA': return `Quitó a ${P(d.personaId)} de la solicitud de ${localDeSolicitud(eid)}`;
        case 'SOLICITUD_LOCAL_ASIGNADO': return `Asignó el local ${L(d.localId)} a una solicitud`;
        case 'ESTADO_MODIFICADO': return `Cambió a "${d.estado}" el estado de ${P(d.personaId)}`;
        case 'RECHAZO_REALIZADO': return `Rechazó a ${P(d.personaId)}${d.motivo ? ` — ${d.motivo}` : ''}`;
        case 'COMENTARIO_AGREGADO': return `Agregó un comentario a la solicitud de ${localDeSolicitud(eid)}`;
        case 'DOCUMENTO_VERIFICADO': {
          const persona = P(documentos.get(Number(eid)));
          const verbo = d.estado === 'VERIFICADO' ? 'Aprobó' : d.estado === 'RECHAZADO' ? 'Rechazó' : 'Reabrió';
          return `${verbo} ${T(d.tipoDocumentoId)} de ${persona}`;
        }
        case 'DOCUMENTO_CARGADO': return `Cargó un documento de ${P(documentos.get(Number(eid)))}`;
        case 'DOCUMENTO_ACTUALIZADO': return `Actualizó un documento de ${P(documentos.get(Number(eid)))}`;
        case 'DOCUMENTO_RECLASIFICADO': return `Reclasificó un documento de ${P(documentos.get(Number(eid)))} como ${T(d.nuevoTipoId)}`;
        case 'DOCUMENTO_REASIGNADO': return `Reasignó un documento a ${P(d.nuevaPersonaId)}`;
        case 'DOCUMENTO_DESCARGADO': return `Descargó un documento de ${P(documentos.get(Number(eid)))}`;
        case 'AUTORIZACION_REALIZADA': {
          const a = autorizaciones.get(Number(eid));
          if (!a) return `Autorizó a ${P(d.personaId)}`;
          const rango = a.fechaHasta && a.fechaHasta !== a.fecha ? `${a.fecha} a ${a.fechaHasta}` : a.fecha;
          return `Autorizó a ${P(a.personaId)} en ${L(a.localId)} (${rango}, ${a.horaDesde}–${a.horaHasta})`;
        }
        case 'AUTORIZACION_REVOCADA': {
          const a = autorizaciones.get(Number(eid));
          return `Revocó la autorización de ${a ? P(a.personaId) : `#${eid}`}${d.motivo ? ` — ${d.motivo}` : ''}`;
        }
        case 'INGRESO_REGISTRADO': {
          const e = entradas.get(Number(eid));
          return e ? `Registró el ingreso de ${P(e.personaId)} a ${L(e.localId)}` : `Registró un ingreso`;
        }
        case 'SALIDA_REGISTRADA': {
          const e = entradas.get(Number(eid));
          return e ? `Registró la salida de ${P(e.personaId)} de ${L(e.localId)}` : `Registró una salida`;
        }
        case 'EMAIL_RECIBIDO': return `Recibió un email: "${emails.get(Number(eid)) ?? d.asunto ?? '(sin asunto)'}"`;
        case 'EMAIL_PROCESADO': return `Procesó un email: "${emails.get(Number(eid)) ?? '(sin asunto)'}"${d.personas != null ? ` (${d.personas} personas)` : ''}`;
        case 'EMAIL_SIN_EXCEL': return `Email sin Excel de personas: "${emails.get(Number(eid)) ?? '(sin asunto)'}"`;
        case 'EMAIL_ENVIADO': return `Envió un email automático${d.tipo ? ` (${String(d.tipo).toLowerCase()})` : ''}`;
        case 'USUARIO_CREADO': return `Creó el usuario ${U(eid)}`;
        case 'USUARIO_MODIFICADO': return `Modificó el usuario ${U(eid)}`;
        case 'LOCAL_CREADO': return `Creó el local ${L(eid)}`;
        case 'LOCAL_MODIFICADO': return `Modificó el local ${L(eid)}`;
        case 'TIPO_DOC_CREADO': return `Creó el tipo de documento ${T(eid)}`;
        case 'TIPO_DOC_MODIFICADO': return `Modificó el tipo de documento ${T(eid)}`;
        case 'CONFIGURACION_MODIFICADA': return 'Modificó la configuración de email';
        case 'EMAIL_REVISION_MANUAL': return 'Revisó el buzón de emails manualmente';
        default: return r.detalleJson ?? '';
      }
    };

    return { rows: rows.map((r) => ({ ...r, descripcion: describir(r) })), total, page, pageSize };
  });
}
