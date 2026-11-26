// Railway provider registration for the integrations registry.
//
// Same thin-wrapper role as `providers/render/index.js`. The Railway
// integration stays whole in `modules/railway/` — notably its GraphQL client,
// whose error handling is the part that must not be bypassed (Railway reports
// failures in an HTTP 200 body).
import { decryptSecret } from '../../../utils/crypto.js';
import { createRailwayAdapter as createAdapterImpl } from '../../../modules/railway/adapter.js';

export function createRailwayAdapter({
  credentialsRef, externalAccountId = null, token: rawToken, projectId: rawProjectId,
}) {
  return createAdapterImpl({
    token: rawToken ?? decryptSecret(credentialsRef),
    // For Railway this column holds the PROJECT id services are created in —
    // Railway nests services inside a project, unlike Render's flat workspace.
    projectId: rawProjectId !== undefined ? rawProjectId : externalAccountId,
  });
}
