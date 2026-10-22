import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { KEY_RE, parseDotenv } from './dotenv.js';
import {
  SCOPES, listEnvVars, createEnvVar, upsertEnvVar, updateEnvVar,
  deleteEnvVar, revealEnvVar, assertOwnedService,
} from './repository.js';
import { removeProviderEnv } from '../deployments/service.js';

const keyField = z.string().min(1).max(255).regex(
  KEY_RE,
  'must start with a letter or _ and contain only letters, digits and _',
);

const createSchema = z.object({
  key: keyField,
  value: z.string().max(65_536),
  // Default true: assume a value is a secret unless the user says otherwise.
  sensitive: z.boolean().optional(),
  scope: z.enum(SCOPES).optional(),
}).strict();

const patchSchema = z.object({
  key: keyField.optional(),
  value: z.string().max(65_536).optional(),
  sensitive: z.boolean().optional(),
  scope: z.enum(SCOPES).optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

const importSchema = z.object({
  content: z.string().max(256_000),
  sensitive: z.boolean().optional(),
  scope: z.enum(SCOPES).optional(),
}).strict();

// Mounted at /api/v1/projects/:projectId/services/:serviceId/env
const router = Router({ mergeParams: true });
router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => {
  const vars = await listEnvVars(req.userId, req.params.projectId, req.params.serviceId);
  res.json({ vars, total: vars.length });
}));

router.post('/', validate(createSchema), asyncHandler(async (req, res) => {
  const variable = await createEnvVar(
    req.userId, req.params.projectId, req.params.serviceId, req.body,
  );
  res.status(201).json({ var: variable });
}));

// Bulk paste of a .env file. Upserts, so re-importing an edited file updates
// the existing rows rather than failing on the unique constraint.
router.post('/import', validate(importSchema), asyncHandler(async (req, res) => {
  const { projectId, serviceId } = req.params;
  await assertOwnedService(req.userId, projectId, serviceId);
  const { vars, skipped } = parseDotenv(req.body.content);
  if (vars.length === 0) {
    return res.status(400).json({
      error: {
        code: 'ENV_IMPORT_EMPTY',
        message: skipped.length > 0
          ? `No usable KEY=value lines found; ${skipped.length} line(s) were rejected.`
          : 'No KEY=value lines found in that content.',
      },
    });
  }
  const imported = [];
  for (const v of vars) {
    imported.push(await upsertEnvVar(serviceId, {
      ...v,
      // Applies to NEW keys only — an existing key keeps the classification
      // the user already chose (see upsertEnvVar).
      sensitive: req.body.sensitive ?? true,
      scope: req.body.scope ?? 'all',
    }));
  }
  res.status(201).json({
    vars: imported.map(({ created: _c, ...v }) => v),
    created: imported.filter((v) => v.created).length,
    updated: imported.filter((v) => !v.created).length,
    skipped,
  });
}));

// Decrypting is the one operation that returns plaintext, so it gets its own
// tighter rate limit on top of the global auth limiter.
const revealLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

router.get('/:varId/reveal', revealLimiter, asyncHandler(async (req, res) => {
  const revealed = await revealEnvVar(
    req.userId, req.params.projectId, req.params.serviceId, req.params.varId,
  );
  // Never let a proxy or the browser keep a copy of a decrypted secret.
  res.set('Cache-Control', 'no-store, max-age=0');
  res.json({ var: revealed });
}));

router.patch('/:varId', validate(patchSchema), asyncHandler(async (req, res) => {
  const variable = await updateEnvVar(
    req.userId, req.params.projectId, req.params.serviceId, req.params.varId, req.body,
  );
  res.json({ var: variable });
}));

router.delete('/:varId', asyncHandler(async (req, res) => {
  const { projectId, serviceId, varId } = req.params;
  const removed = await deleteEnvVar(req.userId, projectId, serviceId, varId);
  // Best-effort: also drop it from the provider so the next deploy does not
  // resurrect a variable the user just deleted. A provider failure here must
  // not fail the delete — our row is already gone, which is what was asked.
  const provider = await removeProviderEnv(req.userId, serviceId, removed.key).catch(() => null);
  res.json({ deleted: removed, provider });
}));

export default router;
