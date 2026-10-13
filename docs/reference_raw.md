
All endpoints from the supplied ShipYard specification, grouped by API area. Paths are shown with their API prefixes.

## A. Authentication and GitHub Integration

**Prefix:** `/api/v1/auth`

| Method | Endpoint                                            | Purpose                               |
| ------ | --------------------------------------------------- | ------------------------------------- |
| GET    | `/api/v1/auth/github`                               | Start GitHub OAuth                    |
| GET    | `/api/v1/auth/github/callback`                      | Complete OAuth and create a session   |
| GET    | `/api/v1/auth/me`                                   | Get the current user                  |
| POST   | `/api/v1/auth/logout`                               | Invalidate the session                |
| GET    | `/api/v1/auth/github/repos`                         | List repositories the user can access |
| GET    | `/api/v1/auth/github/repos/{owner}/{repo}/branches` | List repository branches              |
| GET    | `/api/v1/auth/github/repos/{owner}/{repo}/commits`  | List recent commits                   |

**Security notes**
- Use a secure HTTP-only session cookie or another carefully implemented token strategy.
- Never return a GitHub access token to the browser simply because the frontend needs repository access.

## B. Projects and Flowchart Configuration

**Prefix:** `/api/v1/projects`

| Method | Endpoint                                              | Purpose                                       |
| ------ | ----------------------------------------------------- | --------------------------------------------- |
| POST   | `/api/v1/projects`                                    | Create a project                              |
| GET    | `/api/v1/projects`                                    | List the user's projects                      |
| GET    | `/api/v1/projects/{project_id}`                       | Get project details                           |
| PATCH  | `/api/v1/projects/{project_id}`                       | Update project metadata                       |
| DELETE | `/api/v1/projects/{project_id}`                       | Delete a project, with appropriate safeguards |
|        |                                                       |                                               |
|        |                                                       |                                               |
|        |                                                       |                                               |
| GET    | `/api/v1/projects/{project_id}/services`              | List services in the project                  |
| POST   | `/api/v1/projects/{project_id}/services`              | Add a service node                            |
| GET    | `/api/v1/projects/{project_id}/services/{service_id}` | Get service configuration                     |
| PATCH  | `/api/v1/projects/{project_id}/services/{service_id}` | Update a service                              |
| DELETE | `/api/v1/projects/{project_id}/services/{service_id}` | Remove a service                              |

## C. Deployment Orchestration

**Prefix:** `/api/v1/projects/{project_id}/deployments`

| Method | Endpoint                                                             | Purpose                                    |
| ------ | -------------------------------------------------------------------- | ------------------------------------------ |
| POST   | `/api/v1/projects/{project_id}/deployments`                          | Start a deployment                         |
| GET    | `/api/v1/projects/{project_id}/deployments`                          | List deployment history                    |
| GET    | `/api/v1/projects/{project_id}/deployments/{deployment_id}`          | Get deployment details and status          |
| POST   | `/api/v1/projects/{project_id}/deployments/{deployment_id}/cancel`   | Request cancellation                       |
| POST   | `/api/v1/projects/{project_id}/deployments/{deployment_id}/rollback` | Roll back to a previous successful release |
| GET    | `/api/v1/projects/{project_id}/deployments/{deployment_id}/logs`     | Retrieve deployment logs                   |
| GET    | `/api/v1/projects/{project_id}/deployments/{deployment_id}/events`   | Retrieve deployment events                 |
| GET    | `/api/v1/projects/{project_id}/deployments/{deployment_id}/stream`   | Stream live logs and status over SSE       |

### Example deployment request

```json
{
  "source": {
    "repository": "owner/web",
    "branch": "main",
    "commit": "optional-commit-sha"
  },
  "target": "production",
  "idempotencyKey": "deploy-request-unique-id"
}
```

### Example accepted response

The API should return `202 Accepted` immediately rather than waiting for containers to start.

```json
{
  "id": "dep_456",
  "status": "queued",
  "createdAt": "2026-10-13T00:00:00Z",
  "statusUrl": "/api/v1/projects/prj_123/deployments/dep_456"
}
```

The timestamp is illustrative.

### Deployment states

| State          | Meaning                                     |
| -------------- | ------------------------------------------- |
| `queued`       | Waiting for execution                       |
| `validating`   | Validating configuration, and prerequisites |
| `building`     | Building application artifacts or images    |
| `deploying`    | Applying the release                        |
| `healthy`      | Release is healthy                          |
| `failed`       | Deployment failed                           |
| `cancelled`    | Deployment was cancelled                    |
| `rolling_back` | Rollback is in progress                     |
| `rolled_back`  | Rollback completed                          |

Make transitions explicit so two workers cannot advance the same deployment in conflicting ways. Failure, cancellation, and timeout can branch from intermediate states.

## D. Container Management Service

**Type:** Internal FastAPI service  
**Prefix:** `/internal/v1/containers`

This service coordinates container lifecycle. It must not become a public, unauthenticated Docker proxy.

| Method | Endpoint                                         | Purpose                                  |
| ------ | ------------------------------------------------ | ---------------------------------------- |
| POST   | `/internal/v1/containers`                        | Request creation of a container workload |
| GET    | `/internal/v1/containers`                        | List managed containers                  |
| GET    | `/internal/v1/containers/{container_id}`         | Get container metadata and state         |
| POST   | `/internal/v1/containers/{container_id}/start`   | Start a stopped container                |
| POST   | `/internal/v1/containers/{container_id}/stop`    | Stop a running container                 |
| POST   | `/internal/v1/containers/{container_id}/restart` | Restart a container                      |
| DELETE | `/internal/v1/containers/{container_id}`         | Remove a container after validation      |
| GET    | `/internal/v1/containers/{container_id}/logs`    | Read container logs                      |
| GET    | `/internal/v1/containers/{container_id}/health`  | Inspect health status                    |
| GET    | `/internal/v1/containers/{container_id}/stats`   | Read CPU, memory, and network statistics |

### Example workload creation request

```json
{
  "deploymentId": "dep_456",
  "serviceId": "backend",
  "image": "registry.example.com/app:abc123",
  "ports": [
    { "containerPort": 8000, "protocol": "tcp" }
  ],
  "resources": {
    "cpuLimit": "1",
    "memoryLimit": "512Mi"
  },
  "healthCheck": {
    "path": "/health",
    "port": 8000
  }
}
```

The management service should return an operation ID or workload ID. With asynchronous execution, the container may not exist immediately.

Do not expose raw environment values, database passwords, or deployment secrets in inspection responses. Return secret references or redacted values.

## E. Container Deployment Service

**Type:** Internal FastAPI worker  
**Prefix:** `/internal/v1/deployments`

| Method | Endpoint                                          | Purpose                                      |
| ------ | ------------------------------------------------- | -------------------------------------------- |
| POST   | `/internal/v1/deployments/execute`                | Accept or initiate an execution job          |
| GET    | `/internal/v1/deployments/{deployment_id}`        | Get executor-side job status                 |
| POST   | `/internal/v1/deployments/{deployment_id}/cancel` | Request cancellation                         |
| POST   | `/internal/v1/deployments/{deployment_id}/retry`  | Retry a failed step or job                   |
| GET    | `/internal/v1/deployments/{deployment_id}/logs`   | Retrieve worker logs                         |
| POST   | `/internal/v1/deployments/{deployment_id}/events` | Report execution events to the control plane |
| GET    | `/internal/v1/workers/health`                     | Worker liveness check                        |
| GET    | `/internal/v1/workers/ready`                      | Worker readiness check                       |

**Recommended execution flow**
1. Control API creates a deployment record.
2. It writes a durable job or outbox record.
3. The queue delivers the job to the executor.
4. The executor builds the image, provisions infrastructure, and deploys the release.
5. The executor emits events and the control plane updates the deployment record.
6. The UI observes state through polling or SSE.

Prefer having the executor consume jobs from Redis directly rather than requiring the control API to call `/execute` synchronously. Keep `/execute` if explicit submission or administrative execution is needed.

Redis delivery alone does not guarantee that jobs cannot be lost. Use acknowledgements, bounded retries, idempotent handlers, and a recovery process for jobs stuck in nonterminal states. A transactional outbox helps prevent database commits and job publication from silently diverging.

## F. Environment Variables and Secrets

**Prefix:** `/api/v1/projects/{project_id}/services/{service_id}/env`

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/v1/projects/{project_id}/services/{service_id}/env` | List variable names and metadata |
| PUT | `/api/v1/projects/{project_id}/services/{service_id}/env` | Replace a service's environment configuration |
| PATCH | `/api/v1/projects/{project_id}/services/{service_id}/env/{key}` | Add or update one variable |
| DELETE | `/api/v1/projects/{project_id}/services/{service_id}/env/{key}` | Remove a variable |

### Example variable request

```json
{
  "key": "DATABASE_URL",
  "value": "secret-value",
  "sensitive": true,
  "scope": "production"
}
```

For sensitive variables, store encrypted values or use a secrets manager. Never log their values or send them back in list responses. A masked value such as `********` is sufficient for the UI.

Decide whether variables are captured in each deployment's immutable configuration snapshot or resolved at execution time. The recommended approach is to capture versioned references to the intended configuration.

## G. Domains, Routing, and Load Balancing

**Domain prefix:** `/api/v1/projects/{project_id}/domains`

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/v1/projects/{project_id}/domains` | Add a custom domain |
| GET | `/api/v1/projects/{project_id}/domains` | List project domains |
| GET | `/api/v1/projects/{project_id}/domains/{domain_id}` | Inspect domain and verification status |
| POST | `/api/v1/projects/{project_id}/domains/{domain_id}/verify` | Verify DNS configuration |
| DELETE | `/api/v1/projects/{project_id}/domains/{domain_id}` | Remove a domain |

**Service-route prefix:** `/api/v1/projects/{project_id}/services/{service_id}/routes`

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/v1/projects/{project_id}/services/{service_id}/routes` | Create a route to a service |
| GET | `/api/v1/projects/{project_id}/services/{service_id}/routes` | List routes for a service |
| PATCH | `/api/v1/projects/{project_id}/services/{service_id}/routes/{route_id}` | Update a route |
| DELETE | `/api/v1/projects/{project_id}/services/{service_id}/routes/{route_id}` | Remove a route |

For the homelab, put a reverse proxy such as Traefik or Caddy in front of workloads. ShipYard should manage route configuration through a controlled interface, not expose container ports indiscriminately.

Distinguish routing to a homelab service from configuring a Vercel-hosted frontend domain. These may require separate provider-specific operations.

## H. Provider Connections

**Prefix:** `/api/v1/connections`

Connections represent credentials or OAuth authorizations. Resources are the actual things provisioned using those credentials.

| Method | Endpoint                                   | Purpose                        |
| ------ | ------------------------------------------ | ------------------------------ |
| POST   | `/api/v1/connections`                      | Register a provider connection |
| GET    | `/api/v1/connections`                      | List connected providers       |
| GET    | `/api/v1/connections/{connection_id}`      | Inspect connection metadata    |
| POST   | `/api/v1/connections/{connection_id}/test` | Verify provider access         |
| DELETE | `/api/v1/connections/{connection_id}`      | Revoke or remove a connection  |

Each connection should have a provider type such as `vercel`, `homelab`, `neon`, or `atlas`. The backend should select the appropriate adapter based on the connection and resource type instead of exposing separate HTTP routes for every provider when the operation is the same.

## I. Project Resources

**Prefix:** `/api/v1/projects/{project_id}/resources`

| Method | Endpoint                                                                   | Purpose                                                   |
| ------ | -------------------------------------------------------------------------- | --------------------------------------------------------- |
| POST   | `/api/v1/projects/{project_id}/resources`                                  | Provision a database or other resource                    |
| GET    | `/api/v1/projects/{project_id}/resources`                                  | List project resources                                    |
| GET    | `/api/v1/projects/{project_id}/resources/{resource_id}`                    | Inspect a resource                                        |
| POST   | `/api/v1/projects/{project_id}/resources/{resource_id}/rotate-credentials` | Rotate credentials where supported                        |
| DELETE | `/api/v1/projects/{project_id}/resources/{resource_id}`                    | Delete a resource with confirmation and dependency checks |

## J. Provider-Specific Adapter Operations

These are adapter responsibilities against external providers, not necessarily ShipYard HTTP endpoints.

| Adapter           | Provider / target           | Operations                                                                                                                                                                                                                                                           |
| ----------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VercelProvider`  | Vercel frontend deployments | Create or link a Vercel project; configure Git repository, root directory, build command, and output directory; trigger deployments; retrieve build logs, deployment state, and URL; configure domains and environment variables; receive deployment status webhooks |
| `NeonProvider`    | Neon PostgreSQL             | Create and list projects; create branches and database endpoints where needed; retrieve connection information; manage resource lifecycle; securely store connection details and inject them into backend services                                                   |
| `AtlasProvider`   | MongoDB Atlas               | Create or select projects and clusters; configure database users and network access; retrieve connection strings; provision resources and manage lifecycle                                                                                                           |
| `HomelabProvider` | Backend deployments         | Build or pull images; run containers with CPU and memory limits; configure health checks and restart policies; register reverse-proxy routes; collect logs and metrics; roll back to a previous image or release                                                     |

Check current API capabilities, authentication requirements, quotas, and plan limitations before deciding which provisioning operations to support. ShipYard should only offer capabilities the connected account can use.

## K. Webhooks and Operational Endpoints

| Method | Endpoint                                                      | Purpose                                          |
| ------ | ------------------------------------------------------------- | ------------------------------------------------ |
| POST   | `/api/v1/webhooks/github`                                     | Handle GitHub push and repository events         |
| POST   | `/api/v1/webhooks/vercel`                                     | Receive Vercel deployment events where supported |
| GET    | `/api/v1/health`                                              | Check API liveness                               |
| GET    | `/api/v1/ready`                                               | Check dependencies needed to serve requests      |
| GET    | `/api/v1/projects/{project_id}/services/{service_id}/metrics` | Return service metrics                           |
| GET    | `/api/v1/projects/{project_id}/activity`                      | Return project activity history                  |

## L. Architecture and Implementation Decisions

| Concern                  | Recommended direction                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------- |
|                          |                                                                                         |
| $Deployment request      | Return `202 Accepted`; do not wait for containers to start                              |
| State transitions        | Use an explicit state machine and concurrency-safe transitions                          |
| Job delivery             | Redis queue with acknowledgements, bounded retries, idempotency, and stuck-job recovery |
| Stronger job reliability | Use a transactional outbox to avoid database/job publication divergence                 |
| Worker execution         | Prefer queue consumption over synchronous `/execute` calls                              |
| Secret handling          | Encrypt values or use a secrets manager; redact responses and logs                      |
| Deployment configuration | Capture versioned references to intended environment configuration                      |
| Homelab routing          | Controlled Traefik/Caddy configuration; do not expose ports indiscriminately            |
| Provider abstractions    | Shared operations routed through provider-specific adapters                             |
| Provider capabilities    | Verify API support, authentication, quotas, and plan limitations                        |
| Internal container API   | Keep private and authenticated; never expose an unauthenticated public Docker proxy     |
Exacalidraw:
![[shipyard_system_design|1000]]

initial docs building Prompt:
So what we're planning to build is a simple platform where anybody can deploy their projects easily as in:
1. login with github
2. select your repo
3. create a service
4. give appropriate configs
5. set environment variables
6. select root directory
7. add build command
8. pre deploy command
9. and run command
10. and your project runs and you get a running public url
now each project can have multiple services, we are connecting vercel for frontends, neon for relational dbs, atlas for mongo and my homelab for backends.
and each of this service is also for now running on my homelab.

Build me the LLD docs for this. What is being implemented, How it is being implemented and Why it is being implemented like that. every class, interface, function everything. Also keep the code as simple as possible do not overcomplicate it. keep it as simple as possible also uses DRY. And do TEST DRIVEN DEVELOPMENT.
- Also keep in mind to know what code is being written for which service/server.
Also in docs keep a directory for api documentation:
- where you need to build comprehensive docs for each endpoint.
  like proper docs: payload, response etc.




