# Section A — Authentication API

**Service:** `api-server` (public-facing REST API)  
**Base URL:** `https://shipyard.app/api/v1/auth`  
**Version:** v1

---

## Security Model

> [!IMPORTANT]
> ShipYard uses **HTTP-only cookie-based sessions**. The GitHub OAuth access token is **never** returned to the browser or included in any JSON response body. It is encrypted at rest using AES-256-GCM and stored in the server-side session store (Redis). The browser only holds an opaque, signed session cookie (`shipyard_sid`).

### Session Cookie Properties

| Property   | Value             | Reason                                                   |
|------------|-------------------|----------------------------------------------------------|
| `HttpOnly` | `true`            | Prevents JavaScript from reading the cookie              |
| `Secure`   | `true` (prod)     | Only transmitted over HTTPS                              |
| `SameSite` | `Lax`             | Mitigates CSRF for top-level navigations                 |
| `Path`     | `/`               | Available to all API routes                              |
| `MaxAge`   | `604800` (7 days) | Session lifetime; refreshed on each authenticated request |

### GitHub Token Storage

```
GitHub Token (plaintext from OAuth exchange)
        │
        ▼
  AES-256-GCM encrypt  (key = ENCRYPTION_SECRET env var, stored in Vault/env)
        │
        ▼
  Stored in Redis session store  →  key: session:<sid>:github_token
        │
        ▼
  Decrypted on demand (per-request) before any GitHub API call
        │
        ▼
  Used in-memory only; never persisted to application DB
```

The GitHub token is **never**:
- Returned in any JSON response body
- Logged at any log level (even `debug`)
- Stored in the PostgreSQL application database

---

## Endpoints

---

### A-1 · Initiate GitHub OAuth

```
GET /api/v1/auth/github
```

Redirects the browser to GitHub's OAuth authorization page. Generates and stores a CSRF `state` parameter in the session before redirecting, preventing cross-site request forgery on the callback.

**Auth Required:** No  
**Side Effects:**
- Generates a cryptographically random `state` string and writes it to the current session (Redis TTL: 10 minutes)
- Sets the `shipyard_sid` session cookie if not already present
- Stores the `redirect_to` value in the session for post-login navigation

#### Query Parameters

| Name          | Type     | Required | Default | Description                                                             |
|---------------|----------|----------|---------|-------------------------------------------------------------------------|
| `redirect_to` | `string` | No       | `/`     | Post-login URL within shipyard.app the user should land on after OAuth  |

#### Response — `302 Found`

| Header       | Value                                                                           |
|--------------|---------------------------------------------------------------------------------|
| `Location`   | `https://github.com/login/oauth/authorize?client_id=...&scope=repo,user&state=...` |
| `Set-Cookie` | `shipyard_sid=...; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`     |

#### Error Responses

| Status | Error Code               | Description                                            |
|--------|--------------------------|--------------------------------------------------------|
| `400`  | `INVALID_REDIRECT_URL`   | `redirect_to` targets an external domain               |
| `500`  | `SESSION_INIT_FAILED`    | Redis unavailable; session could not be created        |
| `503`  | `OAUTH_PROVIDER_UNAVAIL` | GitHub OAuth endpoint unreachable (circuit breaker open)|

---

### A-2 · GitHub OAuth Callback

```
GET /api/v1/auth/github/callback
```

GitHub redirects here after the user grants (or denies) access. Validates the `state` CSRF token, exchanges the `code` for a GitHub access token, fetches the user's GitHub profile, upserts the user record in the database, and establishes the authenticated session.

**Auth Required:** No  
**Side Effects:**
- Validates `state` against session value (clears it after check to prevent replay)
- Exchanges `code` → GitHub OAuth access token via server-to-server POST
- Encrypts and stores the access token in the session
- Upserts a row in the `users` table: (`github_id`, `login`, `email`, `avatar_url`, `name`)
- Writes `last_login_at` timestamp to `users` table
- Regenerates session ID (protection against session fixation attacks)
- Redirects browser to `redirect_to` stored in session

#### Query Parameters

| Name    | Type     | Required | Default | Description                                                |
|---------|----------|----------|---------|------------------------------------------------------------|
| `code`  | `string` | Yes      | —       | Temporary one-time code issued by GitHub                   |
| `state` | `string` | Yes      | —       | CSRF state token; must match value stored in session       |
| `error` | `string` | No       | —       | Set by GitHub to `access_denied` if user declined          |

#### Response — `302 Found` (success)

| Header       | Value                                                       |
|--------------|-------------------------------------------------------------|
| `Location`   | Value of `redirect_to` from session, or `/` as fallback     |
| `Set-Cookie` | Refreshed `shipyard_sid` with new session ID (regenerated)  |

#### Error Responses

| Status | Error Code                      | Description                                                   |
|--------|---------------------------------|---------------------------------------------------------------|
| `400`  | `STATE_MISMATCH`                | `state` param does not match session value (CSRF attempt)     |
| `400`  | `OAUTH_CODE_MISSING`            | `code` query param is absent from the callback                |
| `401`  | `OAUTH_DENIED`                  | User clicked "Deny" on GitHub (`error=access_denied`)         |
| `502`  | `GITHUB_TOKEN_EXCHANGE_FAILED`  | GitHub returned non-200 during code ↔ token exchange          |
| `502`  | `GITHUB_PROFILE_FETCH_FAILED`   | Could not fetch `/user` profile from GitHub API               |
| `500`  | `USER_UPSERT_FAILED`            | Database write failed during user create/update               |

---

### A-3 · Get Current Authenticated User

```
GET /api/v1/auth/me
```

Returns the authenticated user's profile as stored in the database. Does **not** expose the GitHub access token or any session internals.

**Auth Required:** Yes (session cookie)  
**Side Effects:** None (read-only)

#### Response — `200 OK`

```json
{
  "id": "usr_01j9kmx8p4fgvw3nq7ztxd6b0e",
  "github_id": 1234567,
  "login": "octocat",
  "name": "The Octocat",
  "email": "octocat@github.com",
  "avatar_url": "https://avatars.githubusercontent.com/u/1234567?v=4",
  "created_at": "2026-01-15T10:30:00Z",
  "last_login_at": "2026-10-14T03:01:00Z"
}
```

#### Response Body Schema

| Field           | Type              | Nullable | Description                                          |
|-----------------|-------------------|----------|------------------------------------------------------|
| `id`            | `string` (ULID)   | No       | Internal ShipYard user identifier                    |
| `github_id`     | `number`          | No       | GitHub's numeric user ID (stable; login can change)  |
| `login`         | `string`          | No       | GitHub username handle                               |
| `name`          | `string`          | Yes      | Full display name (null if not set on GitHub profile)|
| `email`         | `string`          | Yes      | Primary email (null if user set email to private)    |
| `avatar_url`    | `string`          | No       | GitHub avatar CDN URL                                |
| `created_at`    | `string` (ISO8601)| No       | Timestamp of first ShipYard login                    |
| `last_login_at` | `string` (ISO8601)| No       | Timestamp of most recent login                       |

#### Error Responses

| Status | Error Code           | Description                                           |
|--------|----------------------|-------------------------------------------------------|
| `401`  | `NOT_AUTHENTICATED`  | No valid session cookie present                       |
| `404`  | `USER_NOT_FOUND`     | Session valid but user record deleted from database   |
| `500`  | `SESSION_READ_ERROR` | Redis unavailable; session could not be read          |

---

### A-4 · Logout

```
POST /api/v1/auth/logout
```

Destroys the server-side session record and instructs the browser to clear the session cookie by setting `Max-Age=0`. The encrypted GitHub token stored in the session is permanently deleted from Redis.

**Auth Required:** Yes (session cookie)  
**Side Effects:**
- Deletes the session record from Redis (GitHub token permanently lost)
- Sets `Set-Cookie: shipyard_sid=; Max-Age=0` to clear the browser cookie
- GitHub token is **not** explicitly revoked at GitHub — token TTL is governed by GitHub OAuth App settings

> [!NOTE]
> Using `POST` (not `GET`) for logout prevents image-tag or link-prefetch attacks from inadvertently logging out a user.

#### Request Body

None.

#### Response — `204 No Content`

```
HTTP/1.1 204 No Content
Set-Cookie: shipyard_sid=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/
```

#### Error Responses

| Status | Error Code                | Description                                       |
|--------|---------------------------|---------------------------------------------------|
| `401`  | `NOT_AUTHENTICATED`       | No active session to destroy                      |
| `500`  | `SESSION_DESTROY_FAILED`  | Redis error; session record could not be deleted  |
| `500`  | `COOKIE_CLEAR_FAILED`     | Unexpected internal error writing response header |

---

### A-5 · List GitHub Repositories

```
GET /api/v1/auth/github/repos
```

Proxies a request to the GitHub API to list repositories accessible to the authenticated user (owned, member, or organization repos depending on `type`). Results are **not** cached — each call makes a live request to GitHub.

**Auth Required:** Yes (session cookie + valid GitHub token in session)  
**Side Effects:** None (proxied read-only GitHub API call)

#### Query Parameters

| Name       | Type     | Required | Default  | Description                                                              |
|------------|----------|----------|----------|--------------------------------------------------------------------------|
| `page`     | `number` | No       | `1`      | GitHub API page number (1-indexed)                                       |
| `per_page` | `number` | No       | `30`     | Items per page (min: `1`, max: `100`)                                    |
| `sort`     | `string` | No       | `pushed` | Sort field: `created` \| `updated` \| `pushed` \| `full_name`           |
| `type`     | `string` | No       | `all`    | Repo scope: `all` \| `owner` \| `member`                                |

#### Response — `200 OK`

```json
{
  "data": [
    {
      "id": 123456789,
      "full_name": "octocat/hello-world",
      "name": "hello-world",
      "private": false,
      "default_branch": "main",
      "html_url": "https://github.com/octocat/hello-world",
      "description": "My first repository on GitHub!",
      "updated_at": "2026-10-01T08:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "per_page": 30,
    "has_next": true
  }
}
```

#### Response Body Schema — `data[]`

| Field            | Type      | Description                                          |
|------------------|-----------|------------------------------------------------------|
| `id`             | `number`  | GitHub repository numeric ID                         |
| `full_name`      | `string`  | `owner/repo` qualified name                          |
| `name`           | `string`  | Repository name only                                 |
| `private`        | `boolean` | Whether the repo is private                          |
| `default_branch` | `string`  | Name of the repository's default branch              |
| `html_url`       | `string`  | GitHub web URL for the repository                    |
| `description`    | `string \| null` | Repository description                        |
| `updated_at`     | `string`  | ISO 8601 timestamp of last push                      |

#### Error Responses

| Status | Error Code               | Description                                                     |
|--------|--------------------------|-----------------------------------------------------------------|
| `401`  | `NOT_AUTHENTICATED`      | No valid session                                                |
| `401`  | `GITHUB_TOKEN_MISSING`   | Session exists but GitHub token absent (user must re-login)     |
| `429`  | `GITHUB_RATE_LIMITED`    | GitHub API rate limit exceeded; `Retry-After` header included   |
| `502`  | `GITHUB_API_ERROR`       | GitHub returned non-2xx; response includes `github_status` field|

---

### A-6 · List Repository Branches

```
GET /api/v1/auth/github/repos/{owner}/{repo}/branches
```

Lists branches for the specified GitHub repository. Results are proxied live from the GitHub API. Used in the frontend service configuration UI when selecting a deployment branch.

**Auth Required:** Yes (session cookie)  
**Side Effects:** None (proxied read-only)

#### Path Parameters

| Name    | Type     | Description                          |
|---------|----------|--------------------------------------|
| `owner` | `string` | GitHub username or organization name |
| `repo`  | `string` | Repository name (without `.git`)     |

#### Query Parameters

| Name       | Type     | Required | Default | Description                         |
|------------|----------|----------|---------|-------------------------------------|
| `page`     | `number` | No       | `1`     | Page number (1-indexed)             |
| `per_page` | `number` | No       | `30`    | Items per page (max: `100`)         |

#### Response — `200 OK`

```json
{
  "data": [
    {
      "name": "main",
      "commit": {
        "sha": "6dcb09b5b57875f334f61aebed695e2e4193db5e",
        "url": "https://api.github.com/repos/octocat/hello-world/commits/6dcb09b5b578..."
      },
      "protected": true
    },
    {
      "name": "feature/new-ui",
      "commit": {
        "sha": "abc123def456789...",
        "url": "https://api.github.com/repos/octocat/hello-world/commits/abc123def456..."
      },
      "protected": false
    }
  ],
  "pagination": {
    "page": 1,
    "per_page": 30,
    "has_next": false
  }
}
```

#### Error Responses

| Status | Error Code              | Description                                                           |
|--------|-------------------------|-----------------------------------------------------------------------|
| `401`  | `NOT_AUTHENTICATED`     | No valid session                                                      |
| `403`  | `REPO_ACCESS_DENIED`    | Authenticated user lacks read access to this repository               |
| `404`  | `REPO_NOT_FOUND`        | Repository does not exist or is not visible with the current token    |
| `429`  | `GITHUB_RATE_LIMITED`   | GitHub API rate limit hit; `Retry-After` header included              |
| `502`  | `GITHUB_API_ERROR`      | GitHub returned a non-2xx response                                    |

---

### A-7 · List Repository Commits

```
GET /api/v1/auth/github/repos/{owner}/{repo}/commits
```

Lists recent commits for a given branch of a GitHub repository. Used by the frontend to allow users to select a specific commit SHA for pinned ("immutable ref") deployments.

**Auth Required:** Yes (session cookie)  
**Side Effects:** None (proxied read-only)

#### Path Parameters

| Name    | Type     | Description                          |
|---------|----------|--------------------------------------|
| `owner` | `string` | GitHub username or organization name |
| `repo`  | `string` | Repository name (without `.git`)     |

#### Query Parameters

| Name       | Type     | Required | Default              | Description                                      |
|------------|----------|----------|----------------------|--------------------------------------------------|
| `branch`   | `string` | No       | Repo's default branch | Branch name or SHA to list commits from          |
| `page`     | `number` | No       | `1`                  | Page number (1-indexed)                          |
| `per_page` | `number` | No       | `20`                 | Items per page (max: `100`)                      |

#### Response — `200 OK`

```json
{
  "data": [
    {
      "sha": "6dcb09b5b57875f334f61aebed695e2e4193db5e",
      "message": "Fix: resolve null pointer in auth middleware",
      "author": {
        "name": "The Octocat",
        "email": "octocat@github.com",
        "date": "2026-10-13T18:42:00Z"
      },
      "html_url": "https://github.com/octocat/hello-world/commit/6dcb09b5..."
    }
  ],
  "pagination": {
    "page": 1,
    "per_page": 20,
    "has_next": true
  }
}
```

#### Error Responses

| Status | Error Code              | Description                                                           |
|--------|-------------------------|-----------------------------------------------------------------------|
| `401`  | `NOT_AUTHENTICATED`     | No valid session                                                      |
| `403`  | `REPO_ACCESS_DENIED`    | Authenticated user lacks read access to this repository               |
| `404`  | `REPO_NOT_FOUND`        | Repository does not exist or not visible with current token           |
| `422`  | `INVALID_BRANCH`        | Specified `branch` name does not exist in the repository              |
| `429`  | `GITHUB_RATE_LIMITED`   | GitHub API rate limit hit                                             |
| `502`  | `GITHUB_API_ERROR`      | GitHub returned a non-2xx response                                    |

---

## Standard Error Envelope

All error responses return this consistent JSON shape:

```json
{
  "error": {
    "code": "STATE_MISMATCH",
    "message": "CSRF state token does not match. Please initiate login again.",
    "request_id": "req_01j9abc123xyz"
  }
}
```

| Field        | Type     | Description                                                          |
|--------------|----------|----------------------------------------------------------------------|
| `code`       | `string` | Machine-readable error code (stable across API versions)             |
| `message`    | `string` | Human-readable description suitable for display                      |
| `request_id` | `string` | ULID trace ID for log correlation and support tickets                |
