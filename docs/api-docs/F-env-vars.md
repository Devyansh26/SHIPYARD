# API Documentation: F - Environment Variables and Secrets

**Prefix:** `/api/v1/projects/{project_id}/services/{service_id}/env`  
**Authentication:** Cookie Session (`connect.sid`) or Bearer Session Token

---

## Security Model & Secret Handling Principles
- **Masking:** Sensitive environment variables are NEVER returned in cleartext via list or read APIs. If `sensitive: true`, the API returns `"value": "********"`.
- **Encrypted Storage:** Values are encrypted at rest using AES-256-GCM. The database stores only the reference: `secret_ref: "enc:v1:<iv>:<auth_tag>:<ciphertext>"`.
- **Scope Isolation:** Variables can be scoped to `production`, `preview`, or `all`.

---

## 1. GET `/api/v1/projects/{project_id}/services/{service_id}/env`
### Description
Lists all environment variables defined for a service with metadata and masked values for sensitive secrets.

- **Auth:** Required (Authenticated user owning the project)
- **Path Params:**
  - `project_id` (`string`, required): Unique project identifier (`prj_*`).
  - `service_id` (`string`, required): Unique service identifier (`svc_*`).
- **Query Params:**
  - `scope` (`string`, optional): Filter variables by scope (`production`, `preview`, `all`).

### Success Response (`200 OK`)
```json
[
  {
    "varId": "var_a1b2c3d4e5f6",
    "key": "PORT",
    "value": "8000",
    "sensitive": false,
    "scope": "all",
    "updatedAt": "2026-10-14T01:00:00Z"
  },
  {
    "varId": "var_9876543210ab",
    "key": "DATABASE_URL",
    "value": "********",
    "sensitive": true,
    "scope": "production",
    "updatedAt": "2026-10-14T01:05:00Z"
  }
]
```

### Error Responses
- `401 Unauthorized` (`UNAUTHORIZED`): User is not authenticated.
- `403 Forbidden` (`FORBIDDEN`): User does not own the project.
- `404 Not Found` (`SERVICE_NOT_FOUND`): Project or service does not exist.

### Side Effects
- None.

---

## 2. PUT `/api/v1/projects/{project_id}/services/{service_id}/env`
### Description
Replaces the entire environment variable configuration of a service atomically. Any existing variable omitted in the request will be deleted.

- **Auth:** Required

### Request Body
```json
{
  "variables": [
    {
      "key": "NODE_ENV",
      "value": "production",
      "sensitive": false,
      "scope": "production"
    },
    {
      "key": "JWT_SECRET",
      "value": "ultra-secure-random-passphrase-32b",
      "sensitive": true,
      "scope": "production"
    }
  ]
}
```

### Success Response (`200 OK`)
```json
{
  "count": 2,
  "message": "Environment configuration successfully replaced",
  "variables": [
    {
      "varId": "var_112233445566",
      "key": "NODE_ENV",
      "value": "production",
      "sensitive": false,
      "scope": "production",
      "updatedAt": "2026-10-14T03:10:00Z"
    },
    {
      "varId": "var_778899001122",
      "key": "JWT_SECRET",
      "value": "********",
      "sensitive": true,
      "scope": "production",
      "updatedAt": "2026-10-14T03:10:00Z"
    }
  ]
}
```

### Error Responses
- `400 Bad Request` (`DUPLICATE_KEY`): Duplicate environment keys provided in array.
- `401 Unauthorized` (`UNAUTHORIZED`): Session invalid or expired.
- `404 Not Found` (`SERVICE_NOT_FOUND`): Service not found.

### Side Effects
- Encrypts sensitive values via `EncryptionService`.
- Replaces records in MongoDB `environment_vars` collection within a transaction.

---

## 3. PATCH `/api/v1/projects/{project_id}/services/{service_id}/env/{key}`
### Description
Adds or updates a single environment variable by key.

- **Auth:** Required
- **Path Params:**
  - `project_id` (`string`, required)
  - `service_id` (`string`, required)
  - `key` (`string`, required): Environment variable key name (e.g., `DATABASE_URL`).

### Request Body
```json
{
  "value": "postgres://user:secret@neon.tech/main",
  "sensitive": true,
  "scope": "production"
}
```

### Success Response (`200 OK`)
```json
{
  "varId": "var_9876543210ab",
  "key": "DATABASE_URL",
  "value": "********",
  "sensitive": true,
  "scope": "production",
  "updatedAt": "2026-10-14T03:15:00Z"
}
```

### Error Responses
- `400 Bad Request` (`INVALID_KEY_FORMAT`): Key contains forbidden characters or fails standard env var regex `^[A-Z_][A-Z0-9_]*$`.
- `401 Unauthorized` (`UNAUTHORIZED`): User not authenticated.
- `404 Not Found` (`SERVICE_NOT_FOUND`): Service not found.

### Side Effects
- Encrypts updated value if sensitive.
- Upserts variable into MongoDB `environment_vars` collection.

---

## 4. DELETE `/api/v1/projects/{project_id}/services/{service_id}/env/{key}`
### Description
Deletes a single environment variable by key.

- **Auth:** Required
- **Path Params:**
  - `project_id` (`string`, required)
  - `service_id` (`string`, required)
  - `key` (`string`, required)

### Success Response (`204 No Content`)
*Empty Body*

### Error Responses
- `401 Unauthorized` (`UNAUTHORIZED`): Authentication failed.
- `403 Forbidden` (`FORBIDDEN`): Unauthorized access.
- `404 Not Found` (`KEY_NOT_FOUND`): Environment variable does not exist.

### Side Effects
- Removes variable document from MongoDB `environment_vars` collection.
