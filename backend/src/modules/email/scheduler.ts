import { logger } from '../../lib/logger.js';
import { getEmailConfig } from '../config/service.js';
import { pollNow } from './reader.js';

let timer: NodeJS.Timeout | null = null;

/** Inicia el lector automático de emails según la frecuencia configurada. */
export function startScheduler(): void {
  const c = getEmailConfig();
  if (timer) clearInterval(timer);
  if (!c.imapHost || c.pollMinutes <= 0) {
    logger.info('Lector automático de email desactivado (sin IMAP o frecuencia 0).');
    return;
  }
  const ms = c.pollMinutes * 60 * 1000;
  logger.info(`Lector automático de email activo: cada ${c.pollMinutes} min.`);
  // Primer chequeo diferido para no bloquear el arranque.
  timer = setInterval(() => {
    pollNow().catch((err) => logger.error({ err }, 'Error en revisión programada de email.'));
  }, ms);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
