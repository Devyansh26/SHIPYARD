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
import { serviceDeploymentRoutes, deploymentRoutes } from './modules/deployments/routes.js';
import envVarRoutes from './modules/envvars/routes.js';
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
  app.use('/api/v1/connections', connectionRoutes);
  app.use('/api/v1/projects', projectRoutes);
  // Nested services: /api/v1/projects/:projectId/services
  app.use('/api/v1/projects/:projectId/services', serviceRoutes);
  // Deployments: nested for create/list, flat for read/logs/cancel.
  app.use('/api/v1/projects/:projectId/services/:serviceId/deployments', serviceDeploymentRoutes);
  // Environment variables: encrypted at rest, pushed to the provider on deploy.
  app.use('/api/v1/projects/:projectId/services/:serviceId/env', envVarRoutes);
  app.use('/api/v1/deployments', deploymentRoutes);
  // Service-to-service (CMS / deployment worker), shared-secret auth, no session.
  app.use('/api/v1/internal', internalRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
