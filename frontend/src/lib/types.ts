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
    /** frontend services only */
    vercel?: VercelMeta
    /** backend services only */
    container?: ContainerMeta
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

export function errCode(e: unknown): string | undefined {
  return (e as ApiError)?.body?.error?.code
}

export function errMessage(e: unknown, fallback = 'Something went wrong'): string {
  return (e as ApiError)?.body?.error?.message ?? fallback
}
