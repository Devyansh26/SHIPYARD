import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import {
  triggerDeployment, listDeployments, getDeployment, getDeploymentLogs, cancelDeployment,
  getLatestCommit,
} from './service.js';

const triggerSchema = z.object({
  // Defaults to the service's configured branch, then the repo default.
  branch: z.string().min(1).max(255).optional(),
  target: z.enum(['production', 'preview']).optional(),
}).strict();

// Mounted at /api/v1/projects/:projectId/services/:serviceId/deployments
export const serviceDeploymentRoutes = Router({ mergeParams: true });
serviceDeploymentRoutes.use(requireAuth);

serviceDeploymentRoutes.post('/', validate(triggerSchema), asyncHandler(async (req, res) => {
  const deployment = await triggerDeployment(
    req.userId, req.params.projectId, req.params.serviceId, req.body
  );
  res.status(201).json({ deployment });
}));

serviceDeploymentRoutes.get('/', asyncHandler(async (req, res) => {
  const deployments = await listDeployments(req.userId, req.params.projectId, req.params.serviceId);
  res.json({ deployments, total: deployments.length });
}));

/**
 * The branch HEAD, and whether it is already deployed. Declared before any
 * `/:param` route on this router so "latest-commit" cannot be captured as an id.
 *
 * Deliberately a separate request from the deployment list: it hits GitHub, so
 * folding it into the list would put a third-party API on the 3s poll that
 * follows a build.
 */
serviceDeploymentRoutes.get('/latest-commit', asyncHandler(async (req, res) => {
  res.json({
    commit: await getLatestCommit(req.userId, req.params.projectId, req.params.serviceId),
  });
}));

// Mounted at /api/v1/deployments — a deployment id is globally unique, so these
// do not need the project/service path.
export const deploymentRoutes = Router();
deploymentRoutes.use(requireAuth);

deploymentRoutes.get('/:deploymentId', asyncHandler(async (req, res) => {
  res.json({ deployment: await getDeployment(req.userId, req.params.deploymentId) });
}));

deploymentRoutes.get('/:deploymentId/logs', asyncHandler(async (req, res) => {
  res.json(await getDeploymentLogs(req.userId, req.params.deploymentId));
}));

deploymentRoutes.post('/:deploymentId/cancel', asyncHandler(async (req, res) => {
  res.json({ deployment: await cancelDeployment(req.userId, req.params.deploymentId) });
}));
