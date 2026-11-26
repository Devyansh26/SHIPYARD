export type ServiceType = 'frontend' | 'backend' | 'database'

export type User = {
  id: string
  username: string
  github: { avatar_url?: string | null; name?: string | null; username?: string } | null
  noOfDeployments: number
}

export type Project = {
  id: string
  name: string
  githubUrl: string | null
  createdAt: string | null
  updatedAt: string | null
}

export type CanvasMeta = { x: number; y: number; dependsOn?: string[] }

/** service_config.container — shape mirrors the CMS job contract exactly. */
export type PortMapping = {
  containerPort: number
  hostPort?: number | null
  protocol?: 'tcp' | 'udp'
}

export type ContainerMeta = {
  ports?: PortMapping[]
  resources?: { cpuLimit?: string | null; memoryLimit?: string | null } | null
  healthCheck?: { path?: string | null; port?: number | null } | null
}

export type VercelMeta = {
  framework?: string | null
  outputDirectory?: string | null
  installCommand?: string | null
  projectName?: string | null
  target?: 'production' | 'preview'
}

/**
 * Where a service deploys. Held at the top level of `service_config` rather
 * than inside a provider block, because it is the thing that decides WHICH
 * provider block applies.
 *
 * Deliberately a plain `string`, not a union of the targets that exist today.
 * The list is served by `GET /api/v1/deploy-targets` from the registry in
 * `providers/index.js`, so adding Railway there must not require editing this
 * file — a union here would turn a backend-only change into a frontend change
 * and a type error.
 *
 * Absent means the service type's default (`container` for a backend) — which
 * now only happens for services created before the picker existed. Every new
 * node stores an explicit choice.
 */
export type DeployTarget = string

/** One option in the target picker, as served by GET /api/v1/deploy-targets. */
export type DeployTargetOption = {
  deployTarget: DeployTarget
  provider: string
  label: string
  description: string
  requiresConnection: boolean
  /** What a legacy service with no stored choice resolves to — not a pre-selection. */
  isDefault: boolean
  /** False when it cannot be deployed to yet; `reason` says why. Never hidden. */
  usable: boolean
  /** Null for targets needing no credential (the container host). */
  connected: boolean | null
  reason: string | null
}

/** service_config.render — mirrors Render's create-service contract. */
export type RenderMeta = {
  runtime?: string | null
  region?: string | null
  plan?: string | null
  healthCheckPath?: string | null
  autoDeployTrigger?: 'off' | 'commit' | 'checksPass' | null
  dockerfilePath?: string | null
  dockerContext?: string | null
  /** Written back by the control plane once Render has created the service. */
  serviceId?: string | null
  serviceName?: string | null
}

/** The enum lists and defaults the Render settings form renders. */
export type RenderOptions = {
  runtimes: string[]
  regions: string[]
  plans: string[]
  autoDeployTriggers: ('off' | 'commit' | 'checksPass')[]
  defaults: {
    runtime: string
    region: string
    plan: string
    autoDeployTrigger: string
    healthCheckPath: string
  }
  consoleUrl: string
  apiKeyUrl: string
}

/** One Render workspace an API key can reach ("owner" in their API). */
export type RenderWorkspace = {
  id: string
  name: string
  type: 'user' | 'team'
  email?: string | null
}

/** service_config.railway — mirrors Railway's ServiceInstanceUpdateInput. */
export type RailwayMeta = {
  region?: string | null
  healthcheckPath?: string | null
  numReplicas?: number | null
  restartPolicyType?: 'ON_FAILURE' | 'ALWAYS' | 'NEVER' | null
  sleepApplication?: boolean | null
  /** Which Railway environment to deploy into; projects start with "production". */
  environmentName?: string | null
  /** The port the generated domain routes to. Null lets Railway infer it. */
  targetPort?: number | null
  dockerfilePath?: string | null
  /** Written back by the control plane once Railway has created the service. */
  serviceId?: string | null
  serviceName?: string | null
  environmentId?: string | null
}

/** The enum lists and defaults the Railway settings form renders. */
export type RailwayOptions = {
  regions: string[]
  restartPolicies: ('ON_FAILURE' | 'ALWAYS' | 'NEVER')[]
  defaults: {
    region: string
    healthcheckPath: string
    numReplicas: number
    restartPolicyType: string
    sleepApplication: boolean
    environmentName: string
  }
  consoleUrl: string
  apiKeyUrl: string
}

/** One Railway project a token can reach. Services are created inside one. */
export type RailwayProject = { id: string; name: string }

export type RailwayConnection = Connection & {
  accountId?: string | null
  accountName?: string | null
  /** Null for a workspace token — those have no user identity, by design. */
  user?: { id?: string | null; name?: string | null; email?: string | null } | null
  /** Which kind of token this is, inferred from whether `me` was allowed. */
  tokenKind?: 'account' | 'workspace' | null
  /** Null when the token sees several projects and none is pinned yet. */
  projectId: string | null
  projects: RailwayProject[]
  error?: { code?: string; message?: string }
}

export type RenderConnection = Connection & {
  accountId?: string | null
  accountName?: string | null
  email?: string | null
  /** Null when the key reaches several workspaces and none is pinned yet. */
  ownerId: string | null
  workspaces: RenderWorkspace[]
  error?: { code?: string; message?: string }
}

/* ------------------------------------------------------- cloudflare pages */

/** service_config.cloudflare — mirrors Cloudflare's Pages build_config. */
export type CloudflarePagesMeta = {
  framework?: string | null
  buildCommand?: string | null
  /** Where the built site lands. The commonest Pages misconfiguration. */
  destinationDir?: string | null
  rootDir?: string | null
  buildCaching?: boolean | null
  productionBranch?: string | null
  /** Written back by the control plane once Cloudflare created the project. */
  projectName?: string | null
  subdomain?: string | null
}

/** One framework preset, carrying the build command and output dir. */
export type CloudflareFrameworkPreset = {
  value: string
  label: string
  buildCommand: string
  destinationDir: string
}

export type CloudflareOptions = {
  frameworks: CloudflareFrameworkPreset[]
  defaults: {
    framework: string
    buildCommand: string
    destinationDir: string
    rootDir: string
    buildCaching: boolean
    productionBranch: string
  }
  consoleUrl: string
  apiKeyUrl: string
  /** The one-time GitHub App install the API cannot perform. */
  gitSetupUrl: string
}

/** One Cloudflare account a token can reach. Pages projects live in one. */
export type CloudflareAccount = { id: string; name: string }

export type CloudflareConnection = Connection & {
  accountName?: string | null
  tokenStatus?: string | null
  /** Null when the token sees several accounts and none is pinned yet. */
  cloudflareAccountId: string | null
  accounts: CloudflareAccount[]
  error?: { code?: string; message?: string }
}

/* ------------------------------------------------------------------ azure */

export type AzureServiceKind = 'app_service' | 'container_apps' | 'static_web_apps'

/** service_config.azure — frontend or backend; Azure supports both. */
export type AzureMeta = {
  serviceKind?: AzureServiceKind
  subscriptionId?: string | null
  resourceGroup?: string | null
  location?: string | null
  appName?: string | null
  sku?: string | null
  runtimeStack?: string | null
  containerImage?: string | null
  port?: number | null
  outputLocation?: string | null
}

export type AzureSubscription = {
  subscriptionId: string
  displayName: string
  state: string
  tenantId?: string | null
}

/** service_config.links — one entry per database this service reads. */
export type ServiceLinkMeta = {
  /** Absent on records written before url links existed — those are databases. */
  kind?: 'database' | 'url'
  varName: string
  providerType?: string | null
  engine?: string | null
  scope?: EnvScope
  databaseLabel?: string | null
  /** url links only: the address that was injected. */
  url?: string | null
  linkedAt?: string | null
}

export type Service = {
  id: string
  projectId: string
  providerConnectionId: string | null
  name: string
  serviceType: ServiceType
  repository: string | null
  branch: string | null
  rootDirectory: string | null
  buildCommand: string | null
  preDeployCommand: string | null
  startCommand: string | null
  serviceConfig: {
    canvas?: CanvasMeta
    /**
     * Which provider below applies. `provider` is canonical; `deployTarget` is
     * the legacy spelling the backend target picker wrote before the Azure and
     * Render/Railway branches merged. The control plane reads either, so both
     * are typed — write `provider` in new code.
     *
     * Deliberately `DeployTarget` (a plain string), not a union of today's
     * providers: the list is served by `GET /api/v1/deploy-targets` from the
     * server registry, so registering a provider there must not require
     * editing this file.
     */
    provider?: DeployTarget
    /** @deprecated Read-only compatibility — write `provider` instead. */
    deployTarget?: DeployTarget
    /** frontend services only */
    vercel?: VercelMeta
    /** azure deployments (frontend or backend) */
    azure?: AzureMeta
    /** backend services on the container target */
    container?: ContainerMeta
    /** backend services on the Render target */
    render?: RenderMeta
    /** backend services on the Railway target */
    railway?: RailwayMeta
    /** frontend services on the Cloudflare Pages target */
    cloudflare?: CloudflarePagesMeta
    /** database services only */
    engine?: string
    /** Databases this service reads, keyed by the database node's service id. */
    links?: Record<string, ServiceLinkMeta>
  } & Record<string, unknown>
  createdAt: string | null
  updatedAt: string | null
}

/** A database node's provider descriptor, served by the control plane. */
export type DatabaseProvider = {
  providerType: 'neon' | 'atlas'
  label: string
  engine: string
  kind: 'sql' | 'nosql'
  consoleUrl: string
  defaultVarName: string
  /** 'connect' = a live SELECT 1 ran; 'format' = shape checked only. */
  verifyMethod: 'connect' | 'format'
  placeholder?: string
}

export type DatabaseAttachment = {
  connection: Connection
  provider: DatabaseProvider
  /** Host / database / user only — the password never reaches the browser. */
  database: { host: string; name: string | null; user: string | null; label: string } | null
  decryptable: boolean
  verification?: DatabaseVerification
  resynced?: { updated: number; services?: { serviceName: string; varName: string }[] }
}

export type DatabaseVerification = {
  verified: boolean
  method: 'connect' | 'format'
  detail: string
  warnings?: string[]
}

/** A backend<->database binding, as reported by GET .../links. */
export type ServiceLink = {
  providerServiceId: string
  /** Alias of providerServiceId, kept for the database-only call sites. */
  databaseServiceId: string
  kind: 'database' | 'url'
  providerName: string | null
  providerServiceType: ServiceType | null
  databaseName: string | null
  varName: string
  providerType: string | null
  engine: string | null
  scope: EnvScope
  databaseLabel: string | null
  /** url links: what was injected, what the provider answers on now. */
  url?: string | null
  liveUrl?: string | null
  /** True when the provider has moved since the value was injected. */
  stale?: boolean
  linkedAt: string | null
}

export type LatestCommit = {
  branch: string
  sha: string
  shortSha: string
  message: string
  author: string | null
  committedAt: string | null
  url: string | null
  deployedSha: string | null
  deployedShortSha: string | null
  deployedStatus: DeploymentStatus | null
  upToDate: boolean
}

export type DeploymentStatus =
  | 'queued' | 'validating' | 'building' | 'deploying'
  | 'healthy' | 'failed' | 'cancelled' | 'rolling_back' | 'rolled_back'

export type Deployment = {
  id: string
  serviceId: string
  commitSha: string
  shortSha: string
  branch: string
  status: DeploymentStatus
  url: string | null
  provider: {
    type: string | null
    projectName: string | null
    deploymentId: string | null
    inspectorUrl: string | null
    readyState: string | null
    target: string | null
  }
  errorMessage: string | null
  retryCount: number
  createdAt: string | null
  startedAt: string | null
  finishedAt: string | null
  isTerminal: boolean
}

export type EnvScope = 'production' | 'preview' | 'all'

export type EnvVar = {
  id: string
  serviceId: string
  key: string
  sensitive: boolean
  scope: EnvScope
  /** Non-sensitive vars only; null for secrets. */
  valuePreview: string | null
  /** Character count of the decrypted value — shown instead of a secret. */
  valueLength: number | null
  decryptable: boolean
  createdAt: string | null
  updatedAt: string | null
}

export type EnvImportResult = {
  vars: EnvVar[]
  created: number
  updated: number
  skipped: { line: number; text: string; reason: string }[]
}

export type Connection = {
  id: string
  providerType: string
  externalAccountId: string | null
  scope: 'team' | 'personal'
  status: string
}

export type ContainerTarget = {
  type: 'container'
  reachable: boolean
  accountName?: string | null
  scope?: string
  error?: { code?: string; message?: string }
}

export type Repo = {
  name: string
  full_name: string
  private: boolean
  default_branch: string
  html_url: string
}

/** Shape thrown by api.ts on a non-2xx response. */
export type ApiError = {
  status: number
  body?: { error?: { code?: string; message?: string } } | null
}

/**
 * Which provider a service deploys to, as the server resolves it.
 *
 * Reads `provider` then the legacy `deployTarget`, so a service created by
 * either branch's UI answers correctly. Mirrors `providerChoiceOf()` in
 * `integrations/core/registry/index.js` — the two must agree, or the UI shows
 * one target's settings while the deploy goes somewhere else.
 *
 * Null means "no explicit choice": the server falls back to the service
 * type's default (`vercel` for a frontend, `container` for a backend).
 */
export function providerOf(service: {
  serviceConfig?: { provider?: string; deployTarget?: string }
}): string | null {
  const raw = service.serviceConfig?.provider ?? service.serviceConfig?.deployTarget
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
}

export function errCode(e: unknown): string | undefined {
  return (e as ApiError)?.body?.error?.code
}

export function errMessage(e: unknown, fallback = 'Something went wrong'): string {
  return (e as ApiError)?.body?.error?.message ?? fallback
}
