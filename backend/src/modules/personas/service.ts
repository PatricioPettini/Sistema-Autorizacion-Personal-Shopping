import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';

/** Normaliza un CUIL/CUIT: solo dígitos. */
export function normalizeCuil(cuil: string): string {
  return (cuil || '').replace(/\D/g, '');
}

/** Formatea un CUIL: 20304050607 -> 20-30405060-7 */
export function formatCuil(cuil: string): string {
  const n = normalizeCuil(cuil);
  if (n.length !== 11) return n;
  return `${n.slice(0, 2)}-${n.slice(2, 10)}-${n.slice(10)}`;
}

// --- Compatibilidad DNI (bases viejas / utilidades) ---
export function normalizeDni(dni: string): string {
  return (dni || '').replace(/\D/g, '');
}
export function formatDni(dni: string): string {
  const n = normalizeDni(dni);
  return n.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * Separa un "nombre completo" con formato "Nombre Apellido".
 * La primera palabra es el nombre; el resto, el apellido.
 */
export function splitNombreCompleto(full: string): { nombre: string; apellido: string } {
  const parts = (full || '').trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  if (parts.length === 0) return { nombre: '(a completar)', apellido: '(a completar)' };
  if (parts.length === 1) return { nombre: parts[0], apellido: '(a completar)' };
  return { nombre: parts[0], apellido: parts.slice(1).join(' ') };
}

export function findPersonaByCuil(cuil: string) {
  const norm = normalizeCuil(cuil);
  if (!norm) return null;
  return db.select().from(schema.personas).where(eq(schema.personas.cuil, norm)).get() ?? null;
}

export interface PersonaInput {
  cuil: string;
  nombre: string;
  apellido: string;
}

/** Busca por CUIL; si no existe la crea. Nunca duplica por CUIL. */
export function findOrCreatePersona(input: PersonaInput): { persona: typeof schema.personas.$inferSelect; created: boolean } {
  const norm = normalizeCuil(input.cuil);
  const existing = findPersonaByCuil(norm);
  if (existing) return { persona: existing, created: false };
  const persona = db
    .insert(schema.personas)
    // dni se conserva por compatibilidad (NOT NULL UNIQUE): guardamos el CUIL también ahí.
    .values({ cuil: norm, dni: norm, nombre: input.nombre.trim(), apellido: input.apellido.trim() })
    .returning()
    .get();
  return { persona, created: true };
}
