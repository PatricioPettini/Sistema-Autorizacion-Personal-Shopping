import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound, conflict } from '../../lib/errors.js';
import { isAllowedFile } from '../../lib/files.js';
import { saveDocumentVersion } from '../storage/service.js';
import { nowIso } from '../../lib/datetime.js';
import { env } from '../../config/env.js';

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export async function documentosRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.requireAuth);
  // Ver documentación: cualquier usuario autenticado. Modificar/verificar: solo Admin.
  const soloAdmin = { onRequest: app.requireAdmin };

  // Versiones de un documento (historial).
  app.get('/:documentoId/versiones', async (req) => {
    const documentoId = Number((req.params as any).documentoId);
    return db
      .select()
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.documentoId, documentoId))
      .orderBy(desc(schema.documentVersions.version))
      .all();
  });

  // Ver / descargar un archivo de forma protegida (nunca por URL pública directa).
  app.get('/version/:id/archivo', async (req, reply) => {
    const id = Number((req.params as any).id);
    const download = String((req.query as any).download ?? '') === '1';
    const version = db.select().from(schema.documentVersions).where(eq(schema.documentVersions.id, id)).get();
    if (!version) throw notFound('Documento no encontrado.');

    const filePath = version.storedPathNormalized || version.storedPathOriginal;
    if (!filePath || !fs.existsSync(filePath)) throw notFound('El archivo no está disponible en el almacenamiento.');

    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    reply.header('Content-Type', MIME[ext] ?? 'application/octet-stream');
    reply.header(
      'Content-Disposition',
      `${download ? 'attachment' : 'inline'}; filename="${version.normalizedFilename ?? version.originalFilename}"`,
    );
    if (download) {
      audit({ userId: req.user!.id, accion: 'DOCUMENTO_DESCARGADO', entidad: 'document_version', entidadId: id, ip: req.ip });
    }
    return reply.send(fs.createReadStream(filePath));
  });

  // Carga manual de un documento para una persona + tipo.
  app.post('/upload', soloAdmin, async (req) => {
    const parts = req.parts();
    let personaId = 0;
    let tipoDocumentoId = 0;
    let fileBuffer: Buffer | null = null;
    let filename = '';
    let mime = '';

    for await (const part of parts) {
      if (part.type === 'file') {
        filename = part.filename;
        mime = part.mimetype;
        fileBuffer = await part.toBuffer();
      } else {
        if (part.fieldname === 'personaId') personaId = Number(part.value);
        if (part.fieldname === 'tipoDocumentoId') tipoDocumentoId = Number(part.value);
      }
    }

    if (!fileBuffer) throw badRequest('No se recibió ningún archivo.');
    if (!personaId || !tipoDocumentoId) throw badRequest('Faltan datos: persona o tipo de documento.');
    if (fileBuffer.length > env.rules.maxFileMb * 1024 * 1024) throw badRequest('El archivo supera el tamaño máximo permitido.');
    if (!isAllowedFile(filename, mime)) throw badRequest('Formato no permitido. Se aceptan PDF, JPG o PNG.');

    const result = saveDocumentVersion({
      personaId,
      tipoDocumentoId,
      buffer: fileBuffer,
      originalFilename: filename,
      mimeType: mime,
      createdByUserId: req.user!.id,
    });
    return result;
  });

  // --- Verificación manual: Seguridad confirma / rechaza cada documentación ---
  const verificarSchema = z.object({
    personaId: z.number().int(),
    tipoDocumentoId: z.number().int(),
    estado: z.enum(['PENDIENTE', 'VERIFICADO', 'RECHAZADO']),
    // Fecha de vencimiento del documento (solo al aprobar). Vacío = no vence.
    fechaVencimiento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD).').nullable().optional(),
    nota: z.string().optional(),
  });

  app.post('/verificar', soloAdmin, async (req) => {
    const data = verificarSchema.parse(req.body);
    // Busca el documento (persona+tipo); si no existe lo crea para poder marcar el estado.
    let doc = db
      .select()
      .from(schema.documentos)
      .where(and(eq(schema.documentos.personaId, data.personaId), eq(schema.documentos.tipoDocumentoId, data.tipoDocumentoId)))
      .get();
    if (!doc) {
      doc = db.insert(schema.documentos).values({ personaId: data.personaId, tipoDocumentoId: data.tipoDocumentoId }).returning().get();
    }
    db.update(schema.documentos)
      .set({
        verificacion: data.estado,
        verificadoPorUserId: req.user!.id,
        fechaVerificacion: nowIso(),
        // El vencimiento solo aplica cuando se APRUEBA; en otros estados se limpia.
        fechaVencimiento: data.estado === 'VERIFICADO' ? (data.fechaVencimiento ?? null) : null,
        notaVerificacion: data.nota || null,
        updatedAt: nowIso(),
      })
      .where(eq(schema.documentos.id, doc.id))
      .run();
    audit({ userId: req.user!.id, accion: 'DOCUMENTO_VERIFICADO', entidad: 'documento', entidadId: doc.id, detalle: { estado: data.estado, tipoDocumentoId: data.tipoDocumentoId, fechaVencimiento: data.fechaVencimiento ?? null }, ip: req.ip });
    return { ok: true };
  });

  // --- Reclasificar: corregir el tipo que la IA detectó mal ---
  app.post('/:documentoId/reclasificar', soloAdmin, async (req) => {
    const documentoId = Number((req.params as any).documentoId);
    const nuevoTipoId = Number((req.body as any)?.tipoDocumentoId);
    if (!nuevoTipoId) throw badRequest('Falta el tipo de documento destino.');
    const doc = db.select().from(schema.documentos).where(eq(schema.documentos.id, documentoId)).get();
    if (!doc) throw notFound('Documento no encontrado.');
    if (doc.tipoDocumentoId === nuevoTipoId) return { ok: true };
    const conflicto = db
      .select()
      .from(schema.documentos)
      .where(and(eq(schema.documentos.personaId, doc.personaId), eq(schema.documentos.tipoDocumentoId, nuevoTipoId)))
      .get();
    if (conflicto) throw conflict('La persona ya tiene un documento de ese tipo. Verificá o reemplazá ese documento manualmente.');
    db.update(schema.documentos)
      .set({ tipoDocumentoId: nuevoTipoId, verificacion: 'PENDIENTE', updatedAt: nowIso() })
      .where(eq(schema.documentos.id, documentoId))
      .run();
    audit({ userId: req.user!.id, accion: 'DOCUMENTO_RECLASIFICADO', entidad: 'documento', entidadId: documentoId, detalle: { nuevoTipoId }, ip: req.ip });
    return { ok: true };
  });

  // --- Reasignar: corregir la persona a la que la IA asoció el documento ---
  app.post('/:documentoId/reasignar', soloAdmin, async (req) => {
    const documentoId = Number((req.params as any).documentoId);
    const nuevaPersonaId = Number((req.body as any)?.personaId);
    if (!nuevaPersonaId) throw badRequest('Falta la persona destino.');
    const doc = db.select().from(schema.documentos).where(eq(schema.documentos.id, documentoId)).get();
    if (!doc) throw notFound('Documento no encontrado.');
    const persona = db.select().from(schema.personas).where(eq(schema.personas.id, nuevaPersonaId)).get();
    if (!persona) throw notFound('Persona destino no encontrada.');
    if (doc.personaId === nuevaPersonaId) return { ok: true };
    const conflicto = db
      .select()
      .from(schema.documentos)
      .where(and(eq(schema.documentos.personaId, nuevaPersonaId), eq(schema.documentos.tipoDocumentoId, doc.tipoDocumentoId)))
      .get();
    if (conflicto) throw conflict('La persona destino ya tiene un documento de ese tipo.');
    db.update(schema.documentos).set({ personaId: nuevaPersonaId, updatedAt: nowIso() }).where(eq(schema.documentos.id, documentoId)).run();
    audit({ userId: req.user!.id, accion: 'DOCUMENTO_REASIGNADO', entidad: 'documento', entidadId: documentoId, detalle: { nuevaPersonaId }, ip: req.ip });
    return { ok: true };
  });
}
