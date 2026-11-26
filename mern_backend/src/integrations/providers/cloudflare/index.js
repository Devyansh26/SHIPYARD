// Cloudflare Pages registration for the integrations registry.
//
// Same thin-wrapper role as `providers/render/index.js` and
// `providers/railway/index.js`: it decrypts the stored credential and
// delegates. The integration itself stays whole in `modules/cloudflare/`.
import { decryptSecret } from '../../../utils/crypto.js';
import { createCloudflareAdapter as createAdapterImpl } from '../../../modules/cloudflare/adapter.js';

export function createCloudflareAdapter({
  credentialsRef, externalAccountId = null, token: rawToken, accountId: rawAccountId,
}) {
  return createAdapterImpl({
    token: rawToken ?? decryptSecret(credentialsRef),
    // For Cloudflare this column holds the ACCOUNT id that Pages projects are
    // created under.
    accountId: rawAccountId !== undefined ? rawAccountId : externalAccountId,
  });
}
