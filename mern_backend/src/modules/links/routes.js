// Service links for one service.
//
// Mounted at /api/v1/projects/:projectId/services/:serviceId/links, where
// :serviceId is the CONSUMER — the backend (or frontend) that reads the
// variable. The provider is named in the body/path, which keeps the ownership
// check identical to every other nested service route.
//
// All the logic lives in ./service.js; these handlers stay thin and hold no SQL.
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { SCOPES } from '../envvars/repository.js';
import { createLink, listLinks, removeLink, resyncLinksForProvider } from './service.js';

const router = Router({ mergeParams: true });
router.use(requireAuth);

const createSchema = z.object({
  // The node being linked TO: a database, or a deployed backend/frontend whose
  // URL is wanted. `databaseServiceId` is the original name of this field and
  // still accepted so an older client keeps working.
  providerServiceId: z.string().min(1).max(64).optional(),
  databaseServiceId: z.string().min(1).max(64).optional(),
  // Optional: falls back to the provider's default (DATABASE_URL / MONGODB_URI
  // for a database, API_URL for a service). Validated as an env key in the
  // service so the error message matches the one the env routes give.
  varName: z.string().min(1).max(255).optional(),
  scope: z.enum(SCOPES).optional(),
}).strict().refine(
  (b) => Boolean(b.providerServiceId ?? b.databaseServiceId),
  { message: 'providerServiceId is required', path: ['providerServiceId'] },
);

router.get('/', asyncHandler(async (req, res) => {
  const links = await listLinks(req.userId, req.params.projectId, req.params.serviceId);
  res.json({ links, total: links.length });
}));

/**
 * Wire this service to a provider node.
 *
 * Idempotent on (service, provider): POSTing again refreshes the value, and
 * POSTing with a different `varName` renames the variable. That is what lets the
 * canvas call it on every edge creation without tracking whether a link exists.
 */
router.post('/', validate(createSchema), asyncHandler(async (req, res) => {
  const result = await createLink(
    req.userId, req.params.projectId, req.params.serviceId, req.body
  );
  res.status(result.created ? 201 : 200).json(result);
}));

/**
 * Unwire it. The injected variable is deleted too, because removing the edge is
 * an explicit statement that this service no longer uses that database.
 * `?keepVar=1` keeps the row — for when the user has since edited it by hand.
 */
router.delete('/:providerServiceId', asyncHandler(async (req, res) => {
  const result = await removeLink(
    req.userId, req.params.projectId, req.params.serviceId, req.params.providerServiceId,
    { keepVar: req.query.keepVar === '1' || req.query.keepVar === 'true' }
  );
  res.json(result);
}));

/**
 * Re-reads this node's current value and pushes it to every service linked to
 * it. Here `:serviceId` is the PROVIDER, not the consumer — it answers "my URL
 * moved, update everyone who reads it", which is the one direction the normal
 * routes cannot express.
 *
 * Deploys do this automatically for the service being deployed (see
 * `refreshUrlLinks`); this is the manual lever for the panel.
 */
router.post('/resync', asyncHandler(async (req, res) => {
  const result = await resyncLinksForProvider(
    req.userId, req.params.projectId, req.params.serviceId
  );
  res.json(result);
}));

export default router;
