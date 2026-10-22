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
  } & Record<string, unknown>
  createdAt: string | null
  updatedAt: string | null
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
