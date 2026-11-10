import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TelephonyInboundService } from '../../../telephony/credentials/inbound-service.js';
import type { ServiceResult } from '../../../telephony/credentials/credential-service.js';

/*
 * Inbound on a tenant's Plivo credential, for super-admins (docs/inbound.md §8.1, IB6), beside
 * the credential routes and through the same carrier credential service (docs/seams.md §3.4):
 * the credential's Application (enable, disable, health, Re-point) and each synced number's link.
 * The wire contract is `@magick-agency/contracts/api/platform/super-admin-inbound`; refusals are
 * the credential routes' codes and statuses (`sendFailure`). The service audits every write
 * itself (the §8.2 cascade audits from wherever it runs), so these handlers do not.
 *
 * Paths stay literal at each `app.get` / `app.post` (the super-admin UI's route check reads them).
 */

const idParams = z.object({ id: z.string().uuid() });

type Failure = Extract<ServiceResult<unknown>, { ok: false }>;

export function registerSuperAdminInboundRoutes(
  app: FastifyInstance,
  opts: { inbound: () => TelephonyInboundService; sendFailure: (reply: FastifyReply, r: Failure) => FastifyReply },
): void {
  const actor = (request: FastifyRequest) => ({ adminId: request.superAdmin!.id, adminEmail: request.superAdmin!.email });

  /** One handler shape: the `:id` validated (a non-UUID is the resource's 404), the service's result sent. */
  const handle = <T>(notFound: 'Credential not found' | 'Phone number not found', run: (s: TelephonyInboundService, id: string, request: FastifyRequest) => Promise<ServiceResult<T>>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const p = idParams.safeParse(request.params);
      if (!p.success) {
        return reply.code(404).send({ error: notFound === 'Credential not found' ? 'not_found' : 'phone_number_not_found', message: notFound });
      }
      const r = await run(opts.inbound(), p.data.id, request);
      if (!r.ok) return opts.sendFailure(reply, r);
      return reply.send(r.value);
    };

  /** GET /super-admin/telephony-credentials/:id/inbound — the inbound state and the credential's numbers. */
  app.get('/telephony-credentials/:id/inbound', handle('Credential not found', (s, id) => s.state(id)));
  /** POST /super-admin/telephony-credentials/:id/inbound/enable — make (or adopt) the Application. */
  app.post('/telephony-credentials/:id/inbound/enable', handle('Credential not found', (s, id, req) => s.enable(id, actor(req))));
  /** POST /super-admin/telephony-credentials/:id/inbound/disable — delete the Application; refused while numbers are linked. */
  app.post('/telephony-credentials/:id/inbound/disable', handle('Credential not found', (s, id, req) => s.disable(id, actor(req))));
  /** POST /super-admin/telephony-credentials/:id/inbound/repoint — this server's URLs now and a new token. */
  app.post('/telephony-credentials/:id/inbound/repoint', handle('Credential not found', (s, id, req) => s.repoint(id, actor(req))));
  /** GET /super-admin/telephony-credentials/:id/inbound/health — the Application's live URLs against the stored ones. */
  app.get('/telephony-credentials/:id/inbound/health', handle('Credential not found', (s, id) => s.health(id)));

  /** GET /super-admin/phone-numbers/:id/inbound — the number's link, and whether it can be linked. */
  app.get('/phone-numbers/:id/inbound', handle('Phone number not found', (s, id) => s.numberState(id)));
  /** POST /super-admin/phone-numbers/:id/inbound/link — onto its credential's Application (never on sync). */
  app.post('/phone-numbers/:id/inbound/link', handle('Phone number not found', (s, id, req) => s.link(id, actor(req))));
  /** POST /super-admin/phone-numbers/:id/inbound/unlink — back on its previous app; its route detached. */
  app.post('/phone-numbers/:id/inbound/unlink', handle('Phone number not found', (s, id, req) => s.unlink(id, actor(req))));
}
