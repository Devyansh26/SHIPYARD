import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { query } from './db/pool.js';
import { errorHandler, notFound } from './middleware/error.js';
import { asyncHandler } from './utils/asyncHandler.js';
import authRoutes from './modules/auth/routes.js';
import projectRoutes from './modules/projects/routes.js';
import serviceRoutes from './modules/services/routes.js';
import connectionRoutes from './modules/connections/routes.js';
import renderConnectionRoutes from './modules/render/routes.js';
import railwayConnectionRoutes from './modules/railway/routes.js';
import cloudflareConnectionRoutes from './modules/cloudflare/routes.js';
import deployTargetRoutes from './modules/targets/routes.js';
import { serviceDeploymentRoutes, deploymentRoutes } from './modules/deployments/routes.js';
import envVarRoutes from './modules/envvars/routes.js';
import databaseRoutes from './modules/database/routes.js';
import linkRoutes from './modules/links/routes.js';
import internalRoutes from './modules/internal/routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use('/api/v1/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 120, standardHeaders: 'draft-7', legacyHeaders: false }));

  app.get('/api/v1/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/v1/ready', asyncHandler(async (_req, res) => {
    await query('SELECT 1');
    res.json({ status: 'ready' });
  }));

  app.use('/api/v1/auth', authRoutes);
  // Provider connections (Vercel OAuth / access token). Mounted before the
  // project tree because connecting is a prerequisite for deploying.
  // Render, Railway and Cloudflare each keep their own router so the whole
  // integration lives in its own module folder. Mounted BEFORE the shared
  // connections router: they all answer under /api/v1/connections, and these
  // own the /render, /railway and /cloudflare subtrees.
  app.use('/api/v1/connections/render', renderConnectionRoutes);
  app.use('/api/v1/connections/railway', railwayConnectionRoutes);
  app.use('/api/v1/connections/cloudflare', cloudflareConnectionRoutes);
  app.use('/api/v1/connections', connectionRoutes);
  // `/integrations` is an alias of `/connections` kept from the Azure branch —
  // same router, so either path works and neither client needs changing.
  app.use('/api/v1/integrations', connectionRoutes);
  // Which targets a service type may deploy to, and whether this user can use
  // each one. Drives the target picker, so the frontend holds no provider list.
  app.use('/api/v1/deploy-targets', deployTargetRoutes);
  app.use('/api/v1/projects', projectRoutes);
  // Nested services: /api/v1/projects/:projectId/services
  app.use('/api/v1/projects/:projectId/services', serviceRoutes);
  // Deployments: nested for create/list, flat for read/logs/cancel.
  app.use('/api/v1/projects/:projectId/services/:serviceId/deployments', serviceDeploymentRoutes);
  // Environment variables: encrypted at rest, pushed to the provider on deploy.
  app.use('/api/v1/projects/:projectId/services/:serviceId/env', envVarRoutes);
  // The connection string behind a `database` node (Neon / MongoDB Atlas).
  app.use('/api/v1/projects/:projectId/services/:serviceId/database', databaseRoutes);
  // Database bindings: wiring a backend to a database node injects its
  // connection string as an environment variable on the backend.
  app.use('/api/v1/projects/:projectId/services/:serviceId/links', linkRoutes);
  app.use('/api/v1/deployments', deploymentRoutes);
  // Service-to-service (CMS / deployment worker), shared-secret auth, no session.
  app.use('/api/v1/internal', internalRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
