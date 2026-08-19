import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { sendMail } from '../email/mailer.js';
import { formatCuil } from '../personas/service.js';
import { getPersonaDocStatus } from '../documentos/service.js';
import { audit } from '../../lib/audit.js';
import { todayLocal } from '../../lib/datetime.js';

/** Extrae la dirección de un "Nombre <addr@dom>" o devuelve el texto si ya es una dirección. */
function extraerEmail(remitente: string | null | undefined): string {
  if (!remitente) return '';
  const m = remitente.match(/<([^>]+)>/);
  return (m ? m[1] : remitente).trim();
}

function fmtFechaCorta(f: string | null | undefined): string {
  if (!f) return '—';
  const [y, m, d] = f.split('-');
  return d && m && y ? `${d}/${m}/${y}` : f;
}

/** Destinatario de una solicitud/persona: el email del local (si existe). */
function destinatario(solicitudId: number, personaId: number): { to: string; persona: any; local: any; sol: any; inReplyTo: string | null } | null {
  const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, solicitudId)).get();
  if (!sol) return null;
  const persona = db.select().from(schema.personas).where(eq(schema.personas.id, personaId)).get();
  const local = db.select().from(schema.locales).where(eq(schema.locales.id, sol.localId)).get();
  const origen = sol.emailMessageId ? db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, sol.emailMessageId)).get() : null;
  return { to: local?.email ?? '', persona, local, sol, inReplyTo: origen?.messageId ?? null };
}

export async function notifyObservacion(solicitudId: number, personaId: number, comentario: string): Promise<void> {
  const d = destinatario(solicitudId, personaId);
  if (!d || !d.persona) return;
  const texto = `La documentación de la siguiente persona fue OBSERVADA:

Persona: ${d.persona.apellido}, ${d.persona.nombre}
CUIL: ${formatCuil(d.persona.cuil ?? '')}
Local: ${d.local?.nombre ?? '-'}

Observación:
${comentario || '(sin detalle)'}

Por favor revisar y reenviar la documentación corregida.`;
  const { enviado } = await sendMail({ to: d.to, subject: `Documentación observada — ${d.persona.nombre} ${d.persona.apellido}`, text: texto, inReplyTo: d.inReplyTo, meta: { tipo: 'OBSERVACION', solicitudId, emailMessageId: d.sol.emailMessageId } });
  if (enviado) audit({ accion: 'EMAIL_ENVIADO', entidad: 'solicitud', entidadId: solicitudId, detalle: { tipo: 'OBSERVACION', personaId } });
}

export async function notifyRechazo(solicitudId: number, personaId: number, motivo: string): Promise<void> {
  const d = destinatario(solicitudId, personaId);
  if (!d || !d.persona) return;
  const texto = `El ingreso de la siguiente persona fue RECHAZADO:

Persona: ${d.persona.apellido}, ${d.persona.nombre}
CUIL: ${formatCuil(d.persona.cuil ?? '')}
Local: ${d.local?.nombre ?? '-'}

Motivo del rechazo:
${motivo}`;
  const { enviado } = await sendMail({ to: d.to, subject: `Ingreso rechazado — ${d.persona.nombre} ${d.persona.apellido}`, text: texto, inReplyTo: d.inReplyTo, meta: { tipo: 'RECHAZO', solicitudId, emailMessageId: d.sol.emailMessageId } });
  if (enviado) audit({ accion: 'EMAIL_ENVIADO', entidad: 'solicitud', entidadId: solicitudId, detalle: { tipo: 'RECHAZO', personaId } });
}

export async function notifyAutorizacion(autorizacionId: number): Promise<void> {
  const aut = db.select().from(schema.autorizaciones).where(eq(schema.autorizaciones.id, autorizacionId)).get();
  if (!aut) return;
  const persona = db.select().from(schema.personas).where(eq(schema.personas.id, aut.personaId)).get();
  const local = db.select().from(schema.locales).where(eq(schema.locales.id, aut.localId)).get();
  if (!persona) return;
  const rango = aut.fechaHasta && aut.fechaHasta !== aut.fecha ? `${aut.fecha} a ${aut.fechaHasta}` : aut.fecha;
  const texto = `El ingreso de la siguiente persona fue AUTORIZADO:

Persona: ${persona.apellido}, ${persona.nombre}
CUIL: ${formatCuil(persona.cuil ?? '')}
Local: ${local?.nombre ?? '-'}
Fecha: ${rango}
Horario: ${aut.horaDesde} a ${aut.horaHasta}
Estado: AUTORIZADO
${aut.comentario ? `\nComentario: ${aut.comentario}` : ''}`;
  const { enviado } = await sendMail({ to: local?.email ?? '', subject: `Ingreso autorizado — ${persona.nombre} ${persona.apellido}`, text: texto, meta: { tipo: 'AUTORIZACION', solicitudId: aut.solicitudId } });
  if (enviado) audit({ accion: 'EMAIL_ENVIADO', entidad: 'autorizacion', entidadId: autorizacionId, detalle: { tipo: 'AUTORIZACION' } });
}

/**
 * Email de cierre de revisión al REMITENTE del correo original: resume, por persona, si quedó
 * autorizada (con la fecha hasta la que puede ingresar) o no (con la documentación faltante).
 * Lleva el número de orden del grupo (lo genera la ruta antes de llamar acá).
 */
export async function notifyResultadoRevision(solicitudId: number): Promise<{ enviado: boolean; to: string; nroOrden: string | null }> {
  const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, solicitudId)).get();
  if (!sol) return { enviado: false, to: '', nroOrden: null };

  // Grupo del email (todas las solicitudes del mismo correo).
  const hermanas = sol.emailMessageId != null
    ? db.select().from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, sol.emailMessageId)).all()
    : [sol];
  const solIds = hermanas.map((s) => s.id);

  const email = sol.emailMessageId ? db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, sol.emailMessageId)).get() : null;
  const to = extraerEmail(email?.remitente);
  const nroOrden = hermanas.find((s) => s.nroOrden)?.nroOrden ?? null;
  if (!to) return { enviado: false, to: '', nroOrden };

  const localesGrupo = db.select().from(schema.locales).where(inArray(schema.locales.id, [...new Set(hermanas.map((s) => s.localId))])).all();
  const local = localesGrupo.find((l) => l.nombre !== '(Sin asignar)') ?? localesGrupo[0];
  const venc = hermanas.map((s) => s.fechaVencimiento).find(Boolean) ?? null;

  const sps = db
    .select({
      personaId: schema.personas.id, cuil: schema.personas.cuil, nombre: schema.personas.nombre,
      apellido: schema.personas.apellido, estado: schema.solicitudPersonas.estado, motivoRechazo: schema.solicitudPersonas.motivoRechazo,
    })
    .from(schema.solicitudPersonas)
    .innerJoin(schema.personas, eq(schema.solicitudPersonas.personaId, schema.personas.id))
    .where(inArray(schema.solicitudPersonas.solicitudId, solIds))
    .orderBy(schema.personas.apellido)
    .all();

  const lineas = sps.map((p) => {
    const nom = `${p.apellido}, ${p.nombre} (CUIL ${formatCuil(p.cuil ?? '')})`;
    if (p.estado === 'AUTORIZADA') return `✓ ${nom}\n   AUTORIZADO — ${venc ? `puede ingresar hasta el ${fmtFechaCorta(venc)}` : 'puede ingresar (sin fecha de vencimiento definida)'}.`;
    // El motivo lo escribe una persona y suele venir con punto final: no duplicarlo.
    const motivo = p.motivoRechazo?.trim().replace(/\.+$/, '');
    if (p.estado === 'RECHAZADA') return `✗ ${nom}\n   RECHAZADO${motivo ? ` — ${motivo}` : ''}.`;
    const faltantes = getPersonaDocStatus(p.personaId).faltantes;
    return `• ${nom}\n   PENDIENTE — falta: ${faltantes.length ? faltantes.join(', ') : 'documentación por revisar'}.`;
  });

  const texto = `Resultado de la revisión de la documentación enviada.

${nroOrden ? `Número de orden: ${nroOrden}\n` : ''}Local: ${local?.nombre ?? '-'}
Fecha: ${fmtFechaCorta(todayLocal())}

${lineas.join('\n\n')}

Por las personas que figuran como PENDIENTE, enviar la documentación faltante para completar la autorización.${nroOrden ? `\n\nCitar el número de orden ${nroOrden} en cualquier consulta sobre esta solicitud.` : ''}`;

  const asuntoLocal = local?.nombre ?? 'Ingreso de personal';
  const subject = nroOrden ? `Orden ${nroOrden} — Resultado de la revisión — ${asuntoLocal}` : `Resultado de la revisión — ${asuntoLocal}`;
  const { enviado } = await sendMail({ to, subject, text: texto, inReplyTo: email?.messageId ?? null, meta: { tipo: 'RESULTADO_REVISION', solicitudId, emailMessageId: sol.emailMessageId } });
  if (enviado) audit({ accion: 'EMAIL_ENVIADO', entidad: 'solicitud', entidadId: solicitudId, detalle: { tipo: 'RESULTADO_REVISION', to, nroOrden } });
  return { enviado, to, nroOrden };
}
