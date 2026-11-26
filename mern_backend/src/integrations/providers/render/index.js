// Render provider registration for the integrations registry.
//
// A thin wrapper, exactly like `providers/vercel/index.js`: it decrypts the
// stored credential and delegates to the real adapter. The Render integration
// itself stays whole in `modules/render/` (client, config, status FSM, adapter,
// connection routes, migration) — this file only adapts its factory signature
// to the registry's `{ credentialsRef, externalAccountId }` contract.
import { decryptSecret } from '../../../utils/crypto.js';
import { createRenderAdapter as createAdapterImpl } from '../../../modules/render/adapter.js';

export function createRenderAdapter({
  credentialsRef, externalAccountId = null, token: rawToken, ownerId: rawOwnerId,
}) {
  return createAdapterImpl({
    token: rawToken ?? decryptSecret(credentialsRef),
    // Render calls this column its "owner": `usr-…` personal, `tea-…` team.
    ownerId: rawOwnerId !== undefined ? rawOwnerId : externalAccountId,
  });
}
