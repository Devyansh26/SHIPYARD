// Deploy targets — mounted at /api/v1/deploy-targets.
//
// Serves the menu the "Add service" picker and the Settings tab render: which
// targets a service type may deploy to, what each one is called, and whether
// this user can actually use it right now.
//
// It exists so the frontend holds no provider list of its own. Every label and
// description comes from the registry in `providers/index.js`, so adding
// Railway there makes it appear in the picker with no frontend change — which
// is the whole point of asking the user to choose rather than defaulting.
//
// Cross-provider by nature (it reports on Vercel, Render and the container host
// together), so it is its own module rather than living inside any one
// provider's folder.
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import {
  allowedTargetsForServiceType, containerTargetConfigured, DEPLOYABLE_SERVICE_TYPES,
} from '../providers/index.js';
import { findConnection } from '../connections/repository.js';

/**
 * Whether a target is usable, and if not, why — in words the picker can show.
 *
 * `usable: false` never hides a target. It is shown with its reason so the user
 * understands the choice they are making: picking Render before connecting an
 * account is fine, and the Connection tab is one click away. Hiding it would
 * leave them wondering why the provider they came for is missing.
 */
async function availability(userId, target) {
  if (!target.requiresConnection) {
    // Our own infrastructure: there is no credential, only whether this server
    // is pointed at a Container Management Service at all.
    const configured = containerTargetConfigured();
    return {
      usable: configured,
      connected: null,
      reason: configured
        ? null
        : 'Not configured on this server — set CMS_BASE_URL and CMS_INTERNAL_KEY '
          + 'in mern_backend/.env and run container_management/.',
    };
  }

  const row = await findConnection(userId, target.provider).catch(() => null);
  const connected = Boolean(row && row.connection_status === 'active');
  return {
    usable: connected,
    connected,
    reason: connected ? null : `No ${target.label} account connected yet — you can `
      + 'pick this now and connect it on the Connection tab before deploying.',
  };
}

const router = Router();
router.use(requireAuth);

/**
 * GET /api/v1/deploy-targets?serviceType=backend
 *
 * Without `serviceType`, reports every deployable type at once — which is what
 * the "Add service" menu wants, so opening it costs one request rather than one
 * per type.
 */
router.get('/', asyncHandler(async (req, res) => {
  const requested = typeof req.query.serviceType === 'string' ? req.query.serviceType : null;

  if (requested && !DEPLOYABLE_SERVICE_TYPES.includes(requested)) {
    // A `database` node deploys nowhere; say so plainly instead of 404ing, so
    // the caller can render an empty picker rather than an error.
    return res.json({ serviceType: requested, deployable: false, targets: [] });
  }

  const types = requested ? [requested] : DEPLOYABLE_SERVICE_TYPES;
  const byType = {};

  for (const type of types) {
    const targets = allowedTargetsForServiceType(type);
    byType[type] = await Promise.all(targets.map(async (t) => ({
      deployTarget: t.deployTarget,
      provider: t.provider,
      label: t.label,
      description: t.description,
      requiresConnection: t.requiresConnection,
      // What a legacy service with no stored choice falls back to. Not a
      // pre-selection for the picker.
      isDefault: t.isDefault,
      ...(await availability(req.userId, t)),
    })));
  }

  if (requested) {
    return res.json({ serviceType: requested, deployable: true, targets: byType[requested] });
  }
  res.json({ byServiceType: byType, deployableTypes: DEPLOYABLE_SERVICE_TYPES });
}));

export default router;
