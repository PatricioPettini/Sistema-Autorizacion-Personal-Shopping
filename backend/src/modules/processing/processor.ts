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
import { parsePersonasSpreadsheet } from '../../lib/xlsx.js';
import { findOrCreateLocal } from '../locales/service.js';
import { recomputeSolicitudEstado, asignarNroOrden } from '../solicitudes/service.js';

interface FileItem {
  filename: string;
  buffer: Buffer;
}

function setEmailEstado(emailId: number, estado: string, error?: string | null) {
  db.update(schema.emailMessages).set({ estado, error: error ?? null, updatedAt: nowIso() }).where(eq(schema.emailMessages.id, emailId)).run();
}

/**
 * Extrae el nombre del local a partir del asunto. Es tolerante a los formatos que
 * mandan los encargados, no solo el estándar. Ejemplos que resuelve:
 *   "Solicitud FAO (Local) empresa"        -> "Local"
 *   "SOLICITUD DE FAO (CHEEKY)-EMPRESA"     -> "CHEEKY"
 *   "Solicitud de FAO Bensimon"             -> "Bensimon"
 *   "Solicitud de FAO Bensimon para ingreso y egreso de mercaderia" -> "Bensimon"
 * Acepta el "de" opcional, mayúsculas/minúsculas, nombre entre paréntesis o suelto,
 * y descarta el tipo (empresa/monotributista) y frases de relleno del asunto.
 */
export function parseLocalFromSubject(asunto: string | null): string | null {
  if (!asunto) return null;
  const s = asunto.trim();
  // Saca tokens de tipo y separadores/paréntesis; colapsa espacios.
  const limpiar = (x: string) =>
    x.replace(/\b(empresas?|monotributistas?|mono)\b/gi, '')
      .replace(/[()\-–—:]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  // 1) Nombre entre paréntesis en un asunto de FAO: "... FAO (CHEEKY) ...".
  if (/\bfao\b/i.test(s)) {
    const par = s.match(/\(([^)]+)\)/);
    if (par) { const n = limpiar(par[1]); if (n) return n; }
  }
  // 2) Lo que viene después de "FAO" (con "de" opcional ya incluido en el resto).
  const m = s.match(/\bfao\b\s*(.+)$/i);
  if (m) {
    // Cortar en frases típicas de asunto ("para...", "ingreso...") y en separadores.
    let rest = m[1].replace(/^[\s\-–—:]+/, '');
    rest = rest.split(/\b(?:para|de\s+ingreso|ingreso|egreso)\b|[-–—:|]/i)[0];
    const n = limpiar(rest);
    if (n) return n;
  }
  return null;
}

/** Detecta el tipo de contratista declarado en un texto (asunto o cuerpo): EMPRESA | MONOTRIBUTISTA | null. */
export function parseTipo(texto: string | null | undefined): 'EMPRESA' | 'MONOTRIBUTISTA' | null {
  if (!texto) return null;
  if (/monotrib/i.test(texto)) return 'MONOTRIBUTISTA';
  if (/empresa/i.test(texto)) return 'EMPRESA';
  return null;
}

/** Compatibilidad: tipo declarado en el asunto. */
export function parseTipoFromSubject(asunto: string | null): 'EMPRESA' | 'MONOTRIBUTISTA' | null {
  return parseTipo(asunto);
}

/**
 * Identifica el local declarado en el asunto. Si no coincide con ninguno cargado,
 * lo CREA automáticamente (el asunto es la fuente oficial del local).
 * Match aproximado: el nombre del asunto puede traer texto alrededor.
 */
function identifyLocal(asunto: string | null): number | null {
  const nombre = parseLocalFromSubject(asunto);
  if (!nombre) return null;
  return findOrCreateLocal(nombre, { origen: 'email', aproximado: true })?.local.id ?? null;
}

function esExcel(filename: string, contentType?: string): boolean {
  return /\.(xlsx|xlsm|xls|ods|csv|tsv)$/i.test(filename) || /spreadsheet|excel|csv|opendocument\.spreadsheet/i.test(contentType ?? '');
}

/**
 * Procesa un email entrante según el protocolo nuevo:
 *  - El asunto declara el local: "Solicitud FAO (Local) ...".
 *  - Un Excel adjunto OPCIONAL (columnas CUIL y Nombre completo) lista a las personas.
 *    Sin Excel la solicitud se crea vacía y las personas se cargan a mano.
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

    // El Excel de personas es OPCIONAL. Si no viene (o no se puede leer), la solicitud
    // se crea igual y el admin carga las personas a mano desde el detalle.
    const excel = items.find((it) => esExcel(it.filename));
    const filas = excel ? parsePersonasSpreadsheet(excel.filename, excel.buffer) : [];
    const avisoPersonas = !excel
      ? 'El email no trae Excel de personas: cargalas a mano en la solicitud.'
      : filas.length === 0
        ? 'No se pudieron leer personas del Excel (revisá las columnas CUIL y Nombre completo): cargalas a mano en la solicitud.'
        : null;
    if (avisoPersonas) audit({ accion: 'EMAIL_SIN_PERSONAS', entidad: 'email', entidadId: emailId, detalle: { motivo: avisoPersonas } });

    // Reusar la solicitud de este email si ya existe (idempotencia); si no, crearla.
    let sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, emailId)).get();
    if (!sol) {
      // personaId (contacto principal) es legacy y opcional: las personas reales van en solicitud_personas.
      sol = db.insert(schema.solicitudes).values({ localId: localFinal, emailMessageId: emailId, estado: 'PENDIENTE' }).returning().get();
      audit({ accion: 'SOLICITUD_CREADA', entidad: 'solicitud', entidadId: sol.id, detalle: { origen: 'email', personas: filas.length } });
    } else if (detectedLocalId && sol.localId !== localFinal) {
      db.update(schema.solicitudes).set({ localId: localFinal, updatedAt: nowIso() }).where(eq(schema.solicitudes.id, sol.id)).run();
    }

    // Tipo de contratista declarado en el asunto o, si no está, en el cuerpo del email
    // (define qué documentación se exige). Si no aparece, el admin lo define a mano.
    const tipo = parseTipo(email.asunto) ?? parseTipo(parsed.text);

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
    // El número de orden se asigna al entrar el mail (identifica la solicitud desde el minuto cero).
    // Es idempotente y compartido por todo el grupo del email.
    asignarNroOrden(sol.id);
    // Siempre PROCESSED: si el local no se identificó, la solicitud queda "(Sin asignar)"
    // y el admin la reasigna desde Solicitudes (ya no existe la bandeja de Revisión manual).
    setEmailEstado(emailId, 'PROCESSED', avisoPersonas);
    audit({ accion: 'EMAIL_PROCESADO', entidad: 'email', entidadId: emailId, detalle: { personas: filas.length, localDetectado: detectedLocalId, aviso: avisoPersonas } });
  } catch (err: any) {
    logger.error({ err }, `Error procesando email ${emailId}`);
    setEmailEstado(emailId, 'ERROR', err?.message ?? 'Error desconocido.');
  }
}
