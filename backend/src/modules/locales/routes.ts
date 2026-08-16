import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { nowIso } from '../../lib/datetime.js';

const localeSchema = z.object({
  nombre: z.string().min(1, 'Ingresá el nombre del local.'),
  email: z.string().email('Email inválido.').optional().or(z.literal('')),
  estado: z.enum(['ACTIVO', 'INACTIVO']).default('ACTIVO'),
  observaciones: z.string().optional(),
});

export async function localesRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.requireAuth);

  app.get('/', async () => db.select().from(schema.locales).orderBy(desc(schema.locales.estado), schema.locales.nombre).all());

  app.get('/:id', async (req) => {
    const id = Number((req.params as any).id);
    const row = db.select().from(schema.locales).where(eq(schema.locales.id, id)).get();
    if (!row) throw notFound('Local no encontrado.');
    return row;
  });

  app.post('/', async (req) => {
    await app.requireAdmin(req, undefined as any);
    const data = localeSchema.parse(req.body);
    const row = db
      .insert(schema.locales)
      .values({ nombre: data.nombre, email: data.email || null, estado: data.estado, observaciones: data.observaciones || null })
      .returning()
      .get();
    audit({ userId: req.user!.id, accion: 'LOCAL_CREADO', entidad: 'local', entidadId: row.id, detalle: { nombre: row.nombre }, ip: req.ip });
    return row;
  });

  app.patch('/:id', async (req) => {
    await app.requireAdmin(req, undefined as any);
    const id = Number((req.params as any).id);
    const data = localeSchema.partial().parse(req.body);
    const existing = db.select().from(schema.locales).where(eq(schema.locales.id, id)).get();
    if (!existing) throw notFound('Local no encontrado.');
    db.update(schema.locales)
      .set({
        nombre: data.nombre ?? existing.nombre,
        email: data.email !== undefined ? data.email || null : existing.email,
        estado: data.estado ?? existing.estado,
        observaciones: data.observaciones !== undefined ? data.observaciones || null : existing.observaciones,
        updatedAt: nowIso(),
      })
      .where(eq(schema.locales.id, id))
      .run();
    audit({ userId: req.user!.id, accion: 'LOCAL_MODIFICADO', entidad: 'local', entidadId: id, ip: req.ip });
    return { ok: true };
  });
}
