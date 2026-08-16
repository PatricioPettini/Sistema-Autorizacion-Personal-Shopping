import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { env } from '../../config/env.js';
import { encryptSecret, decryptSecret } from '../../lib/crypto.js';
import { nowIso } from '../../lib/datetime.js';

export interface EmailConfig {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUser: string;
  imapPassword: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  fromName: string;
  fromAddress: string;
  pollMinutes: number;
  processedFolder: string;
}

const SECRET_KEYS = new Set(['mail.imapPassword', 'mail.smtpPassword']);

function getSetting(key: string): string | null {
  return db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()?.value ?? null;
}

function setSetting(key: string, value: string): void {
  const stored = SECRET_KEYS.has(key) ? encryptSecret(value) : value;
  db.insert(schema.settings)
    .values({ key, value: stored, updatedAt: nowIso() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: stored, updatedAt: nowIso() } })
    .run();
}

/** Config efectiva: valores guardados en la base tienen prioridad sobre el .env. */
export function getEmailConfig(): EmailConfig {
  const s = (k: string, fb: string) => getSetting(k) ?? fb;
  const n = (k: string, fb: number) => {
    const v = getSetting(k);
    return v == null || v === '' ? fb : Number(v);
  };
  const b = (k: string, fb: boolean) => {
    const v = getSetting(k);
    return v == null ? fb : v === 'true' || v === '1';
  };
  return {
    imapHost: s('mail.imapHost', env.mail.imapHost),
    imapPort: n('mail.imapPort', env.mail.imapPort),
    imapSecure: b('mail.imapSecure', env.mail.imapSecure),
    imapUser: s('mail.imapUser', env.mail.imapUser),
    imapPassword: decryptSecret(getSetting('mail.imapPassword')) || env.mail.imapPassword,
    smtpHost: s('mail.smtpHost', env.mail.smtpHost),
    smtpPort: n('mail.smtpPort', env.mail.smtpPort),
    smtpSecure: b('mail.smtpSecure', env.mail.smtpSecure),
    smtpUser: s('mail.smtpUser', env.mail.smtpUser),
    smtpPassword: decryptSecret(getSetting('mail.smtpPassword')) || env.mail.smtpPassword,
    fromName: s('mail.fromName', env.mail.fromName),
    fromAddress: s('mail.fromAddress', env.mail.fromAddress),
    pollMinutes: n('mail.pollMinutes', env.mail.pollMinutes),
    processedFolder: s('mail.processedFolder', env.mail.processedFolder),
  };
}

/** Devuelve la config sin exponer contraseñas (para la UI). */
export function getEmailConfigMasked(): Omit<EmailConfig, 'imapPassword' | 'smtpPassword'> & {
  imapPasswordSet: boolean;
  smtpPasswordSet: boolean;
} {
  const c = getEmailConfig();
  const { imapPassword, smtpPassword, ...rest } = c;
  return { ...rest, imapPasswordSet: !!imapPassword, smtpPasswordSet: !!smtpPassword };
}

/** Combina la config guardada con valores del formulario (para "Probar conexión" sin guardar).
 *  Los valores del formulario ganan; una contraseña vacía conserva la guardada. */
export function mergeForTest(overrides: Partial<EmailConfig>): EmailConfig {
  const base = getEmailConfig();
  const out: EmailConfig = { ...base };
  for (const k of Object.keys(overrides) as (keyof EmailConfig)[]) {
    const v = overrides[k];
    if (v === undefined) continue;
    if ((k === 'imapPassword' || k === 'smtpPassword') && v === '') continue; // mantener guardada
    (out as any)[k] = v;
  }
  return out;
}

export function saveEmailConfig(input: Partial<EmailConfig>): void {
  const map: Record<string, keyof EmailConfig> = {
    'mail.imapHost': 'imapHost',
    'mail.imapPort': 'imapPort',
    'mail.imapSecure': 'imapSecure',
    'mail.imapUser': 'imapUser',
    'mail.imapPassword': 'imapPassword',
    'mail.smtpHost': 'smtpHost',
    'mail.smtpPort': 'smtpPort',
    'mail.smtpSecure': 'smtpSecure',
    'mail.smtpUser': 'smtpUser',
    'mail.smtpPassword': 'smtpPassword',
    'mail.fromName': 'fromName',
    'mail.fromAddress': 'fromAddress',
    'mail.pollMinutes': 'pollMinutes',
    'mail.processedFolder': 'processedFolder',
  };
  for (const [key, field] of Object.entries(map)) {
    const val = input[field];
    if (val === undefined) continue;
    // No sobreescribir contraseña si viene vacía (significa "no cambiar").
    if (SECRET_KEYS.has(key) && (val === '' || val == null)) continue;
    setSetting(key, String(val));
  }
}
