/*
 * `POST /super-admin/login`, registered outside the authenticated scope. Part of
 * `super-admin.routes.ts`.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../../../config/index.js';
import { superAdminRepository } from '@magick-agency/db/repositories/super-admin.repository';
import { superAdminLoginSchema } from '../../validators/super-admin.validator.js';
import { parseOr400 } from '../helpers/parse-or-400.js';

const JWT_EXPIRY = '4h';

/** Registered by `superAdminRoutes` on its own instance, before the authenticated scope. */
export async function registerSuperAdminLoginRoute(app: FastifyInstance): Promise<void> {
  /**
   * POST /super-admin/login
   * Email + password → JWT (4h expiry). Rate limited separately: 5/minute per IP.
   *
   * The key is pinned here, not inherited. A per-route `rateLimit` inherits the app-scope
   * limiter's `keyGenerator`, which keys a request carrying `Authorization: Bearer` as
   * `ipa:<ip>` and one without as `<ip>` (the `ip_auth` split, Q9): two counters, so
   * alternating a bogus bearer with none would double the brute-force budget to 10. One
   * key per IP whatever the headers, in its own namespace.
   */
  app.post('/login', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
        keyGenerator: (request: FastifyRequest) => `sal:${request.ip}`,
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const secret = config.superAdmin?.jwtSecret;
    if (!secret) {
      return reply.code(503).send({ error: 'Service Unavailable', message: 'Super admin not configured' });
    }

    const parsed = parseOr400(superAdminLoginSchema, request.body, reply, 'platform');
    if (!parsed) return reply;

    const { email, password } = parsed.data;
    const admin = await superAdminRepository.findByEmail(email);
    if (!admin) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid credentials' });
    }

    if (admin.status !== 'active') {
      return reply.code(403).send({ error: 'Forbidden', message: 'Account is inactive' });
    }

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { sub: admin.id, email: admin.email, type: 'super_admin' },
      secret,
      { expiresIn: JWT_EXPIRY },
    );

    return reply.send({
      token,
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
      },
    });
  });
}
