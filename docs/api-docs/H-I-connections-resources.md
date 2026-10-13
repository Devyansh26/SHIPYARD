# API Documentation: H & I - Provider Connections and Project Resources

This section describes managing external provider credentials (Vercel, Neon, Atlas, Homelab) and provisioning managed project resources (PostgreSQL on Neon, MongoDB on Atlas, etc.).

---

# Part H: Provider Connections
**Base Path:** `/api/v1/connections`  
**Authentication:** Authenticated User Session

---

## 1. POST `/api/v1/connections`
### Description
Registers an authenticated connection or API token for a cloud provider. Tokens are stored encrypted at rest.

- **Auth:** Required
- **Path Params:** None

### Request Body
```json
{
  "providerType": "neon",
  "externalAccountId": "acc_neon_998877",
  "credentials": {
    "apiToken": "npg_tok_1234567890abcdef"
  }
}
```

### Success Response (`201 Created`)
```json
{
  "connectionId": "con_1234567890ab",
  "providerType": "neon",
  "externalAccountId": "acc_neon_998877",
  "connectionStatus": "active",
  "createdAt": "2026-10-14T03:30:00Z"
}
```

### Error Responses
- `400 Bad Request` (`UNSUPPORTED_PROVIDER`): Provider type must be one of `vercel`, `neon`, `atlas`, `homelab`.
- `401 Unauthorized` (`UNAUTHORIZED`): Session invalid.
- `422 Unprocessable Entity` (`INVALID_CREDENTIALS`): Provider rejected credentials during initial handshake test.

### Side Effects
- Encrypts credentials using `EncryptionService` and stores `credentials_ref` in MongoDB `provider_connections`.

---

## 2. GET `/api/v1/connections`
### Description
Lists all registered provider connections for the authenticated user. Credentials are omitted.

- **Auth:** Required

### Success Response (`200 OK`)
```json
[
  {
    "connectionId": "con_1234567890ab",
    "providerType": "neon",
    "externalAccountId": "acc_neon_998877",
    "connectionStatus": "active",
    "createdAt": "2026-10-14T03:30:00Z"
  },
  {
    "connectionId": "con_9876543210ab",
    "providerType": "vercel",
    "externalAccountId": "team_vercel_1122",
    "connectionStatus": "active",
    "createdAt": "2026-10-14T03:31:00Z"
  }
]
```

### Error Responses
- `401 Unauthorized` (`UNAUTHORIZED`): Not authenticated.
- `500 Internal Server Error` (`DB_ERROR`): Database lookup failure.

---

## 3. GET `/api/v1/connections/{connection_id}`
### Description
Retrieves provider connection metadata.

- **Auth:** Required
- **Path Params:** `connection_id` (`string`, required)

### Success Response (`200 OK`)
```json
{
  "connectionId": "con_1234567890ab",
  "providerType": "neon",
  "externalAccountId": "acc_neon_998877",
  "connectionStatus": "active",
  "createdAt": "2026-10-14T03:30:00Z"
}
```

### Error Responses
- `401 Unauthorized` (`UNAUTHORIZED`): Not authenticated.
- `404 Not Found` (`CONNECTION_NOT_FOUND`): Connection not found or owned by another user.

---

## 4. POST `/api/v1/connections/{connection_id}/test`
### Description
Tests connectivity and token validity against upstream provider APIs (e.g., calls Neon `/projects` or Vercel `/v2/user`).

- **Auth:** Required
- **Path Params:** `connection_id` (`string`, required)

### Success Response (`200 OK`)
```json
{
  "connectionId": "con_1234567890ab",
  "providerType": "neon",
  "status": "valid",
  "latencyMs": 142,
  "testedAt": "2026-10-14T03:33:00Z"
}
```

### Error Responses
- `401 Unauthorized` (`UNAUTHORIZED`): Not authenticated.
- `404 Not Found` (`CONNECTION_NOT_FOUND`): Connection not found.
- `502 Bad Gateway` (`PROVIDER_AUTH_FAILED`): Provider rejected the credentials.

### Side Effects
- Updates `connection_status` in database.

---

## 5. DELETE `/api/v1/connections/{connection_id}`
### Description
Revokes and removes a provider connection. Safeguards prevent deletion if active resources depend on it.

- **Auth:** Required
- **Path Params:** `connection_id` (`string`, required)

### Success Response (`204 No Content`)
*Empty Body*

### Error Responses
- `401 Unauthorized` (`UNAUTHORIZED`): Not authenticated.
- `404 Not Found` (`CONNECTION_NOT_FOUND`): Connection not found.
- `409 Conflict` (`DEPENDENT_RESOURCES_EXIST`): Cannot delete connection while active services or resources are linked to it.

### Side Effects
- Deletes connection record from MongoDB.

---

# Part I: Project Resources
**Base Path:** `/api/v1/projects/{project_id}/resources`  
**Authentication:** Authenticated User Session

---

## 6. POST `/api/v1/projects/{project_id}/resources`
### Description
Provisions a managed resource (e.g. Postgres DB via Neon, MongoDB cluster via Atlas) and binds connection strings into project services.

- **Auth:** Required
- **Path Params:** `project_id` (`string`, required)

### Request Body
```json
{
  "connectionId": "con_1234567890ab",
  "resourceType": "postgres",
  "name": "primary-db",
  "region": "us-east-2"
}
```

### Success Response (`201 Created`)
```json
{
  "resourceId": "res_a1b2c3d4e5f6",
  "projectId": "prj_001122334455",
  "connectionId": "con_1234567890ab",
  "resourceType": "postgres",
  "name": "primary-db",
  "status": "provisioning",
  "connectionStringRef": "enc:v1:postgres://...",
  "createdAt": "2026-10-14T03:35:00Z"
}
```

### Error Responses
- `400 Bad Request` (`UNSUPPORTED_RESOURCE`): Resource type not supported by connected provider.
- `404 Not Found` (`PROJECT_NOT_FOUND`): Project does not exist.
- `502 Bad Gateway` (`PROVISIONING_FAILED`): Upstream provider API failed.

### Side Effects
- Calls provider adapter (`NeonProvider.create_project`).
- Stores resource in MongoDB.
- Emits project activity audit record.

---

## 7. GET `/api/v1/projects/{project_id}/resources`
### Description
Lists all provisioned resources for a project.

- **Auth:** Required
- **Path Params:** `project_id` (`string`, required)

### Success Response (`200 OK`)
```json
[
  {
    "resourceId": "res_a1b2c3d4e5f6",
    "name": "primary-db",
    "resourceType": "postgres",
    "status": "ready",
    "createdAt": "2026-10-14T03:35:00Z"
  }
]
```

---

## 8. GET `/api/v1/projects/{project_id}/resources/{resource_id}`
### Description
Inspects resource configuration and connection endpoint metadata.

- **Auth:** Required
- **Path Params:**
  - `project_id` (`string`, required)
  - `resource_id` (`string`, required)

### Success Response (`200 OK`)
```json
{
  "resourceId": "res_a1b2c3d4e5f6",
  "projectId": "prj_001122334455",
  "name": "primary-db",
  "resourceType": "postgres",
  "status": "ready",
  "host": "ep-fancy-pool-123456.us-east-2.aws.neon.tech",
  "database": "neondb",
  "user": "neondb_owner",
  "createdAt": "2026-10-14T03:35:00Z"
}
```

---

## 9. POST `/api/v1/projects/{project_id}/resources/{resource_id}/rotate-credentials`
### Description
Rotates database or service credentials where supported by the provider, invalidating the previous password and updating secret references.

- **Auth:** Required
- **Path Params:**
  - `project_id` (`string`, required)
  - `resource_id` (`string`, required)

### Success Response (`200 OK`)
```json
{
  "resourceId": "res_a1b2c3d4e5f6",
  "message": "Credentials rotated successfully. Dependent service environment variables updated.",
  "rotatedAt": "2026-10-14T03:40:00Z"
}
```

### Error Responses
- `400 Bad Request` (`ROTATION_NOT_SUPPORTED`): Provider does not support automated rotation.
- `404 Not Found` (`RESOURCE_NOT_FOUND`): Resource not found.
- `502 Bad Gateway` (`PROVIDER_ERROR`): Upstream provider rejected credential reset.

### Side Effects
- Calls provider adapter to regenerate user password.
- Updates encrypted `secret_ref` in MongoDB.

---

## 10. DELETE `/api/v1/projects/{project_id}/resources/{resource_id}`
### Description
Deprovisions and permanently destroys a cloud resource after confirming safeguards.

- **Auth:** Required
- **Path Params:**
  - `project_id` (`string`, required)
  - `resource_id` (`string`, required)
- **Query Params:**
  - `confirm` (`string`, required): Must match resource name to prevent accidental deletion.

### Success Response (`204 No Content`)
*Empty Body*

### Error Responses
- `400 Bad Request` (`CONFIRMATION_MISMATCH`): The `confirm` parameter does not match resource name.
- `404 Not Found` (`RESOURCE_NOT_FOUND`): Resource does not exist.
- `502 Bad Gateway` (`DELETION_FAILED`): Upstream provider deprovisioning error.

### Side Effects
- Calls provider API to terminate remote cluster/database.
- Removes resource document from MongoDB.
