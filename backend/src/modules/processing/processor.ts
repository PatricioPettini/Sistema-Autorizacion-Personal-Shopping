import fs from 'node:fs';
import { simpleParser } from 'mailparser';
import { eq, and } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../lib/audit.js';
import { nowIso } from '../../lib/datetime.js';
import { isZip } from '../../lib/files.js';
import { extractZip } from './zip.js';
import { findOrCreatePersona, normalizeCuil, splitNombreCompleto } from '../personas/service.js';
import { getPlaceholderLocalId } from '../../db/migrate.js';
import { parsePersonasExcel } from '../../lib/xlsx.js';
import { recomputeSolicitudEstado } from '../solicitudes/service.js';

interface FileItem {
  filename: string;
  buffer: Buffer;
}

function setEmailEstado(emailId: number, estado: string, error?: string | null) {
  db.update(schema.emailMessages).set({ estado, error: error ?? null, updatedAt: nowIso() }).where(eq(schema.emailMessages.id, emailId)).run();
}

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

/**
 * Extrae el nombre del local del asunto con el estándar:
 *   "Solicitud FAO (Local) texto extra"
 * Acepta el nombre entre paréntesis, entre guiones, o como tercera palabra.
 */
export function parseLocalFromSubject(asunto: string | null): string | null {
  if (!asunto) return null;
  const s = asunto.trim();
  const esTipo = (w: string) => /^(empresas?|monotributistas?)$/i.test(w);
  let m = s.match(/solicitud\s+fao\s*\(([^)]+)\)/i);
  if (m) return m[1].trim().replace(/\s+/g, ' ');
  m = s.match(/solicitud\s+fao\s*[-–—]\s*([^-–—]+?)\s*(?:[-–—]|$)/i);
  if (m) return m[1].trim().replace(/\s+/g, ' ');
  m = s.match(/solicitud\s+fao\s+(\S+)/i);
  if (m && !esTipo(m[1])) return m[1].trim(); // no confundir el tipo con el nombre del local
  return null;
}

/** Detecta el tipo de contratista declarado en el asunto: EMPRESA | MONOTRIBUTISTA | null. */
export function parseTipoFromSubject(asunto: string | null): 'EMPRESA' | 'MONOTRIBUTISTA' | null {
  if (!asunto) return null;
  if (/monotrib/i.test(asunto)) return 'MONOTRIBUTISTA';
  if (/empresa/i.test(asunto)) return 'EMPRESA';
  return null;
}

/**
 * Identifica el local declarado en el asunto. Si no coincide con ninguno cargado,
 * lo CREA automáticamente (el asunto es la fuente oficial del local).
 */
function identifyLocal(asunto: string | null): number | null {
  const nombre = parseLocalFromSubject(asunto);
  if (!nombre) return null;
  const t = norm(nombre);
  const locales = db.select().from(schema.locales).all();
  const match = locales
    .filter((l) => l.nombre && l.nombre !== '(Sin asignar)' && (t.includes(norm(l.nombre)) || norm(l.nombre).includes(t)))
    .sort((a, b) => b.nombre.length - a.nombre.length)[0];
  if (match) return match.id;

  // No existe un local que coincida: se crea a partir del asunto.
  const nombreLocal = nombre.slice(0, 80);
  try {
    const creado = db.insert(schema.locales).values({ nombre: nombreLocal, estado: 'ACTIVO', observaciones: 'Creado automáticamente desde el asunto de un email.' }).returning().get();
    audit({ accion: 'LOCAL_CREADO', entidad: 'local', entidadId: creado.id, detalle: { nombre: nombreLocal, origen: 'email' } });
    return creado.id;
  } catch {
    // Si otro proceso lo creó en paralelo (UNIQUE), reusar el existente.
    const ya = db.select().from(schema.locales).where(eq(schema.locales.nombre, nombreLocal)).get();
    return ya?.id ?? null;
  }
}

function esExcel(filename: string, contentType?: string): boolean {
  return /\.(xlsx|xlsm|xls)$/i.test(filename) || /spreadsheet|excel/i.test(contentType ?? '');
}

/**
 * Procesa un email entrante según el protocolo nuevo:
 *  - El asunto declara el local: "Solicitud FAO (Local) ...".
 *  - Un Excel adjunto (columnas CUIL y Nombre completo) lista a las personas.
 *  - Se crea UNA solicitud (un local) con VARIAS personas.
 * La documentación se revisa manualmente desde el email embebido en la solicitud.
 */
export async function processEmail(emailId: number): Promise<void> {
  const email = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, emailId)).get();
  if (!email) return;
  if (email.estado === 'PROCESSED') return;

  setEmailEstado(emailId, 'PROCESSING');
  try {
    if (!email.rawStoredPath || !fs.existsSync(email.rawStoredPath)) {
      setEmailEstado(emailId, 'ERROR', 'No se encontró el email guardado.');
      return;
    }
    const parsed = await simpleParser(fs.readFileSync(email.rawStoredPath));

    // Aplanar adjuntos (expandir ZIPs) para poder ubicar el Excel.
    const items: FileItem[] = [];
    for (const att of parsed.attachments ?? []) {
      const name = att.filename ?? 'adjunto';
      const buf = att.content as Buffer;
      if (isZip(name, att.contentType)) {
        for (const f of extractZip(buf).files) items.push({ filename: f.filename, buffer: f.buffer });
      } else {
        items.push({ filename: name, buffer: buf });
      }
    }
    db.update(schema.emailMessages).set({ attachmentsCount: parsed.attachments?.length ?? 0 }).where(eq(schema.emailMessages.id, emailId)).run();

    // Identificar el local por el asunto. Si no coincide, queda "(Sin asignar)".
    const detectedLocalId = email.localId ?? identifyLocal(email.asunto);
    const localFinal = detectedLocalId ?? getPlaceholderLocalId();
    if (detectedLocalId && !email.localId) db.update(schema.emailMessages).set({ localId: detectedLocalId }).where(eq(schema.emailMessages.id, emailId)).run();

    // Leer el Excel con las personas (CUIL + nombre completo).
    const excel = items.find((it) => esExcel(it.filename));
    if (!excel) {
      setEmailEstado(emailId, 'ERROR', 'El email no trae el Excel de personas (columnas CUIL y Nombre completo).');
      audit({ accion: 'EMAIL_SIN_EXCEL', entidad: 'email', entidadId: emailId });
      return;
    }
    const filas = parsePersonasExcel(excel.buffer);
    if (filas.length === 0) {
      setEmailEstado(emailId, 'ERROR', 'No se pudieron leer personas del Excel (revisá las columnas CUIL y Nombre completo).');
      return;
    }

    // Reusar la solicitud de este email si ya existe (idempotencia); si no, crearla.
    let sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, emailId)).get();
    if (!sol) {
      // personaId (primary contact) se completa con la primera persona más abajo; se usa placeholder temporal.
      const first = filas[0];
      const nc = splitNombreCompleto(first.nombreCompleto);
      const { persona: primero } = findOrCreatePersona({ cuil: normalizeCuil(first.cuil), nombre: nc.nombre, apellido: nc.apellido });
      sol = db.insert(schema.solicitudes).values({ personaId: primero.id, localId: localFinal, emailMessageId: emailId, estado: 'PENDIENTE' }).returning().get();
      audit({ accion: 'SOLICITUD_CREADA', entidad: 'solicitud', entidadId: sol.id, detalle: { origen: 'email', personas: filas.length } });
    } else if (detectedLocalId && sol.localId !== localFinal) {
      db.update(schema.solicitudes).set({ localId: localFinal, updatedAt: nowIso() }).where(eq(schema.solicitudes.id, sol.id)).run();
    }

    // Tipo de contratista declarado en el asunto (define qué documentación se exige).
    const tipo = parseTipoFromSubject(email.asunto);

    // Alta/asociación de cada persona del Excel.
    const personaIds: number[] = [];
    for (const fila of filas) {
      const cuil = normalizeCuil(fila.cuil);
      if (cuil.length < 10) continue;
      const nc = splitNombreCompleto(fila.nombreCompleto);
      const { persona, created } = findOrCreatePersona({ cuil, nombre: nc.nombre, apellido: nc.apellido });
      if (created) audit({ accion: 'PERSONA_CREADA', entidad: 'persona', entidadId: persona.id, detalle: { origen: 'email', emailId } });
      // El asunto declara Empresa/Monotributista => se asigna la categoría (para exigir sus documentos).
      if (tipo && persona.categoria !== tipo) {
        db.update(schema.personas).set({ categoria: tipo, updatedAt: nowIso() }).where(eq(schema.personas.id, persona.id)).run();
      }
      db.insert(schema.solicitudPersonas).values({ solicitudId: sol.id, personaId: persona.id }).onConflictDoNothing().run();
      personaIds.push(persona.id);
    }

    // Reenvíos: si una persona ya tenía una solicitud ABIERTA del mismo local en OTRO email
    // (típicamente OBSERVADA), esa queda "reemplazada" por ésta (la documentación corregida).
    for (const personaId of personaIds) {
      const previas = db
        .select({ spId: schema.solicitudPersonas.id, solicitudId: schema.solicitudPersonas.solicitudId })
        .from(schema.solicitudPersonas)
        .innerJoin(schema.solicitudes, eq(schema.solicitudPersonas.solicitudId, schema.solicitudes.id))
        .where(and(
          eq(schema.solicitudPersonas.personaId, personaId),
          eq(schema.solicitudes.localId, localFinal),
        ))
        .all()
        .filter((r) => r.solicitudId !== sol!.id);
      for (const p of previas) {
        const spRow = db.select().from(schema.solicitudPersonas).where(eq(schema.solicitudPersonas.id, p.spId)).get();
        if (!spRow || ['AUTORIZADA', 'RECHAZADA', 'REVOCADA', 'REEMPLAZADA'].includes(spRow.estado)) continue;
        db.update(schema.solicitudPersonas).set({ estado: 'REEMPLAZADA', updatedAt: nowIso() }).where(eq(schema.solicitudPersonas.id, p.spId)).run();
        recomputeSolicitudEstado(p.solicitudId);
        audit({ accion: 'SOLICITUD_REEMPLAZADA', entidad: 'solicitud', entidadId: p.solicitudId, detalle: { personaId, reemplazadaPor: sol.id } });
      }
    }

    recomputeSolicitudEstado(sol.id);
    // Siempre PROCESSED: si el local no se identificó, la solicitud queda "(Sin asignar)"
    // y el admin la reasigna desde Solicitudes (ya no existe la bandeja de Revisión manual).
    setEmailEstado(emailId, 'PROCESSED');
    audit({ accion: 'EMAIL_PROCESADO', entidad: 'email', entidadId: emailId, detalle: { personas: filas.length, localDetectado: detectedLocalId } });
  } catch (err: any) {
    logger.error({ err }, `Error procesando email ${emailId}`);
    setEmailEstado(emailId, 'ERROR', err?.message ?? 'Error desconocido.');
  }
}
