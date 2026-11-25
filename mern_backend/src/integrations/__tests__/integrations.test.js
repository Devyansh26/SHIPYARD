import test from 'node:test';
import assert from 'node:assert/strict';

// Provide required boot env vars before importing modules that validate env.js
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/testdb',
  FRONTEND_URL: 'http://localhost:5173',
  GITHUB_CLIENT_ID: 'gh_test_client',
  GITHUB_CLIENT_SECRET: 'gh_test_secret',
  GITHUB_CALLBACK_URL: 'http://localhost:3001/api/v1/auth/github/callback',
  JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-characters-long',
  TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
});

const {
  SUPPORTED_PROVIDERS,
  targetForServiceType,
  createAdapter,
  createKeylessAdapter,
  SERVICE_TARGET_SUMMARY,
} = await import('../index.js');

const { assertAdapterContract } = await import('../core/interfaces/providerAdapter.js');
const {
  isTokenExpired,
  serializeAzureCredentials,
  parseAzureCredentials,
  signAzureState,
  verifyAzureState,
} = await import('../providers/azure/auth/oauth.js');
const { resolveServiceKind } = await import('../providers/azure/deployments/index.js');
const { resolveAppServiceNames } = await import('../providers/azure/services/appService.js');
const { resolveContainerAppNames } = await import('../providers/azure/services/containerApps.js');
const { resolveStaticWebAppName } = await import('../providers/azure/services/staticWebApps.js');
const { defaultResourceGroupName } = await import('../providers/azure/services/resourceGroup.js');

test('registry registers azure and vercel and resolves service targets', () => {
  assert.ok(SUPPORTED_PROVIDERS.includes('vercel'));
  assert.ok(SUPPORTED_PROVIDERS.includes('azure'));

  assert.deepEqual(targetForServiceType('frontend'), { provider: 'vercel', requiresConnection: true });
  assert.deepEqual(targetForServiceType('backend'), { provider: 'container', requiresConnection: false });
  assert.equal(targetForServiceType('database'), null);

  assert.deepEqual(
    targetForServiceType('frontend', { provider: 'azure' }),
    { provider: 'azure', requiresConnection: true }
  );
  assert.deepEqual(
    targetForServiceType('backend', { provider: 'azure' }),
    { provider: 'azure', requiresConnection: true }
  );

  assert.throws(
    () => targetForServiceType('backend', { provider: 'vercel' }),
    (err) => err.code === 'UNSUPPORTED_SERVICE_TYPE_FOR_PROVIDER'
  );
  assert.throws(
    () => targetForServiceType('frontend', { provider: 'unknown' }),
    (err) => err.code === 'UNSUPPORTED_PROVIDER'
  );

  const summary = SERVICE_TARGET_SUMMARY();
  assert.ok(summary.some((l) => l.includes('frontend') && l.includes('azure')));
  assert.ok(summary.some((l) => l.includes('backend') && l.includes('azure')));
});

test('all registered adapters conform to the common provider interface', () => {
  const azRef = serializeAzureCredentials({
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() + 3600_000,
    subscriptionId: '11111111-1111-1111-1111-111111111111',
  });

  const azure = createAdapter({ providerType: 'azure', credentialsRef: azRef });
  assert.equal(azure.providerType, 'azure');
  assertAdapterContract(azure);

  const container = createKeylessAdapter('container');
  assert.equal(container.providerType, 'container');
  assertAdapterContract(container);

  assert.throws(() => assertAdapterContract({ providerType: 'broken' }), /missing required method/);
});

test('azure credential encryption, parsing, and expiry detection', () => {
  const payload = {
    accessToken: 'eyJ-test-token',
    refreshToken: 'refresh-123',
    expiresAt: Date.now() + 3600_000,
    tenantId: 'common',
    subscriptionId: 'sub-123',
  };
  const encrypted = serializeAzureCredentials(payload);
  assert.ok(encrypted.startsWith('enc:v1:'));

  const parsed = parseAzureCredentials(encrypted);
  assert.equal(parsed.accessToken, payload.accessToken);
  assert.equal(parsed.subscriptionId, payload.subscriptionId);
  assert.equal(isTokenExpired(parsed), false);

  assert.equal(isTokenExpired({ expiresAt: Date.now() + 60_000 }), true);
  assert.equal(isTokenExpired({ expiresAt: Date.now() - 1000 }), true);
});

test('azure service kind and resource name resolution', () => {
  assert.equal(resolveServiceKind('frontend', {}), 'static_web_apps');
  assert.equal(resolveServiceKind('backend', {}), 'app_service');
  assert.equal(resolveServiceKind('backend', { azure: { serviceKind: 'container_apps' } }), 'container_apps');

  assert.equal(defaultResourceGroupName('My SaaS!'), 'shipyard-my-saas-rg');
  assert.deepEqual(resolveAppServiceNames({ name: 'API Service' }), {
    appName: 'sy-api-service',
    planName: 'sy-api-service-plan',
  });
  const aca = resolveContainerAppNames({ name: 'My_Worker' });
  assert.equal(aca.appName, 'sy-my-worker');
  assert.equal(aca.registryName, 'symyworkeracr');
  assert.equal(resolveStaticWebAppName({ name: 'Web Frontend' }), 'sy-web-frontend');
});

test('azure oauth state signing and verification', () => {
  const state = signAzureState('user_123');
  assert.equal(verifyAzureState(state, 'user_123'), true);
  assert.equal(verifyAzureState(state, 'user_other'), false);
  assert.equal(verifyAzureState(`${state}tamper`, 'user_123'), false);
  assert.equal(verifyAzureState('nonce.1.sig', 'user_123'), false);
  assert.equal(verifyAzureState('', 'user_123'), false);
});
