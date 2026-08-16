import nodemailer from 'nodemailer';
import { getEmailConfig, type EmailConfig } from '../config/service.js';
import { logger } from '../../lib/logger.js';

export function buildTransporter(cfg: EmailConfig = getEmailConfig()) {
  if (!cfg.smtpHost) return null;
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpSecure,
    auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPassword } : undefined,
  });
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

/** Envía un email. Si SMTP no está configurado, no rompe: registra y devuelve false. */
export async function sendMail(mail: OutgoingMail): Promise<boolean> {
  const c = getEmailConfig();
  const transporter = buildTransporter();
  if (!transporter || !c.fromAddress) {
    logger.warn(`SMTP no configurado; no se envió el email a ${mail.to} ("${mail.subject}").`);
    return false;
  }
  if (!mail.to) {
    logger.warn(`Email "${mail.subject}" sin destinatario; no se envió.`);
    return false;
  }
  try {
    await transporter.sendMail({
      from: `"${c.fromName}" <${c.fromAddress}>`,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
    });
    logger.info(`Email enviado a ${mail.to}: ${mail.subject}`);
    return true;
  } catch (err) {
    logger.error({ err }, `No se pudo enviar el email a ${mail.to}`);
    return false;
  }
}

/** Verifica la conexión SMTP (opcionalmente con una config provista, ej. desde el formulario). */
export async function verifySmtp(cfg?: EmailConfig): Promise<{ ok: boolean; error?: string }> {
  const transporter = buildTransporter(cfg);
  if (!transporter) return { ok: false, error: 'Falta completar el servidor SMTP.' };
  try {
    await transporter.verify();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Error desconocido.' };
  }
}
