import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, or, like, isNull, desc } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { nowIso } from '../../lib/datetime.js';
import { formatCuil, findPersonaByCuil } from '../personas/service.js';
import { getVigencia } from '../autorizaciones/service.js';
import { getPersonaDocStatus } from '../documentos/service.js';

const ingresoSchema = z.object({ personaId: z.number().int(), localId: z.number().int() });

export async function ingresosRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.requireAuth);

  // Consulta rápida para Seguridad: "¿Esta persona puede entrar?"
  app.get('/consulta', async (req) => {
    const q = String((req.query as any).q ?? '').trim();
    if (!q) throw badRequest('Ingresá un DNI o nombre.');
    // Buscar por DNI; si no, por nombre o apellido (LIKE, insensible a mayúsculas).
    let persona = findPersonaByCuil(q);
    if (!persona) {
      const likeQ = `%${q}%`;
      persona = db
        .select()
        .from(schema.personas)
        .where(or(like(schema.personas.nombre, likeQ), like(schema.personas.apellido, likeQ)))
        .orderBy(schema.personas.apellido)
        .get() ?? null;
    }
    if (!persona) return { encontrada: false };
    const vig = getVigencia(persona.id);
    const docStatus = getPersonaDocStatus(persona.id);
    const abierto = db
      .select()
      .from(schema.entradas)
      .where(and(eq(schema.entradas.personaId, persona.id), isNull(schema.entradas.fechaHoraSalida)))
      .get();
    const local = vig.autorizacion ? db.select().from(schema.locales).where(eq(schema.locales.id, vig.autorizacion.localId)).get() : null;
    return {
      encontrada: true,
      persona: { ...persona, cuilFormat: persona.cuil ? formatCuil(persona.cuil) : '—' },
      vigencia: vig.estado,
      autorizacion: vig.autorizacion,
      local,
      docStatus,
      ingresoAbierto: abierto ?? null,
    };
  });

  // Personas actualmente dentro (ingresaron y no registraron salida).
  app.get('/dentro', async () => {
    return db
      .select({
        id: schema.entradas.id,
        personaId: schema.personas.id,
        nombre: schema.personas.nombre,
        apellido: schema.personas.apellido,
        dni: schema.personas.dni,
        local: schema.locales.nombre,
        ingreso: schema.entradas.fechaHoraIngreso,
      })
      .from(schema.entradas)
      .innerJoin(schema.personas, eq(schema.entradas.personaId, schema.personas.id))
      .innerJoin(schema.locales, eq(schema.entradas.localId, schema.locales.id))
      .where(isNull(schema.entradas.fechaHoraSalida))
      .orderBy(desc(schema.entradas.fechaHoraIngreso))
      .all();
  });

  // Registrar ingreso (requiere autorización vigente).
  app.post('/', async (req) => {
    const data = ingresoSchema.parse(req.body);
    const vig = getVigencia(data.personaId, data.localId);
    if (vig.estado !== 'AUTORIZADO') {
      throw badRequest('La persona no tiene una autorización vigente para hoy en este local. No se puede registrar el ingreso.');
    }
    // La documentación vencida bloquea el ingreso hasta que se renueve.
    const ds = getPersonaDocStatus(data.personaId);
    if (ds.vencidos.length > 0) {
      throw badRequest(`Tiene documentación vencida: ${ds.vencidos.join(', ')}. No puede ingresar hasta renovarla.`);
    }
    const abierto = db
      .select()
      .from(schema.entradas)
      .where(and(eq(schema.entradas.personaId, data.personaId), isNull(schema.entradas.fechaHoraSalida)))
      .get();
    if (abierto) throw badRequest('La persona ya tiene un ingreso abierto sin salida registrada.');

    const entrada = db
      .insert(schema.entradas)
      .values({ personaId: data.personaId, localId: data.localId, autorizacionId: vig.autorizacion?.id ?? null, ingresoPorUserId: req.user!.id })
      .returning()
      .get();
    audit({ userId: req.user!.id, accion: 'INGRESO_REGISTRADO', entidad: 'entrada', entidadId: entrada.id, ip: req.ip });
    return entrada;
  });

  // Registrar salida.
  app.post('/:id/salida', async (req) => {
    const id = Number((req.params as any).id);
    const entrada = db.select().from(schema.entradas).where(eq(schema.entradas.id, id)).get();
    if (!entrada) throw notFound('Ingreso no encontrado.');
    if (entrada.fechaHoraSalida) throw badRequest('La salida ya fue registrada.');
    db.update(schema.entradas).set({ fechaHoraSalida: nowIso(), salidaPorUserId: req.user!.id }).where(eq(schema.entradas.id, id)).run();
    audit({ userId: req.user!.id, accion: 'SALIDA_REGISTRADA', entidad: 'entrada', entidadId: id, ip: req.ip });
    return { ok: true };
  });
}
