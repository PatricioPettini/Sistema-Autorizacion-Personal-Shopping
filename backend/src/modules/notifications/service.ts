import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { sendMail } from '../email/mailer.js';
import { formatCuil } from '../personas/service.js';
import { audit } from '../../lib/audit.js';

/** Destinatario de una solicitud/persona: el email del local (si existe). */
function destinatario(solicitudId: number, personaId: number): { to: string; persona: any; local: any } | null {
  const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, solicitudId)).get();
  if (!sol) return null;
  const persona = db.select().from(schema.personas).where(eq(schema.personas.id, personaId)).get();
  const local = db.select().from(schema.locales).where(eq(schema.locales.id, sol.localId)).get();
  return { to: local?.email ?? '', persona, local };
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
  const enviado = await sendMail({ to: d.to, subject: `Documentación observada — ${d.persona.nombre} ${d.persona.apellido}`, text: texto });
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
  const enviado = await sendMail({ to: d.to, subject: `Ingreso rechazado — ${d.persona.nombre} ${d.persona.apellido}`, text: texto });
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
  const enviado = await sendMail({ to: local?.email ?? '', subject: `Ingreso autorizado — ${persona.nombre} ${persona.apellido}`, text: texto });
  if (enviado) audit({ accion: 'EMAIL_ENVIADO', entidad: 'autorizacion', entidadId: autorizacionId, detalle: { tipo: 'AUTORIZACION' } });
}
