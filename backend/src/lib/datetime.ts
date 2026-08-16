import { env } from '../config/env.js';

/** Ahora en ISO-8601 UTC (para guardar en la base). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Fecha de hoy en zona horaria configurada, formato YYYY-MM-DD. */
export function todayLocal(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: env.tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Convierte un ISO/fecha a texto local argentino DD/MM/YYYY HH:mm. */
export function formatLocal(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: env.tz,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/** Días hasta una fecha YYYY-MM-DD (negativo = ya vencida). null si inválida. */
export function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const target = new Date(`${dateStr}T00:00:00`);
  if (isNaN(target.getTime())) return null;
  const today = new Date(`${todayLocal()}T00:00:00`);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}
