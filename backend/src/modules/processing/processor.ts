import fs from 'node:fs';
import { simpleParser } from 'mailparser';
import { eq, and } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../lib/audit.js';
import { nowIso } from '../../lib/datetime.js';
import { isZip } from '../../lib/files.js';
import { extractZip } from './zip.js';
import { findOrCreatePersona, normalizeCuil, normalizeDni, splitNombreCompleto } from '../personas/service.js';
import { getPlaceholderLocalId } from '../../db/migrate.js';
import { parsePersonasSpreadsheet } from '../../lib/xlsx.js';
import { findOrCreateLocal } from '../locales/service.js';
import { recomputeSolicitudEstado, asignarNroOrden } from '../solicitudes/service.js';
import { sendMail } from '../email/mailer.js';
import { parsePersonasFromBody } from './body-table.js';

/** Extrae la dirección de un "Nombre <addr@dom>" o devuelve el texto si ya es una dirección. */
function extraerEmail(remitente: string | null | undefined): string {
  if (!remitente) return '';
  const m = remitente.match(/<([^>]+)>/);
  return (m ? m[1] : remitente).trim();
}

interface FileItem {
  filename: string;
  buffer: Buffer;
}

// Máximo de personas por solicitud que se procesan automáticamente. Por encima de esto no se
// crea la solicitud: se avisa al remitente y queda en respaldo. Es un límite operativo (alguien
// tiene que revisar la documentación de cada persona a mano) además de protección del sistema.
const MAX_PERSONAS_PLANILLA = 40;

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
export async function processEmail(emailId: number, opts: { force?: boolean } = {}): Promise<void> {
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

    // ¿Es una RESPUESTA o continuación de un correo anterior? (In-Reply-To / References
    // apuntan a un Message-ID que ya conocemos: un correo recibido o uno que nosotros
    // enviamos, ej. el aviso de "documentación observada"). En ese caso NO se reprocesa
    // automáticamente —evita duplicar solicitudes— y se manda a respaldo para revisar a mano.
    const refs = new Set<string>();
    if (!opts.force && parsed.inReplyTo) parsed.inReplyTo.split(/\s+/).forEach((r) => r && refs.add(r.trim()));
    const rawRefs = opts.force ? null : parsed.references;
    if (rawRefs) (Array.isArray(rawRefs) ? rawRefs : [rawRefs]).forEach((r) => r && refs.add(String(r).trim()));
    for (const r of refs) {
      if (r === email.messageId) continue;
      const recibido = db.select({ id: schema.emailMessages.id, solId: schema.emailMessages.replySolicitudId }).from(schema.emailMessages).where(eq(schema.emailMessages.messageId, r)).get();
      const enviado = db.select({ id: schema.sentEmails.id, solId: schema.sentEmails.solicitudId }).from(schema.sentEmails).where(eq(schema.sentEmails.messageId, r)).get();
      if (recibido || enviado) {
        // Solicitud original a la que pertenece esta respuesta (para cargar ahí la doc corregida).
        const solId = enviado?.solId ?? recibido?.solId ?? null;
        const sol = solId ? db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, solId)).get() : null;
        const ref = sol?.nroOrden ? `la solicitud ${sol.nroOrden}` : 'la solicitud original';
        const motivo = enviado
          ? `Es una respuesta a un aviso que envió el sistema (posible documentación corregida). Revisala a mano y cargá los documentos en ${ref}.`
          : 'Es una respuesta/continuación de un correo anterior (posible reenvío o corrección). Revisala a mano.';
        db.update(schema.emailMessages).set({ estado: 'NEEDS_REVIEW', error: motivo, replySolicitudId: solId, updatedAt: nowIso() }).where(eq(schema.emailMessages.id, emailId)).run();
        audit({ accion: 'EMAIL_A_RESPALDO', entidad: 'email', entidadId: emailId, detalle: { motivo: 'reprocesamiento', esRespuestaASistema: !!enviado, solicitudId: solId } });
        return;
      }
    }

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
    let filas = excel ? parsePersonasSpreadsheet(excel.filename, excel.buffer) : [];
    // Si no hubo Excel (o no se pudo leer), buscar la lista de personas en el CUERPO del email
    // (tabla HTML o texto plano con CUIL + nombre).
    let origenPersonas: 'excel' | 'cuerpo' | null = filas.length ? 'excel' : null;
    if (filas.length === 0) {
      const desdeCuerpo = parsePersonasFromBody(parsed.html || undefined, parsed.text || undefined);
      if (desdeCuerpo.length) { filas = desdeCuerpo; origenPersonas = 'cuerpo'; }
    }

    // Límite operativo/anti-sobrecarga: una planilla con demasiadas personas no se puede revisar
    // a mano (y una enorme, ej. 3300, cuelga el sistema). No se crea la solicitud: se avisa al
    // remitente por email y el correo queda en respaldo con una notificación en el sistema.
    if (filas.length > MAX_PERSONAS_PLANILLA) {
      const motivo = `La planilla tiene ${filas.length} personas (máximo permitido: ${MAX_PERSONAS_PLANILLA}). No se procesó automáticamente: se avisó al remitente para que la divida.`;
      const to = extraerEmail(email.remitente);
      const asunto = `No procesada — supera el máximo de ${MAX_PERSONAS_PLANILLA} personas`;
      const texto = `Recibimos su solicitud${email.asunto ? ` ("${email.asunto}")` : ''}, pero incluye ${filas.length} personas y el máximo por solicitud es ${MAX_PERSONAS_PLANILLA}.

Por favor divida el pedido en solicitudes de hasta ${MAX_PERSONAS_PLANILLA} personas y reenvíelas. Cada envío se procesa por separado.`;
      let avisoEnviado = false;
      if (to) { avisoEnviado = (await sendMail({ to, subject: asunto, text: texto, inReplyTo: email.messageId, meta: { tipo: 'PLANILLA_EXCESIVA', emailMessageId: emailId } })).enviado; }
      setEmailEstado(emailId, 'NEEDS_REVIEW', avisoEnviado
        ? `${motivo}`
        : `La planilla tiene ${filas.length} personas (máximo ${MAX_PERSONAS_PLANILLA}). No se pudo avisar al remitente automáticamente${to ? '' : ' (el correo no tiene remitente)'}; avisale a mano.`);
      audit({ accion: 'EMAIL_PLANILLA_EXCESIVA', entidad: 'email', entidadId: emailId, detalle: { personas: filas.length, max: MAX_PERSONAS_PLANILLA, avisoEnviado, to } });
      return;
    }

    const avisoPersonas = filas.length > 0
      ? null
      : !excel
        ? 'El email no trae Excel ni una tabla de personas legible en el cuerpo: cargalas a mano en la solicitud.'
        : 'No se pudieron leer personas del Excel (revisá las columnas CUIL y Nombre completo): cargalas a mano en la solicitud.';
    if (avisoPersonas) audit({ accion: 'EMAIL_SIN_PERSONAS', entidad: 'email', entidadId: emailId, detalle: { motivo: avisoPersonas } });

    // Reusar la solicitud de este email si ya existe (idempotencia); si no, crearla.
    let sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, emailId)).get();
    if (!sol) {
      // personaId (contacto principal) es legacy y opcional: las personas reales van en solicitud_personas.
      const nueva = db.insert(schema.solicitudes).values({ localId: localFinal, emailMessageId: emailId, estado: 'PENDIENTE' }).returning().get();
      if (!nueva) throw new Error('No se pudo crear la solicitud del email.');
      sol = nueva;
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
      const cuil = normalizeCuil(fila.cuil ?? '');
      const dni = normalizeDni(fila.dni ?? '');
      if (cuil.length < 10 && dni.length < 7) continue;
      const nc = splitNombreCompleto(fila.nombreCompleto);
      const { persona, created } = findOrCreatePersona({ cuil, dni, nombre: nc.nombre, apellido: nc.apellido });
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
    audit({ accion: 'EMAIL_PROCESADO', entidad: 'email', entidadId: emailId, detalle: { personas: filas.length, origenPersonas, localDetectado: detectedLocalId, aviso: avisoPersonas } });
  } catch (err: any) {
    logger.error({ err }, `Error procesando email ${emailId}`);
    setEmailEstado(emailId, 'ERROR', err?.message ?? 'Error desconocido.');
  }
}
