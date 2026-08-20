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
  cuil?: string;
  dni?: string;
  nombre: string;
  apellido: string;
}

/**
 * Busca por CUIL y, si no, por DNI; si no existe la crea. Nunca duplica.
 * Acepta identificar por CUIL (11 díg.) o por DNI (7-8 díg.) cuando el remitente
 * no manda CUIL. La columna `dni` es NOT NULL UNIQUE: guardamos el DNI real, o el
 * CUIL si es lo único que hay.
 */
export function findOrCreatePersona(input: PersonaInput): { persona: typeof schema.personas.$inferSelect; created: boolean } {
  const cuil = normalizeCuil(input.cuil ?? '');
  const dni = normalizeDni(input.dni ?? '');

  let existing = cuil ? findPersonaByCuil(cuil) : null;
  if (!existing && dni) existing = db.select().from(schema.personas).where(eq(schema.personas.dni, dni)).get() ?? null;
  if (existing) {
    // Completar el CUIL si antes se cargó solo por DNI y ahora llega el CUIL.
    if (cuil && !existing.cuil) {
      db.update(schema.personas).set({ cuil }).where(eq(schema.personas.id, existing.id)).run();
      existing = { ...existing, cuil };
    }
    return { persona: existing, created: false };
  }

  const dniFinal = dni || cuil; // dni es NOT NULL
  const persona = db
    .insert(schema.personas)
    .values({ cuil: cuil || null, dni: dniFinal, nombre: input.nombre.trim(), apellido: input.apellido.trim() })
    .returning()
    .get();
  return { persona, created: true };
}
