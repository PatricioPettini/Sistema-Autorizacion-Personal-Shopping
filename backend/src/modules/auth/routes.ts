import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { verifyPassword } from '../../lib/password.js';
import { createSession, destroySession, SESSION_COOKIE } from '../../lib/session.js';
import { unauthorized } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { nowIso } from '../../lib/datetime.js';
import { env } from '../../config/env.js';

const loginSchema = z.object({
  email: z.string().email('Email inválido.'),
  password: z.string().min(1, 'Ingresá la contraseña.'),
});

export async function authRoutes(app: FastifyInstance) {
  app.post('/login', async (req, reply) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = db.select().from(schema.users).where(eq(schema.users.email, email.toLowerCase())).get();
    if (!user || !user.activo || !(await verifyPassword(password, user.passwordHash))) {
      throw unauthorized('Email o contraseña incorrectos.');
    }
    const token = createSession(user.id, req.ip, req.headers['user-agent']);
    db.update(schema.users).set({ lastLoginAt: nowIso() }).where(eq(schema.users.id, user.id)).run();
    audit({ userId: user.id, accion: 'LOGIN', entidad: 'user', entidadId: user.id, ip: req.ip });

    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.isProd,
      path: '/',
      maxAge: 12 * 3600,
    });
    return { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol };
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (req.user) audit({ userId: req.user.id, accion: 'LOGOUT', entidad: 'user', entidadId: req.user.id, ip: req.ip });
    destroySession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', async (req) => {
    if (!req.user) return { user: null };
    return { user: req.user };
  });
}
