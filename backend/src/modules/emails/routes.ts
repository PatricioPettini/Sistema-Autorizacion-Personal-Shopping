import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { eq, desc, inArray } from 'drizzle-orm';
import { simpleParser } from 'mailparser';
import { db, schema } from '../../db/client.js';
import { notFound } from '../../lib/errors.js';
import { contentDisposition } from '../../lib/files.js';
import { audit } from '../../lib/audit.js';
import { nowIso } from '../../lib/datetime.js';
import { processEmail } from '../processing/processor.js';

// Estados de email que quedan en el "respaldo" (no terminaron en una solicitud automática).
const ESTADOS_RESPALDO = ['NEEDS_REVIEW', 'ERROR'];

const MIME: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

// Cache del email parseado. Parsear un .eml (con sus adjuntos) es caro; el visor pide
// la lista y después cada PDF por separado, así que sin cache se re-parsea el mismo mail
// muchas veces seguidas. Guardamos los últimos por id+mtime, con TTL corto.
type ParsedEmail = Awaited<ReturnType<typeof simpleParser>>;
const parseCache = new Map<number, { mtimeMs: number; parsed: ParsedEmail; at: number }>();
const CACHE_MAX = 4;
const CACHE_TTL_MS = 3 * 60 * 1000;

async function parseEmail(emailId: number) {
  const email = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, emailId)).get();
  if (!email) throw notFound('Email no encontrado.');
  if (!email.rawStoredPath || !fs.existsSync(email.rawStoredPath)) throw notFound('El email no está disponible en el almacenamiento.');

  const mtimeMs = fs.statSync(email.rawStoredPath).mtimeMs;
  const hit = parseCache.get(emailId);
  if (hit && hit.mtimeMs === mtimeMs && Date.now() - hit.at < CACHE_TTL_MS) {
    hit.at = Date.now();
    return { email, parsed: hit.parsed };
  }

  const parsed = await simpleParser(fs.readFileSync(email.rawStoredPath));
  parseCache.set(emailId, { mtimeMs, parsed, at: Date.now() });
  // Evitar que el cache crezca: descartar el más viejo.
  if (parseCache.size > CACHE_MAX) {
    let oldestId = -1;
    let oldestAt = Infinity;
    for (const [id, v] of parseCache) if (v.at < oldestAt) { oldestAt = v.at; oldestId = id; }
    if (oldestId >= 0) parseCache.delete(oldestId);
  }
  return { email, parsed };
}

export async function emailsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.requireAuth);

  // Lista de adjuntos de un email (para el visor "Ver email").
  app.get('/:id/adjuntos', async (req) => {
    const id = Number((req.params as any).id);
    const { email, parsed } = await parseEmail(id);
    const adjuntos = (parsed.attachments ?? []).map((a, i) => ({
      index: i,
      filename: a.filename ?? `adjunto-${i + 1}`,
      contentType: a.contentType,
      size: (a.content as Buffer)?.length ?? 0,
    }));
    return {
      remitente: email.remitente,
      asunto: email.asunto,
      fecha: email.fechaEmail,
      cuerpo: parsed.text ?? '',
      adjuntos,
    };
  });

  // Sirve un adjunto puntual (inline) de forma protegida.
  app.get('/:id/adjuntos/:index', async (req, reply) => {
    const id = Number((req.params as any).id);
    const index = Number((req.params as any).index);
    const { parsed } = await parseEmail(id);
    const att = (parsed.attachments ?? [])[index];
    if (!att) throw notFound('Adjunto no encontrado.');
    const ext = (att.filename ?? '').split('.').pop()?.toLowerCase() ?? '';
    reply.header('Content-Type', att.contentType || MIME[ext] || 'application/octet-stream');
    reply.header('Content-Disposition', contentDisposition('inline', att.filename ?? 'adjunto'));
    return reply.send(att.content as Buffer);
  });

  const soloAdmin = { onRequest: app.requireAdmin };

  // Cantidad de correos en respaldo (para la campanita del encabezado).
  app.get('/respaldo/count', async () => {
    const rows = db.select({ id: schema.emailMessages.id }).from(schema.emailMessages)
      .where(inArray(schema.emailMessages.estado, ESTADOS_RESPALDO)).all();
    return { count: rows.length };
  });

  // Respaldo: correos que no terminaron en una solicitud automática (errores, sin planilla
  // legible, planillas excesivas, respuestas/reenvíos). Se revisan a mano.
  app.get('/respaldo', async () => {
    const rows = db.select({
      id: schema.emailMessages.id,
      remitente: schema.emailMessages.remitente,
      asunto: schema.emailMessages.asunto,
      fecha: schema.emailMessages.fechaEmail,
      fechaRecibido: schema.emailMessages.fechaRecibido,
      estado: schema.emailMessages.estado,
      motivo: schema.emailMessages.error,
      attachmentsCount: schema.emailMessages.attachmentsCount,
      replySolicitudId: schema.emailMessages.replySolicitudId,
    }).from(schema.emailMessages)
      .where(inArray(schema.emailMessages.estado, ESTADOS_RESPALDO))
      .orderBy(desc(schema.emailMessages.fechaRecibido)).all();

    // Enriquecer con la solicitud original vinculada (si la respuesta apunta a una).
    const solIds = [...new Set(rows.map((r) => r.replySolicitudId).filter((x): x is number => !!x))];
    const sols = solIds.length
      ? db.select({ id: schema.solicitudes.id, nroOrden: schema.solicitudes.nroOrden, local: schema.locales.nombre })
          .from(schema.solicitudes).innerJoin(schema.locales, eq(schema.solicitudes.localId, schema.locales.id))
          .where(inArray(schema.solicitudes.id, solIds)).all()
      : [];
    const solMap = new Map(sols.map((s) => [s.id, s]));
    return rows.map((r) => ({ ...r, solicitud: r.replySolicitudId ? solMap.get(r.replySolicitudId) ?? null : null }));
  });

  // Reprocesar un correo del respaldo forzando el alta de solicitud (ignora la detección de respuesta).
  app.post('/:id/procesar', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const email = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, id)).get();
    if (!email) throw notFound('Email no encontrado.');
    // Volver a un estado no-terminal para que processEmail lo tome.
    db.update(schema.emailMessages).set({ estado: 'RECEIVED', error: null, updatedAt: nowIso() }).where(eq(schema.emailMessages.id, id)).run();
    await processEmail(id, { force: true });
    audit({ userId: req.user!.id, accion: 'EMAIL_REPROCESADO', entidad: 'email', entidadId: id, ip: req.ip });
    const after = db.select({ estado: schema.emailMessages.estado, error: schema.emailMessages.error }).from(schema.emailMessages).where(eq(schema.emailMessages.id, id)).get();
    return { ok: true, estado: after?.estado, motivo: after?.error };
  });

  // Descartar un correo del respaldo (ya resuelto a mano). Sale de la bandeja.
  app.post('/:id/descartar', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const email = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, id)).get();
    if (!email) throw notFound('Email no encontrado.');
    db.update(schema.emailMessages).set({ estado: 'REVISADO', updatedAt: nowIso() }).where(eq(schema.emailMessages.id, id)).run();
    audit({ userId: req.user!.id, accion: 'EMAIL_RESPALDO_DESCARTADO', entidad: 'email', entidadId: id, ip: req.ip });
    return { ok: true };
  });

  // Registro de correos ENVIADOS por el sistema. Filtros: por solicitud, por texto libre
  // (asunto/destinatario/N° de orden) y por tipo. Incluye el N° de orden de la solicitud.
  app.get('/enviados', async (req) => {
    const q = req.query as any;
    const solicitudId = Number(q?.solicitudId) || null;
    const term = String(q?.q ?? '').trim().toLowerCase();
    const tipo = String(q?.tipo ?? '').trim();
    const base = db.select({
      id: schema.sentEmails.id,
      fecha: schema.sentEmails.createdAt,
      destinatario: schema.sentEmails.destinatario,
      asunto: schema.sentEmails.asunto,
      cuerpo: schema.sentEmails.cuerpo,
      tipo: schema.sentEmails.tipo,
      ok: schema.sentEmails.ok,
      error: schema.sentEmails.error,
      solicitudId: schema.sentEmails.solicitudId,
      nroOrden: schema.solicitudes.nroOrden,
    }).from(schema.sentEmails).leftJoin(schema.solicitudes, eq(schema.sentEmails.solicitudId, schema.solicitudes.id));
    let rows = solicitudId
      ? base.where(eq(schema.sentEmails.solicitudId, solicitudId)).orderBy(desc(schema.sentEmails.createdAt)).all()
      : base.orderBy(desc(schema.sentEmails.createdAt)).limit(500).all();
    if (tipo) rows = rows.filter((r) => r.tipo === tipo);
    if (term) rows = rows.filter((r) =>
      (r.nroOrden ?? '').toLowerCase().includes(term) ||
      (r.asunto ?? '').toLowerCase().includes(term) ||
      (r.destinatario ?? '').toLowerCase().includes(term));
    return rows;
  });
}
