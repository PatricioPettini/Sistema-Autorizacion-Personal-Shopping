import { eq, and, desc } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { todayLocal } from '../../lib/datetime.js';
import { env } from '../../config/env.js';

export interface VigenciaInfo {
  autorizacion: typeof schema.autorizaciones.$inferSelect | null;
  estado: 'AUTORIZADO' | 'NO_AUTORIZADO' | 'VENCIDO' | 'REVOCADO';
  vigenteHoy: boolean;
}

/** Determina si una persona tiene autorización vigente hoy (opcionalmente para un local). */
export function getVigencia(personaId: number, localId?: number): VigenciaInfo {
  const today = todayLocal();
  const conds = [eq(schema.autorizaciones.personaId, personaId)];
  if (localId) conds.push(eq(schema.autorizaciones.localId, localId));
  const auts = db
    .select()
    .from(schema.autorizaciones)
    .where(and(...conds))
    .orderBy(desc(schema.autorizaciones.fecha), desc(schema.autorizaciones.fechaDecision))
    .all();

  if (auts.length === 0) return { autorizacion: null, estado: 'NO_AUTORIZADO', vigenteHoy: false };

  // Fin efectivo del rango: si no hay fechaHasta, la autorización vale solo el día 'fecha'.
  const finRango = (a: typeof schema.autorizaciones.$inferSelect) => a.fechaHasta ?? a.fecha;

  // Autorización vigente HOY (hoy dentro del rango [fecha, fechaHasta]) y no revocada.
  const vigente = auts.find((a) => a.estado === 'AUTORIZADA' && a.fecha <= today && finRango(a) >= today);
  if (vigente) return { autorizacion: vigente, estado: 'AUTORIZADO', vigenteHoy: true };

  const ultima = auts[0];
  if (ultima.estado === 'REVOCADA') return { autorizacion: ultima, estado: 'REVOCADO', vigenteHoy: false };
  // Autorizada pero con el rango ya pasado (venció)
  const autorizada = auts.find((a) => a.estado === 'AUTORIZADA');
  if (autorizada && finRango(autorizada) < today) return { autorizacion: autorizada, estado: 'VENCIDO', vigenteHoy: false };
  // Autorizada para una fecha futura (o sin coincidir con hoy): no habilita el ingreso todavía.
  return { autorizacion: autorizada ?? ultima, estado: autorizada ? 'AUTORIZADO' : 'NO_AUTORIZADO', vigenteHoy: false };
}

export { env };
