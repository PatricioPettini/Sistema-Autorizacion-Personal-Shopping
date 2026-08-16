import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { nowIso } from '../../lib/datetime.js';

/** Estado "resumen" a partir de varios estados (de personas o de solicitudes de un grupo). */
export function aggEstado(estadosRaw: string[]): string {
  // Las personas "reemplazadas" (por un reenvío posterior) no cuentan para el estado activo.
  const estados = estadosRaw.filter((e) => e !== 'REEMPLAZADA');
  if (estados.length === 0) return estadosRaw.length ? 'REEMPLAZADA' : 'PENDIENTE';
  const todas = (e: string) => estados.every((x) => x === e);
  const alguna = (e: string) => estados.some((x) => x === e);
  if (todas('AUTORIZADA')) return 'AUTORIZADA';
  if (todas('RECHAZADA')) return 'RECHAZADA';
  if (todas('REVOCADA')) return 'REVOCADA';
  if (alguna('OBSERVADA')) return 'OBSERVADA';
  // Alguna autorizada (pero no todas) o ya en revisión => en revisión.
  if (alguna('AUTORIZADA') || alguna('EN_REVISION')) return 'EN_REVISION';
  return 'PENDIENTE';
}

/** Agrupa filas de solicitudes por email (o por solicitud si es manual). Devuelve grupos ordenados por updatedAt desc. */
export interface SolicitudRow {
  id: number; estado: string; updatedAt: string; localId: number; local: string;
  emailMessageId: number | null; emailAsunto?: string | null;
  personasCount: number | null; personasLabel: string | null; cuils?: string | null;
  categorias?: string | null;
}
export interface SolicitudGroup {
  id: number; localId: number; local: string; emailAsunto: string | null;
  personasCount: number; personasLabel: string; cuils: string; estado: string; updatedAt: string;
  tipo: string | null; // EMPRESA | MONOTRIBUTISTA | MIXTO | null
}

/** Resuelve el tipo de un grupo a partir de las categorías de sus personas. */
function tipoDeGrupo(cats: Set<string>): string | null {
  if (cats.size === 0) return null;
  if (cats.size === 1) return [...cats][0];
  return 'MIXTO';
}

export function agruparPorEmail(rows: SolicitudRow[]): SolicitudGroup[] {
  const groups = new Map<string, any>();
  for (const r of rows) {
    const key = r.emailMessageId != null ? `e${r.emailMessageId}` : `s${r.id}`;
    let g = groups.get(key);
    if (!g) { g = { id: r.id, localId: r.localId, local: r.local, emailAsunto: r.emailAsunto ?? null, updatedAt: r.updatedAt, personasCount: 0, labels: [] as string[], cuils: [] as string[], estados: [] as string[], cats: new Set<string>() }; groups.set(key, g); }
    g.id = Math.min(g.id, r.id);
    if (g.local === '(Sin asignar)' && r.local !== '(Sin asignar)') { g.local = r.local; g.localId = r.localId; }
    g.personasCount += r.personasCount ?? 0;
    if (r.personasLabel) g.labels.push(r.personasLabel);
    if (r.cuils) g.cuils.push(r.cuils);
    if (r.categorias) for (const c of r.categorias.split(',')) if (c) g.cats.add(c);
    g.estados.push(r.estado);
    if (r.updatedAt > g.updatedAt) g.updatedAt = r.updatedAt;
  }
  return [...groups.values()]
    .map((g) => ({ id: g.id, localId: g.localId, local: g.local, emailAsunto: g.emailAsunto, personasCount: g.personasCount, personasLabel: g.labels.join(' · '), cuils: g.cuils.join(','), estado: aggEstado(g.estados), updatedAt: g.updatedAt, tipo: tipoDeGrupo(g.cats) }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/**
 * Recalcula el estado "resumen" de una solicitud a partir del estado de cada
 * una de sus personas. Sirve para el listado y los filtros del panel.
 */
export function recomputeSolicitudEstado(solicitudId: number): string {
  const filas = db
    .select({ estado: schema.solicitudPersonas.estado })
    .from(schema.solicitudPersonas)
    .where(eq(schema.solicitudPersonas.solicitudId, solicitudId))
    .all();

  let estado = 'PENDIENTE';
  if (filas.length > 0) {
    const estados = filas.map((f) => f.estado);
    const todas = (e: string) => estados.every((x) => x === e);
    const alguna = (e: string) => estados.some((x) => x === e);
    if (todas('AUTORIZADA')) estado = 'AUTORIZADA';
    else if (todas('RECHAZADA')) estado = 'RECHAZADA';
    else if (todas('REVOCADA')) estado = 'REVOCADA';
    else if (alguna('OBSERVADA')) estado = 'OBSERVADA';
    else if (alguna('AUTORIZADA')) estado = 'EN_REVISION';
    else estado = 'PENDIENTE';
  }

  db.update(schema.solicitudes).set({ estado, updatedAt: nowIso() }).where(eq(schema.solicitudes.id, solicitudId)).run();
  return estado;
}
