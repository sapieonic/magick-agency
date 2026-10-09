import type { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { superAdminRepository } from '@magick-agency/db/repositories/super-admin.repository';
import { config } from '../config/index.js';
import { createChildLogger } from '@magick-agency/observability';
import type { SafeSuperAdminRecord } from '@magick-agency/db/models/super-admin.model';

const log = createChildLogger({ component: 'super-admin-middleware' });

declare module 'fastify' {
  interface FastifyRequest {
    superAdmin?: SafeSuperAdminRecord;
  }
}

interface SuperAdminJwtPayload {
  sub: string;
  email: string;
  type: 'super_admin';
}

/**
 * Middleware that verifies super admin JWT and attaches request.superAdmin.
 */
export async function superAdminMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const secret = config.superAdmin?.jwtSecret;
  if (!secret) {
    return reply.code(503).send({ error: 'Service Unavailable', message: 'Super admin not configured' });
  }

  const authHeader = request.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Unauthorized', message: 'Missing Bearer token' });
  }

  const token = authHeader.slice(7);

  let payload: SuperAdminJwtPayload;
  try {
    payload = jwt.verify(token, secret) as SuperAdminJwtPayload;
  } catch {
    return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });
  }

  if (payload.type !== 'super_admin') {
    return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid token type' });
  }

  const admin = await superAdminRepository.findById(payload.sub);
  if (!admin || admin.status !== 'active') {
    return reply.code(401).send({ error: 'Unauthorized', message: 'Admin account not found or inactive' });
  }

  request.superAdmin = admin;
}
