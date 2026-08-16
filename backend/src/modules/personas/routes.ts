import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, or, like, desc, and, isNull } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { nowIso } from '../../lib/datetime.js';
import { normalizeCuil, formatCuil } from './service.js';
import { getPersonaDocStatus } from '../documentos/service.js';
import { getVigencia } from '../autorizaciones/service.js';
import { analyzePersona } from '../ai/analyzer.js';

const createSchema = z.object({
  cuil: z.string().min(10, 'CUIL inválido.'),
  nombre: z.string().min(1),
  apellido: z.string().min(1),
  categoria: z.enum(['EMPRESA', 'MONOTRIBUTISTA']).nullable().optional(),
  empresa: z.string().optional(),
  notas: z.string().optional(),
});

export async function personasRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.requireAuth);
  const soloAdmin = { onRequest: app.requireAdmin };

  // Búsqueda global por nombre, apellido o DNI.
  app.get('/', async (req) => {
    const q = String((req.query as any).q ?? '').trim();
    let rows;
    if (q) {
      // Búsqueda por palabras: cada palabra debe aparecer en nombre, apellido o CUIL.
      // Así "juan perez" encuentra a "Perez, Juan Carlos" (juan→nombre, perez→apellido).
      const tokens = q.split(/\s+/).filter(Boolean);
      const perToken = tokens.map((tok) => {
        const like_ = `%${tok}%`;
        const digits = tok.replace(/\D/g, '');
        const cs = [like(schema.personas.nombre, like_), like(schema.personas.apellido, like_)];
        if (digits) cs.push(like(schema.personas.cuil, `%${digits}%`));
        return or(...cs);
      });
      rows = db
        .select()
        .from(schema.personas)
        .where(and(...perToken))
        .orderBy(schema.personas.apellido)
        .limit(50)
        .all();
    } else {
      rows = db.select().from(schema.personas).orderBy(desc(schema.personas.createdAt)).limit(50).all();
    }
    return rows.map((p) => ({ ...p, cuilFormat: p.cuil ? formatCuil(p.cuil) : '—' }));
  });

  // Ficha completa de una persona.
  app.get('/:id', async (req) => {
    const id = Number((req.params as any).id);
    const persona = db.select().from(schema.personas).where(eq(schema.personas.id, id)).get();
    if (!persona) throw notFound('Persona no encontrada.');

    const docStatus = getPersonaDocStatus(id);
    const analisis = analyzePersona(id);

    const autorizaciones = db
      .select({
        id: schema.autorizaciones.id,
        localId: schema.autorizaciones.localId,
        local: schema.locales.nombre,
        fecha: schema.autorizaciones.fecha,
        fechaHasta: schema.autorizaciones.fechaHasta,
        horaDesde: schema.autorizaciones.horaDesde,
        horaHasta: schema.autorizaciones.horaHasta,
        estado: schema.autorizaciones.estado,
        fechaDecision: schema.autorizaciones.fechaDecision,
      })
      .from(schema.autorizaciones)
      .innerJoin(schema.locales, eq(schema.autorizaciones.localId, schema.locales.id))
      .where(eq(schema.autorizaciones.personaId, id))
      .orderBy(desc(schema.autorizaciones.fechaDecision))
      .all();

    const ingresos = db
      .select({
        id: schema.entradas.id,
        local: schema.locales.nombre,
        ingreso: schema.entradas.fechaHoraIngreso,
        salida: schema.entradas.fechaHoraSalida,
      })
      .from(schema.entradas)
      .innerJoin(schema.locales, eq(schema.entradas.localId, schema.locales.id))
      .where(eq(schema.entradas.personaId, id))
      .orderBy(desc(schema.entradas.fechaHoraIngreso))
      .limit(50)
      .all();

    // Estado de habilitación de ingreso (para la ficha unificada: consultar + registrar).
    const vig = getVigencia(id);
    const local = vig.autorizacion
      ? db.select().from(schema.locales).where(eq(schema.locales.id, vig.autorizacion.localId)).get() ?? null
      : null;
    const ingresoAbierto = db
      .select()
      .from(schema.entradas)
      .where(and(eq(schema.entradas.personaId, id), isNull(schema.entradas.fechaHoraSalida)))
      .get() ?? null;

    return {
      persona: { ...persona, cuilFormat: persona.cuil ? formatCuil(persona.cuil) : '—' },
      docStatus,
      analisis,
      autorizaciones,
      ingresos,
      vigencia: vig.estado,
      autorizacionVigente: vig.autorizacion,
      localVigente: local,
      ingresoAbierto,
    };
  });

  app.post('/', soloAdmin, async (req) => {
    const data = createSchema.parse(req.body);
    const cuil = normalizeCuil(data.cuil);
    const persona = db
      .insert(schema.personas)
      .values({ cuil, dni: cuil, nombre: data.nombre.trim(), apellido: data.apellido.trim(), notas: data.notas || null })
      .returning()
      .get();
    audit({ userId: req.user!.id, accion: 'PERSONA_CREADA', entidad: 'persona', entidadId: persona.id, ip: req.ip });
    return { ...persona, cuilFormat: formatCuil(cuil) };
  });

  app.patch('/:id', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const data = createSchema.partial().parse(req.body);
    const existing = db.select().from(schema.personas).where(eq(schema.personas.id, id)).get();
    if (!existing) throw notFound('Persona no encontrada.');
    const nuevoCuil = data.cuil ? normalizeCuil(data.cuil) : existing.cuil;
    db.update(schema.personas)
      .set({
        cuil: nuevoCuil,
        dni: nuevoCuil ?? existing.dni,
        nombre: data.nombre ?? existing.nombre,
        apellido: data.apellido ?? existing.apellido,
        categoria: data.categoria !== undefined ? data.categoria : existing.categoria,
        empresa: data.empresa !== undefined ? data.empresa || null : existing.empresa,
        notas: data.notas !== undefined ? data.notas || null : existing.notas,
        updatedAt: nowIso(),
      })
      .where(eq(schema.personas.id, id))
      .run();
    audit({ userId: req.user!.id, accion: 'PERSONA_MODIFICADA', entidad: 'persona', entidadId: id, ip: req.ip });
    return { ok: true };
  });
}
