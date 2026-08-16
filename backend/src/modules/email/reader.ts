import fs from 'node:fs';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../lib/audit.js';
import { nowIso } from '../../lib/datetime.js';
import { getEmailConfig, type EmailConfig } from '../config/service.js';
import { processEmail } from '../processing/processor.js';

interface PollResult {
  ok: boolean;
  nuevos: number;
  procesados: number;
  error?: string;
}

let running = false;
let lastSyncAt: string | null = null;
let lastResult: PollResult | null = null;

export function getSchedulerStatus() {
  const c = getEmailConfig();
  return {
    configurado: !!c.imapHost,
    pollMinutes: c.pollMinutes,
    running,
    lastSyncAt,
    lastResult,
  };
}

function buildClient(c = getEmailConfig()) {
  if (!c.imapHost) return null;
  return new ImapFlow({
    host: c.imapHost,
    port: c.imapPort,
    secure: c.imapSecure,
    auth: { user: c.imapUser, pass: c.imapPassword },
    logger: false,
  });
}

export async function verifyImap(cfg?: EmailConfig): Promise<{ ok: boolean; error?: string }> {
  const client = buildClient(cfg);
  if (!client) return { ok: false, error: 'Falta completar el servidor IMAP.' };
  try {
    await client.connect();
    await client.logout();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'No se pudo conectar.' };
  }
}

function safeMessageFile(messageId: string): string {
  const safe = messageId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return `${Date.now()}_${safe || 'msg'}.eml`;
}

/** Revisa el buzón una vez: descarga emails nuevos, los guarda y los procesa. */
export async function pollNow(): Promise<PollResult> {
  if (running) return lastResult ?? { ok: false, nuevos: 0, procesados: 0, error: 'Ya hay una revisión en curso.' };
  const client = buildClient();
  if (!client) {
    const r = { ok: false, nuevos: 0, procesados: 0, error: 'IMAP no configurado.' };
    lastResult = r;
    return r;
  }

  running = true;
  let nuevos = 0;
  let procesados = 0;
  const c = getEmailConfig();
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const nuevosUids: number[] = [];
      // Recorrer envelopes para detectar mensajes no vistos por Message-ID.
      for await (const msg of client.fetch('1:*', { uid: true, envelope: true })) {
        const mid = msg.envelope?.messageId;
        if (!mid) continue;
        const exists = db.select({ id: schema.emailMessages.id }).from(schema.emailMessages).where(eq(schema.emailMessages.messageId, mid)).get();
        if (!exists) nuevosUids.push(msg.uid);
      }

      for (const uid of nuevosUids) {
        const full = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
        if (!full || !full.source) continue;
        const env2 = full.envelope;
        const mid = env2?.messageId ?? `no-id-${uid}-${Date.now()}`;

        // Guardar el email crudo en disco (idempotencia y auditoría).
        fs.mkdirSync(env.emailsPath, { recursive: true });
        const rawPath = path.join(env.emailsPath, safeMessageFile(mid));
        fs.writeFileSync(rawPath, full.source);

        const remitente = env2?.from?.[0] ? `${env2.from[0].name ?? ''} <${env2.from[0].address ?? ''}>`.trim() : null;
        const row = db
          .insert(schema.emailMessages)
          .values({
            messageId: mid,
            remitente,
            asunto: env2?.subject ?? null,
            fechaEmail: env2?.date ? new Date(env2.date).toISOString() : null,
            estado: 'RECEIVED',
            rawStoredPath: rawPath,
          })
          .returning()
          .get();
        nuevos++;
        audit({ accion: 'EMAIL_RECIBIDO', entidad: 'email', entidadId: row.id, detalle: { remitente, asunto: env2?.subject } });

        // Job + procesamiento
        db.insert(schema.processingJobs).values({ tipo: 'PROCESS_EMAIL', emailMessageId: row.id, estado: 'PROCESSING', startedAt: nowIso() }).run();
        await processEmail(row.id);
        procesados++;

        // Mover a carpeta de procesados si está configurado (nunca borrar).
        if (c.processedFolder) {
          try {
            await client.messageMove(String(uid), c.processedFolder, { uid: true });
          } catch (err) {
            logger.warn({ err }, `No se pudo mover el email a ${c.processedFolder}`);
          }
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
    lastSyncAt = nowIso();
    lastResult = { ok: true, nuevos, procesados };
    logger.info(`Revisión de email: ${nuevos} nuevos, ${procesados} procesados.`);
    return lastResult;
  } catch (err: any) {
    logger.error({ err }, 'Fallo al revisar el buzón IMAP.');
    lastSyncAt = nowIso();
    lastResult = { ok: false, nuevos, procesados, error: err?.message ?? 'Error de conexión.' };
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
    return lastResult;
  } finally {
    running = false;
  }
}
