import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { AppError } from './lib/errors.js';
import authPlugin from './plugins/auth.js';

import { authRoutes } from './modules/auth/routes.js';
import { usersRoutes } from './modules/users/routes.js';
import { localesRoutes } from './modules/locales/routes.js';
import { personasRoutes } from './modules/personas/routes.js';
import { documentTypesRoutes } from './modules/documentos/typesRoutes.js';
import { documentosRoutes } from './modules/documentos/routes.js';
import { emailsRoutes } from './modules/emails/routes.js';
import { solicitudesRoutes } from './modules/solicitudes/routes.js';
import { autorizacionesRoutes } from './modules/autorizaciones/routes.js';
import { ingresosRoutes } from './modules/ingresos/routes.js';
import { dashboardRoutes } from './modules/dashboard/routes.js';
import { reportesRoutes } from './modules/reportes/routes.js';
import { auditRoutes } from './modules/audit/routes.js';
import { setupRoutes } from './modules/setup/routes.js';
import { configRoutes } from './modules/config/routes.js';

export async function buildServer() {
  const app = Fastify({ loggerInstance: logger, bodyLimit: (env.rules.maxFileMb + 5) * 1024 * 1024 });

  await app.register(cookie, { secret: env.sessionSecret });
  await app.register(multipart, {
    limits: { fileSize: env.rules.maxFileMb * 1024 * 1024, files: 20 },
  });
  await app.register(authPlugin);

  // Manejo de errores: mensajes claros al usuario, detalle técnico solo en logs.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: err.publicMessage });
    }
    if (err instanceof ZodError) {
      const first = err.errors[0];
      if (!first) return reply.status(400).send({ error: 'Datos inválidos.' });
      // Las validaciones a nivel objeto (refine) no tienen path: sin prefijo quedan legibles.
      const campo = first.path.join('.');
      return reply.status(400).send({ error: campo ? `${campo}: ${first.message}` : first.message });
    }
    // Errores de UNIQUE de SQLite, etc.
    const msg = (err as Error)?.message;
    if (typeof msg === 'string' && msg.includes('UNIQUE constraint failed')) {
      return reply.status(409).send({ error: 'Ya existe un registro con esos datos.' });
    }
    req.log.error({ err }, 'Error no controlado');
    return reply.status(500).send({ error: 'Ocurrió un error inesperado. Se registró para revisión.' });
  });

  // Rutas de API
  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(setupRoutes, { prefix: '/setup' });
      await api.register(usersRoutes, { prefix: '/usuarios' });
      await api.register(localesRoutes, { prefix: '/locales' });
      await api.register(personasRoutes, { prefix: '/personas' });
      await api.register(documentTypesRoutes, { prefix: '/tipos-documento' });
      await api.register(documentosRoutes, { prefix: '/documentos' });
      await api.register(emailsRoutes, { prefix: '/emails' });
      await api.register(solicitudesRoutes, { prefix: '/solicitudes' });
      await api.register(autorizacionesRoutes, { prefix: '/autorizaciones' });
      await api.register(ingresosRoutes, { prefix: '/ingresos' });
      await api.register(dashboardRoutes, { prefix: '/dashboard' });
      await api.register(reportesRoutes, { prefix: '/reportes' });
      await api.register(auditRoutes, { prefix: '/auditoria' });
      await api.register(configRoutes, { prefix: '/config' });
    },
    { prefix: '/api' },
  );

  app.get('/api/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  // Servir el frontend compilado (producción)
  const frontendDist = path.join(env.projectRoot, 'frontend', 'dist');
  if (fs.existsSync(frontendDist)) {
    await app.register(fastifyStatic, { root: frontendDist, prefix: '/' });
    // SPA fallback
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) {
        return reply.status(404).send({ error: 'Ruta no encontrada.' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
