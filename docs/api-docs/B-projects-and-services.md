# Section B — Projects & Services API

**Service:** `api-server` (public-facing REST API)  
**Base URL:** `https://shipyard.app/api/v1`  
**Version:** v1  
**Auth:** All endpoints require an authenticated session (HTTP-only cookie)

---

## Ownership Enforcement

> [!IMPORTANT]
> ShipYard enforces a strict **403 vs 404 distinction** based on whether the requesting user owns the resource:
> - If the resource **does not exist** → `404 NOT_FOUND`
> - If the resource **exists but belongs to another user** → `404 NOT_FOUND` (intentionally, to avoid leaking existence)
> - If the resource **exists and belongs to the user, but the action is forbidden** → `403 FORBIDDEN`
>
> This means an unauthorized user **can never determine** whether a project/service ID belongs to another user.

---

## Data Types

### `service_type` Enum

| Value        | Description                                                               |
|--------------|---------------------------------------------------------------------------|
| `backend`    | Server-side application with a build step and a long-running start command |
| `frontend`   | Static site or SSR frontend; built into static assets or an SSR server    |
| `database`   | Managed database instance (Postgres, MySQL, Redis); no build step          |

---

## Endpoints

---

### B-1 · Create Project

```
POST /api/v1/projects
```

Creates a new project owned by the authenticated user. A project is the top-level grouping for services, deployments, and environment variables.

**Auth Required:** Yes  
**Side Effects:**
- Inserts a new row into the `projects` table with `owner_id` set to the authenticated user's ID
- Creates a default `production` environment linked to the project

#### Request Body

```json
{
  "name": "my-saas-app",
  "description": "Production SaaS application"
}
```

| Field         | Type     | Required | Constraints             | Description                          |
|---------------|----------|----------|-------------------------|--------------------------------------|
| `name`        | `string` | Yes      | 2–64 chars, slug format | URL-safe project name (lowercase, hyphens) |
| `description` | `string` | No       | max 255 chars           | Optional human-readable description  |

#### Response — `201 Created`

```json
{
  "id": "prj_01j9kmx8p4fgvw3nq7ztxd6b0e",
  "name": "my-saas-app",
  "description": "Production SaaS application",
  "owner_id": "usr_01j9kmx8p4fgvw3nq7ztxd6b0e",
  "created_at": "2026-10-14T03:01:00Z",
  "updated_at": "2026-10-14T03:01:00Z"
}
```

#### Error Responses

| Status | Error Code              | Description                                               |
|--------|-------------------------|-----------------------------------------------------------|
| `400`  | `VALIDATION_ERROR`      | Missing required field or invalid `name` format           |
| `401`  | `NOT_AUTHENTICATED`     | No valid session                                          |
| `409`  | `PROJECT_NAME_CONFLICT` | A project with this name already exists for this user     |
| `500`  | `DB_WRITE_FAILED`       | Database insert failed unexpectedly                       |

---

### B-2 · List Projects

```
GET /api/v1/projects
```

Returns all projects owned by the authenticated user, ordered by `created_at` descending.

**Auth Required:** Yes  
**Side Effects:** None (read-only)

#### Query Parameters

| Name       | Type     | Required | Default | Description                          |
|------------|----------|----------|---------|--------------------------------------|
| `page`     | `number` | No       | `1`     | Page number (1-indexed)              |
| `per_page` | `number` | No       | `20`    | Items per page (max: `100`)          |

#### Response — `200 OK`

```json
{
  "data": [
    {
      "id": "prj_01j9kmx8p4fgvw3nq7ztxd6b0e",
      "name": "my-saas-app",
      "description": "Production SaaS application",
      "owner_id": "usr_01j9abc000",
      "service_count": 3,
      "created_at": "2026-10-14T03:01:00Z",
      "updated_at": "2026-10-14T03:01:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "per_page": 20,
    "total": 5,
    "has_next": false
  }
}
```

#### Error Responses

| Status | Error Code          | Description                   |
|--------|---------------------|-------------------------------|
| `401`  | `NOT_AUTHENTICATED` | No valid session              |
| `400`  | `VALIDATION_ERROR`  | Invalid pagination parameters |
| `500`  | `DB_READ_FAILED`    | Database query failed         |

---

### B-3 · Get Project

```
GET /api/v1/projects/{project_id}
```

Returns a single project by ID. Returns `404` if the project does not exist **or** belongs to another user (ownership enforcement — existence is never revealed).

**Auth Required:** Yes  
**Side Effects:** None (read-only)

#### Path Parameters

| Name         | Type     | Description                    |
|--------------|----------|--------------------------------|
| `project_id` | `string` | ULID identifier of the project |

#### Response — `200 OK`

```json
{
  "id": "prj_01j9kmx8p4fgvw3nq7ztxd6b0e",
  "name": "my-saas-app",
  "description": "Production SaaS application",
  "owner_id": "usr_01j9abc000",
  "service_count": 3,
  "created_at": "2026-10-14T03:01:00Z",
  "updated_at": "2026-10-14T03:01:00Z"
}
```

#### Error Responses

| Status | Error Code          | Description                                                     |
|--------|---------------------|-----------------------------------------------------------------|
| `401`  | `NOT_AUTHENTICATED` | No valid session                                                |
| `404`  | `NOT_FOUND`         | Project does not exist or belongs to another user               |
| `500`  | `DB_READ_FAILED`    | Database query failed                                           |

---

### B-4 · Update Project

```
PATCH /api/v1/projects/{project_id}
```

Partially updates a project's mutable fields (`name`, `description`). Only the owner can update a project.

**Auth Required:** Yes  
**Side Effects:**
- Updates the `projects` table row, sets `updated_at` to current timestamp

#### Path Parameters

| Name         | Type     | Description                    |
|--------------|----------|--------------------------------|
| `project_id` | `string` | ULID identifier of the project |

#### Request Body

```json
{
  "name": "my-saas-app-v2",
  "description": "Updated description"
}
```

| Field         | Type     | Required | Constraints          | Description                          |
|---------------|----------|----------|----------------------|--------------------------------------|
| `name`        | `string` | No       | 2–64 chars, slug     | New URL-safe project name            |
| `description` | `string` | No       | max 255 chars        | New description (pass `null` to clear)|

#### Response — `200 OK`

Returns the updated project object (same schema as B-3 GET response).

#### Error Responses

| Status | Error Code              | Description                                               |
|--------|-------------------------|-----------------------------------------------------------|
| `400`  | `VALIDATION_ERROR`      | Invalid field values                                      |
| `401`  | `NOT_AUTHENTICATED`     | No valid session                                          |
| `404`  | `NOT_FOUND`             | Project not found or not owned by user                    |
| `409`  | `PROJECT_NAME_CONFLICT` | New name conflicts with an existing project for this user |
| `500`  | `DB_WRITE_FAILED`       | Database update failed                                    |

---

### B-5 · Delete Project

```
DELETE /api/v1/projects/{project_id}
```

Permanently deletes a project and all associated resources (services, deployments, environment variables, domains). This is a **hard delete** — cascades are enforced at the database level.

**Auth Required:** Yes  
**Side Effects:**
- Hard-deletes the `projects` row (cascades to `services`, `deployments`, `env_vars`, `domains`, `routes`)
- Enqueues a `project.teardown` job to the worker queue to stop and remove all running containers
- Removes any associated TLS certificates via the Certificate Manager

> [!CAUTION]
> This action is irreversible. All running containers are stopped and all data is permanently destroyed.

#### Path Parameters

| Name         | Type     | Description                    |
|--------------|----------|--------------------------------|
| `project_id` | `string` | ULID identifier of the project |

#### Response — `204 No Content`

#### Error Responses

| Status | Error Code           | Description                                              |
|--------|----------------------|----------------------------------------------------------|
| `401`  | `NOT_AUTHENTICATED`  | No valid session                                         |
| `404`  | `NOT_FOUND`          | Project not found or not owned by user                   |
| `409`  | `DELETE_IN_PROGRESS` | A previous delete operation is already being processed   |
| `500`  | `DB_WRITE_FAILED`    | Database delete or cascade failed                        |

---

### B-6 · List Services

```
GET /api/v1/projects/{project_id}/services
```

Lists all services within a project. Access is limited to the project owner.

**Auth Required:** Yes  
**Side Effects:** None (read-only)

#### Path Parameters

| Name         | Type     | Description                    |
|--------------|----------|--------------------------------|
| `project_id` | `string` | ULID identifier of the project |

#### Response — `200 OK`

```json
{
  "data": [
    {
      "id": "svc_01j9abc000fgvw3nq7ztxd6b0e",
      "project_id": "prj_01j9kmx8p4fgvw3nq7ztxd6b0e",
      "name": "api-server",
      "service_type": "backend",
      "repository": "octocat/hello-world",
      "branch": "main",
      "root_directory": "./apps/api",
      "build_command": "npm run build",
      "pre_deploy_command": "npm run db:migrate",
      "start_command": "node dist/main.js",
      "service_config": {
        "port": 3000,
        "instance_count": 2,
        "cpu_limit": "500m",
        "memory_limit": "512Mi",
        "health_check_path": "/health"
      },
      "created_at": "2026-10-14T03:01:00Z",
      "updated_at": "2026-10-14T03:01:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "per_page": 20,
    "total": 1,
    "has_next": false
  }
}
```

#### Error Responses

| Status | Error Code          | Description                                      |
|--------|---------------------|--------------------------------------------------|
| `401`  | `NOT_AUTHENTICATED` | No valid session                                 |
| `404`  | `NOT_FOUND`         | Project not found or not owned by user           |
| `500`  | `DB_READ_FAILED`    | Database query failed                            |

---

### B-7 · Create Service

```
POST /api/v1/projects/{project_id}/services
```

Creates a new service within a project. The `service_type` determines which fields are required and which are ignored.

**Auth Required:** Yes  
**Side Effects:**
- Inserts a new row into the `services` table
- Does **not** trigger a deployment — the user must explicitly POST to the deployments endpoint

#### Path Parameters

| Name         | Type     | Description                    |
|--------------|----------|--------------------------------|
| `project_id` | `string` | ULID identifier of the project |

#### Request Body — `CreateServiceDto`

```json
{
  "name": "api-server",
  "service_type": "backend",
  "repository": "octocat/hello-world",
  "branch": "main",
  "root_directory": "./apps/api",
  "build_command": "npm run build",
  "pre_deploy_command": "npm run db:migrate",
  "start_command": "node dist/main.js",
  "service_config": {
    "port": 3000,
    "instance_count": 2,
    "cpu_limit": "500m",
    "memory_limit": "512Mi",
    "health_check_path": "/health",
    "health_check_timeout_seconds": 30
  }
}
```

#### `CreateServiceDto` Field Reference

| Field                | Type     | Required for          | Constraints          | Description                                                            |
|----------------------|----------|-----------------------|----------------------|------------------------------------------------------------------------|
| `name`               | `string` | All types             | 2–64 chars, slug     | Unique within project; used as container hostname                      |
| `service_type`       | `enum`   | All types             | `backend` \| `frontend` \| `database` | Type of service                            |
| `repository`         | `string` | `backend`, `frontend` | `owner/repo` format  | GitHub repository full name                                            |
| `branch`             | `string` | `backend`, `frontend` | max 255 chars        | Branch to deploy from                                                  |
| `root_directory`     | `string` | No                    | max 255 chars        | Subdirectory within the repo to use as build context (default: `.`)    |
| `build_command`      | `string` | `backend`, `frontend` | max 512 chars        | Shell command to build the application                                 |
| `pre_deploy_command` | `string` | No                    | max 512 chars        | Shell command run after build but before the new container starts (e.g., migrations) |
| `start_command`      | `string` | `backend`             | max 512 chars        | Shell command to start the server process                              |
| `service_config`     | `object` | No                    | See below            | Runtime resource and behavior configuration                            |

#### `service_config` Object Fields

| Field                          | Type     | Required | Default   | Description                                         |
|--------------------------------|----------|----------|-----------|-----------------------------------------------------|
| `port`                         | `number` | No       | `3000`    | Port the application listens on inside the container |
| `instance_count`               | `number` | No       | `1`       | Number of container replicas (1–10)                 |
| `cpu_limit`                    | `string` | No       | `"250m"`  | Docker CPU limit in milliCPU notation               |
| `memory_limit`                 | `string` | No       | `"256Mi"` | Docker memory limit (e.g., `"512Mi"`, `"1Gi"`)      |
| `health_check_path`            | `string` | No       | `"/"`     | HTTP path polled for health (must return 2xx)        |
| `health_check_timeout_seconds` | `number` | No       | `30`      | Seconds to wait for first healthy response           |

#### Response — `201 Created`

Returns the full service object (same schema as shown in B-6 list response).

#### Error Responses

| Status | Error Code               | Description                                               |
|--------|--------------------------|-----------------------------------------------------------|
| `400`  | `VALIDATION_ERROR`       | Missing required field or invalid value                   |
| `401`  | `NOT_AUTHENTICATED`      | No valid session                                          |
| `404`  | `NOT_FOUND`              | Project not found or not owned by user                    |
| `409`  | `SERVICE_NAME_CONFLICT`  | Service with this name already exists within the project  |
| `422`  | `INVALID_SERVICE_TYPE`   | Unknown `service_type` value                              |
| `500`  | `DB_WRITE_FAILED`        | Database insert failed                                    |

---

### B-8 · Get Service

```
GET /api/v1/projects/{project_id}/services/{service_id}
```

Returns a single service by ID. Returns `404` if the service or parent project does not exist or is not owned by the user.

**Auth Required:** Yes  
**Side Effects:** None (read-only)

#### Path Parameters

| Name         | Type     | Description                     |
|--------------|----------|---------------------------------|
| `project_id` | `string` | ULID identifier of the project  |
| `service_id` | `string` | ULID identifier of the service  |

#### Response — `200 OK`

Returns the service object (same schema as B-6 list response `data[]` item).

#### Error Responses

| Status | Error Code          | Description                                              |
|--------|---------------------|----------------------------------------------------------|
| `401`  | `NOT_AUTHENTICATED` | No valid session                                         |
| `404`  | `NOT_FOUND`         | Project or service not found, or not owned by user       |
| `500`  | `DB_READ_FAILED`    | Database query failed                                    |

---

### B-9 · Update Service

```
PATCH /api/v1/projects/{project_id}/services/{service_id}
```

Partially updates a service's configuration. All fields are optional — only the provided fields are updated. Changing `service_type` is **not** allowed after creation.

**Auth Required:** Yes  
**Side Effects:**
- Updates the `services` table row, sets `updated_at` to current timestamp
- Does **not** trigger a redeployment — the user must manually start a new deployment

#### Path Parameters

| Name         | Type     | Description                     |
|--------------|----------|---------------------------------|
| `project_id` | `string` | ULID identifier of the project  |
| `service_id` | `string` | ULID identifier of the service  |

#### Request Body

All fields from `CreateServiceDto` are accepted except `service_type`. Only include fields you wish to change.

```json
{
  "branch": "release/v2",
  "service_config": {
    "instance_count": 3,
    "memory_limit": "1Gi"
  }
}
```

#### Response — `200 OK`

Returns the updated service object.

#### Error Responses

| Status | Error Code               | Description                                              |
|--------|--------------------------|----------------------------------------------------------|
| `400`  | `VALIDATION_ERROR`       | Invalid field values                                     |
| `400`  | `IMMUTABLE_FIELD`        | Attempted to change `service_type` after creation        |
| `401`  | `NOT_AUTHENTICATED`      | No valid session                                         |
| `404`  | `NOT_FOUND`              | Project or service not found or not owned by user        |
| `409`  | `SERVICE_NAME_CONFLICT`  | New name conflicts with existing service in this project |
| `500`  | `DB_WRITE_FAILED`        | Database update failed                                   |

---

### B-10 · Delete Service

```
DELETE /api/v1/projects/{project_id}/services/{service_id}
```

Permanently deletes a service and all associated data (deployments, env vars, domains, routes). Running containers are stopped.

**Auth Required:** Yes  
**Side Effects:**
- Hard-deletes the `services` row (cascades to `deployments`, `env_vars`, `domains`, `routes`)
- Enqueues a `service.teardown` job to stop and remove running containers
- Removes associated TLS certificates

> [!CAUTION]
> Irreversible. All deployment history and configuration is permanently deleted.

#### Path Parameters

| Name         | Type     | Description                     |
|--------------|----------|---------------------------------|
| `project_id` | `string` | ULID identifier of the project  |
| `service_id` | `string` | ULID identifier of the service  |

#### Response — `204 No Content`

#### Error Responses

| Status | Error Code           | Description                                              |
|--------|----------------------|----------------------------------------------------------|
| `401`  | `NOT_AUTHENTICATED`  | No valid session                                         |
| `404`  | `NOT_FOUND`          | Project or service not found, or not owned by user       |
| `409`  | `DELETE_IN_PROGRESS` | A previous delete operation is already being processed   |
| `500`  | `DB_WRITE_FAILED`    | Database delete or cascade failed                        |
