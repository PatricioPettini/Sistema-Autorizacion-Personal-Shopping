import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { simpleParser } from 'mailparser';
import { db, schema } from '../../db/client.js';
import { notFound } from '../../lib/errors.js';

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
    reply.header('Content-Disposition', `inline; filename="${att.filename ?? 'adjunto'}"`);
    return reply.send(att.content as Buffer);
  });
}
