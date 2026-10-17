import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { SERVICE_TYPES } from './serviceTypes.js';
import { listServices, createService, getService, updateService, deleteService, updateServiceCanvas } from './repository.js';

// NOT NULL in the schema: service_name, service_type, repository, branch,
// root_directory, service_config. Those can never be patched to null.
// Nullable: provider_connection_id, build_command, pre_deploy_command, start_command.
const CAMEL_TO_SNAKE = {
  name: 'service_name',
  serviceType: 'service_type',
  rootDirectory: 'root_directory',
  buildCommand: 'build_command',
  preDeployCommand: 'pre_deploy_command',
  startCommand: 'start_command',
  serviceConfig: 'service_config',
  providerConnectionId: 'provider_connection_id',
};

// Accept snake_case aliases too (DB is snake_case, API prefers camelCase).
function withAliases(shape) {
  const full = { ...shape };
  for (const [camel, snake] of Object.entries(CAMEL_TO_SNAKE)) {
    if (camel in shape) full[snake] = shape[camel];
  }
  return z.object(full).strict().transform((v) => {
    const out = {};
    for (const camel of Object.keys(shape)) {
      const snake = CAMEL_TO_SNAKE[camel];
      out[camel] = v[camel] !== undefined ? v[camel] : (snake ? v[snake] : undefined);
    }
    return out;
  });
}

const createShape = {
  name: z.string().min(2).max(64).optional(),
  serviceType: z.enum(SERVICE_TYPES).optional(),
  repository: z.string().min(1).max(255).optional(),
  branch: z.string().min(1).max(255).optional(),
  rootDirectory: z.string().min(1).max(255).optional(),
  buildCommand: z.string().max(512).optional(),
  preDeployCommand: z.string().max(512).optional(),
  startCommand: z.string().max(512).optional(),
  serviceConfig: z.record(z.unknown()).optional(),
  providerConnectionId: z.union([z.string(), z.number()]).optional(),
};

const createSchema = withAliases(createShape)
  .refine((v) => !!v.name, { message: 'Required', path: ['name'] })
  .refine((v) => !!v.serviceType, {
    message: `Required — one of ${SERVICE_TYPES.join(', ')}`,
    path: ['serviceType'],
  })
  .refine((v) => !!v.repository, { message: 'Required (repository is NOT NULL)', path: ['repository'] });

const patchSchema = withAliases({
  name: z.string().min(2).max(64).optional(),
  serviceType: z.enum(SERVICE_TYPES).optional(),
  repository: z.string().min(1).max(255).optional(),
  branch: z.string().min(1).max(255).optional(),
  rootDirectory: z.string().min(1).max(255).optional(),
  buildCommand: z.string().max(512).nullable().optional(),
  preDeployCommand: z.string().max(512).nullable().optional(),
  startCommand: z.string().max(512).nullable().optional(),
  serviceConfig: z.record(z.unknown()).optional(),
  providerConnectionId: z.union([z.string(), z.number()]).nullable().optional(),
});

const router = Router({ mergeParams: true });
router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => {
  res.json({ services: await listServices(req.userId, req.params.projectId) });
}));

router.post('/', validate(createSchema), asyncHandler(async (req, res) => {
  const service = await createService(req.userId, req.params.projectId, req.body);
  res.status(201).json({ service });
}));

router.get('/:serviceId', asyncHandler(async (req, res) => {
  res.json({ service: await getService(req.userId, req.params.projectId, req.params.serviceId) });
}));

router.patch('/:serviceId', validate(patchSchema), asyncHandler(async (req, res) => {
  res.json({ service: await updateService(req.userId, req.params.projectId, req.params.serviceId, req.body) });
}));

// Canvas layout is its own endpoint rather than a serviceConfig PATCH: the
// graph editor saves on every drag, and a merge keeps it from touching
// provider settings that live in the same JSONB column.
const canvasSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  dependsOn: z.array(z.string().max(64)).max(32).optional(),
}).strict();

router.patch('/:serviceId/canvas', validate(canvasSchema), asyncHandler(async (req, res) => {
  const service = await updateServiceCanvas(
    req.userId, req.params.projectId, req.params.serviceId, req.body
  );
  res.json({ service });
}));

router.delete('/:serviceId', asyncHandler(async (req, res) => {
  await deleteService(req.userId, req.params.projectId, req.params.serviceId);
  res.status(204).send();
}));

export default router;
