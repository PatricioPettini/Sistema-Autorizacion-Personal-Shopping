import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, desc } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { getEmailConfigMasked, saveEmailConfig, mergeForTest } from './service.js';
import { verifySmtp } from '../email/mailer.js';
import { verifyImap, pollNow, getSchedulerStatus } from '../email/reader.js';
import { startScheduler, getSchedulerTiming } from '../email/scheduler.js';
import { audit } from '../../lib/audit.js';

const emailSchema = z.object({
  imapHost: z.string().optional(),
  imapPort: z.number().int().optional(),
  imapSecure: z.boolean().optional(),
  imapUser: z.string().optional(),
  imapPassword: z.string().optional(),
  smtpHost: z.string().optional(),
  smtpPort: z.number().int().optional(),
  smtpSecure: z.boolean().optional(),
  smtpUser: z.string().optional(),
  smtpPassword: z.string().optional(),
  fromName: z.string().optional(),
  fromAddress: z.string().optional(),
  pollMinutes: z.number().int().min(0).optional(),
  processedFolder: z.string().optional(),
});

export async function configRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.requireAdmin);

  app.get('/email', async () => getEmailConfigMasked());

  app.put('/email', async (req) => {
    const data = emailSchema.parse(req.body);
    saveEmailConfig(data);
    // Reiniciar el lector con la config nueva: un cambio de frecuencia (o de servidor)
    // tiene que aplicar en el momento, sin reiniciar el sistema.
    startScheduler({ reconfig: true });
    audit({ userId: req.user!.id, accion: 'CONFIGURACION_MODIFICADA', entidad: 'email_config', ip: req.ip });
    return { ...getEmailConfigMasked(), scheduler: { ...getSchedulerStatus(), ...getSchedulerTiming() } };
  });

  app.post('/email/test-smtp', async (req) => verifySmtp(mergeForTest(emailSchema.parse(req.body ?? {}))));
  app.post('/email/test-imap', async (req) => verifyImap(mergeForTest(emailSchema.parse(req.body ?? {}))));

  // Forzar una revisión del buzón ahora.
  app.post('/email/revisar-ahora', async (req) => {
    audit({ userId: req.user!.id, accion: 'EMAIL_REVISION_MANUAL', ip: req.ip });
    const res = await pollNow();
    return res;
  });

  // Monitoreo: estado del procesamiento de emails.
  app.get('/monitor', async () => {
    const porEstado = db
      .select({ estado: schema.emailMessages.estado, n: sql<number>`count(*)` })
      .from(schema.emailMessages)
      .groupBy(schema.emailMessages.estado)
      .all();
    const ultimo = db.select().from(schema.emailMessages).orderBy(desc(schema.emailMessages.fechaRecibido)).limit(5).all();
    const jobsError = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.processingJobs)
      .where(sql`estado = 'ERROR'`)
      .get();
    return { scheduler: { ...getSchedulerStatus(), ...getSchedulerTiming() }, emailsPorEstado: porEstado, ultimosEmails: ultimo, jobsConError: jobsError?.n ?? 0 };
  });
}
