// Service-to-service endpoints. No user session: these are called by the
// Container Management Service (or the deployment worker itself), authenticated
// with the shared internal secret.
//
// Mounted at /api/v1/internal. Keep this surface minimal — it bypasses the
// per-user ownership checks that every other route relies on, so each handler
// must be safe to call with only a deployment id.
import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { internalApiKey } from '../../config/env.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { recordWorkerStatus } from '../deployments/service.js';

function requireInternalKey(req, res, next) {
  if (!internalApiKey) {
    return res.status(501).json({
      error: {
        code: 'INTERNAL_API_NOT_CONFIGURED',
        message: 'Set INTERNAL_API_KEY (or CMS_INTERNAL_KEY) in mern_backend/.env to enable '
          + 'service-to-service callbacks.',
      },
    });
  }
  const provided = req.get('X-Internal-Key') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(internalApiKey);
  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    return res.status(403).json({
      error: { code: 'INVALID_INTERNAL_KEY', message: 'Internal key rejected' },
    });
  }
  return next();
}

// Mirrors the deployments.status CHECK constraint.
const statusSchema = z.object({
  status: z.enum([
    'queued', 'validating', 'building', 'deploying',
    'healthy', 'failed', 'cancelled', 'rolling_back', 'rolled_back',
  ]),
  containerId: z.string().max(255).optional(),
  container_id: z.string().max(255).optional(),
  imageId: z.string().max(255).optional(),
  image_id: z.string().max(255).optional(),
  deploymentUrl: z.string().max(2048).optional(),
  deployment_url: z.string().max(2048).optional(),
  error: z.string().max(2000).optional(),
}).strict().transform((v) => ({
  status: v.status,
  containerId: v.containerId ?? v.container_id,
  imageId: v.imageId ?? v.image_id,
  deploymentUrl: v.deploymentUrl ?? v.deployment_url,
  error: v.error,
}));

const router = Router();
router.use(requireInternalKey);

router.get('/health', (_req, res) => res.json({ status: 'ok', scope: 'internal' }));

/**
 * The worker reports a deployment's progress here (CMS relays it when
 * CONTROL_PLANE_URL is set). This is what moves a container deployment off
 * `queued` and records its container_id, which later deploys need in order to
 * supersede it and which service deletion needs in order to tear it down.
 */
router.post(
  '/deployments/:deploymentId/status',
  validate(statusSchema),
  asyncHandler(async (req, res) => {
    const result = await recordWorkerStatus(req.params.deploymentId, req.body);
    res.json(result);
  })
);

export default router;
