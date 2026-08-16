import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// backend/src/config -> raíz del proyecto
const projectRoot = path.resolve(__dirname, '..', '..', '..');

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}
function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'si', 'sí'].includes(v.toLowerCase());
}

function resolveStorage(): string {
  const raw = str('STORAGE_PATH', './storage');
  const abs = path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
  return abs;
}

const storagePath = resolveStorage();

export const env = {
  projectRoot,
  nodeEnv: str('NODE_ENV', 'development'),
  isProd: str('NODE_ENV', 'development') === 'production',
  port: num('PORT', 4000),
  host: str('HOST', '127.0.0.1'),
  sessionSecret: str('SESSION_SECRET', 'dev-inseguro-cambiar-en-produccion'),

  storagePath,
  dbPath: path.join(storagePath, 'data', 'sistema.db'),
  docsPath: path.join(storagePath, 'documentos'),
  emailsPath: path.join(storagePath, 'emails'),
  backupsPath: path.join(storagePath, 'backups'),
  logsPath: path.join(storagePath, 'logs'),
  tmpPath: path.join(storagePath, 'tmp'),

  tz: str('TZ', 'America/Argentina/Buenos_Aires'),
  locale: str('LOCALE', 'es-AR'),

  mail: {
    imapHost: str('MAIL_IMAP_HOST'),
    imapPort: num('MAIL_IMAP_PORT', 993),
    imapSecure: bool('MAIL_IMAP_SECURE', true),
    imapUser: str('MAIL_IMAP_USER'),
    imapPassword: str('MAIL_IMAP_PASSWORD'),
    smtpHost: str('MAIL_SMTP_HOST'),
    smtpPort: num('MAIL_SMTP_PORT', 587),
    smtpSecure: bool('MAIL_SMTP_SECURE', false),
    smtpUser: str('MAIL_SMTP_USER'),
    smtpPassword: str('MAIL_SMTP_PASSWORD'),
    fromName: str('MAIL_FROM_NAME', 'Seguridad Shopping'),
    fromAddress: str('MAIL_FROM_ADDRESS'),
    pollMinutes: num('MAIL_POLL_MINUTES', 5),
    processedFolder: str('MAIL_PROCESSED_FOLDER'),
  },

  rules: {
    expiryAlertDays: num('EXPIRY_ALERT_DAYS', 15),
    // La fecha de emisión de la documentación no puede superar estos días al hacer la obra.
    emissionMaxDays: num('EMISSION_MAX_DAYS', 30),
    maxFileMb: num('MAX_FILE_MB', 25),
    maxZipUncompressedMb: num('MAX_ZIP_UNCOMPRESSED_MB', 200),
  },

  ocrLangs: str('OCR_LANGS', 'spa'),
};

/** Crea todas las carpetas de almacenamiento si no existen. */
export function ensureStorageDirs(): void {
  for (const dir of [
    env.storagePath,
    path.dirname(env.dbPath),
    env.docsPath,
    env.emailsPath,
    env.backupsPath,
    env.logsPath,
    env.tmpPath,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
