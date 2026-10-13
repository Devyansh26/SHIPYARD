# API Documentation: G - Domains, Routing, and Load Balancing

This section covers custom domain management (with automated DNS verification challenges) and path-based ingress routing (Traefik/Caddy dynamic configuration) for deployed services.

---

# Part 1: Project Domains
**Base Path:** `/api/v1/projects/{project_id}/domains`  
**Authentication:** Authenticated User Session

---

## 1. POST `/api/v1/projects/{project_id}/domains`
### Description
Associates a custom domain with a project and returns DNS TXT and CNAME verification challenge records.

- **Auth:** Required
- **Path Params:** `project_id` (`string`, required)

### Request Body
```json
{
  "domain": "api.mydomain.com",
  "serviceId": "svc_1234567890ab"
}
```

### Success Response (`201 Created`)
```json
{
  "domainId": "dom_a1b2c3d4e5f6",
  "domain": "api.mydomain.com",
  "serviceId": "svc_1234567890ab",
  "verificationStatus": "pending",
  "tlsStatus": "pending",
  "verificationRecord": {
    "type": "TXT",
    "name": "_shipyard-challenge.api.mydomain.com",
    "value": "shipyard-verify-a8f9c0e2b1d4"
  },
  "cnameRecord": {
    "type": "CNAME",
    "name": "api.mydomain.com",
    "value": "ingress.shipyard.lan"
  },
  "createdAt": "2026-10-14T03:20:00Z"
}
```

### Error Responses
- `400 Bad Request` (`INVALID_DOMAIN`): Domain format invalid or already claimed by another user.
- `401 Unauthorized` (`UNAUTHORIZED`): Session expired.
- `404 Not Found` (`PROJECT_NOT_FOUND`): Project does not exist.

### Side Effects
- Saves domain record into MongoDB `domains` collection.

---

## 2. GET `/api/v1/projects/{project_id}/domains`
### Description
Lists all registered domains and their SSL/TLS verification statuses for a project.

- **Auth:** Required
- **Path Params:** `project_id` (`string`, required)

### Success Response (`200 OK`)
```json
[
  {
    "domainId": "dom_a1b2c3d4e5f6",
    "domain": "api.mydomain.com",
    "serviceId": "svc_1234567890ab",
    "verificationStatus": "verified",
    "tlsStatus": "active",
    "createdAt": "2026-10-14T03:20:00Z"
  }
]
```

### Error Responses
- `401 Unauthorized` (`UNAUTHORIZED`): Not authenticated.
- `403 Forbidden` (`FORBIDDEN`): Unauthorized access.
- `404 Not Found` (`PROJECT_NOT_FOUND`): Project not found.

---

## 3. GET `/api/v1/projects/{project_id}/domains/{domain_id}`
### Description
Inspects domain status, DNS target records, and TLS provisioning details.

- **Auth:** Required
- **Path Params:**
  - `project_id` (`string`, required)
  - `domain_id` (`string`, required)

### Success Response (`200 OK`)
```json
{
  "domainId": "dom_a1b2c3d4e5f6",
  "domain": "api.mydomain.com",
  "serviceId": "svc_1234567890ab",
  "verificationStatus": "pending",
  "tlsStatus": "pending",
  "verificationRecord": {
    "type": "TXT",
    "name": "_shipyard-challenge.api.mydomain.com",
    "value": "shipyard-verify-a8f9c0e2b1d4"
  },
  "cnameRecord": {
    "type": "CNAME",
    "name": "api.mydomain.com",
    "value": "ingress.shipyard.lan"
  },
  "createdAt": "2026-10-14T03:20:00Z"
}
```

### Error Responses
- `401 Unauthorized` (`UNAUTHORIZED`): Authentication failed.
- `404 Not Found` (`DOMAIN_NOT_FOUND`): Domain not found.

---

## 4. POST `/api/v1/projects/{project_id}/domains/{domain_id}/verify`
### Description
Queries public DNS servers to verify whether the TXT challenge record has propagated.

- **Auth:** Required
- **Path Params:**
  - `project_id` (`string`, required)
  - `domain_id` (`string`, required)

### Success Response (`200 OK`)
```json
{
  "domainId": "dom_a1b2c3d4e5f6",
  "domain": "api.mydomain.com",
  "verificationStatus": "verified",
  "tlsStatus": "provisioning",
  "message": "DNS challenge verified successfully. TLS certificate acquisition initiated."
}
```

### Error Responses
- `400 Bad Request` (`DNS_RECORD_MISMATCH`): TXT record does not match expected challenge token.
- `404 Not Found` (`DOMAIN_NOT_FOUND`): Domain not found.
- `504 Gateway Timeout` (`DNS_LOOKUP_TIMEOUT`): Upstream DNS resolver timed out.

### Side Effects
- Updates `verificationStatus` to `verified` in MongoDB.
- Triggers Let's Encrypt / ACME cert provisioning via Traefik.

---

## 5. DELETE `/api/v1/projects/{project_id}/domains/{domain_id}`
### Description
Removes a custom domain association and revokes routing from the reverse proxy.

- **Auth:** Required
- **Path Params:**
  - `project_id` (`string`, required)
  - `domain_id` (`string`, required)

### Success Response (`204 No Content`)
*Empty Body*

### Error Responses
- `401 Unauthorized` (`UNAUTHORIZED`): Not authenticated.
- `404 Not Found` (`DOMAIN_NOT_FOUND`): Domain not found.

### Side Effects
- Deletes domain from MongoDB.
- Deprovisions Traefik ingress route.

---

# Part 2: Service Ingress Routes
**Base Path:** `/api/v1/projects/{project_id}/services/{service_id}/routes`  
**Authentication:** Authenticated User Session

---

## 6. POST `/api/v1/projects/{project_id}/services/{service_id}/routes`
### Description
Defines an HTTP path prefix or hostname rule pointing to this specific service.

- **Auth:** Required
- **Path Params:**
  - `project_id` (`string`, required)
  - `service_id` (`string`, required)

### Request Body
```json
{
  "pathPrefix": "/api/v1",
  "stripPrefix": false,
  "targetPort": 8000
}
```

### Success Response (`201 Created`)
```json
{
  "routeId": "rot_112233445566",
  "serviceId": "svc_1234567890ab",
  "pathPrefix": "/api/v1",
  "stripPrefix": false,
  "targetPort": 8000,
  "createdAt": "2026-10-14T03:22:00Z"
}
```

### Error Responses
- `400 Bad Request` (`INVALID_PATH_PREFIX`): Path prefix must start with `/`.
- `404 Not Found` (`SERVICE_NOT_FOUND`): Service not found.
- `409 Conflict` (`ROUTE_COLLISION`): Path prefix already allocated to another service.

### Side Effects
- Stores route in MongoDB.
- Re-generates dynamic reverse proxy routing definitions.

---

## 7. GET `/api/v1/projects/{project_id}/services/{service_id}/routes`
### Description
Lists all active ingress routes mapped to the given service.

- **Auth:** Required
- **Path Params:**
  - `project_id` (`string`, required)
  - `service_id` (`string`, required)

### Success Response (`200 OK`)
```json
[
  {
    "routeId": "rot_112233445566",
    "serviceId": "svc_1234567890ab",
    "pathPrefix": "/api/v1",
    "stripPrefix": false,
    "targetPort": 8000
  }
]
```

### Error Responses
- `401 Unauthorized` (`UNAUTHORIZED`): Session invalid.
- `404 Not Found` (`SERVICE_NOT_FOUND`): Service not found.

---

## 8. PATCH `/api/v1/projects/{project_id}/services/{service_id}/routes/{route_id}`
### Description
Updates an existing route configuration (e.g. changing target port or strip prefix behavior).

- **Auth:** Required
- **Path Params:**
  - `project_id` (`string`, required)
  - `service_id` (`string`, required)
  - `route_id` (`string`, required)

### Request Body
```json
{
  "stripPrefix": true,
  "targetPort": 8080
}
```

### Success Response (`200 OK`)
```json
{
  "routeId": "rot_112233445566",
  "serviceId": "svc_1234567890ab",
  "pathPrefix": "/api/v1",
  "stripPrefix": true,
  "targetPort": 8080,
  "updatedAt": "2026-10-14T03:25:00Z"
}
```

### Error Responses
- `400 Bad Request` (`INVALID_PORT`): Port number out of bounds.
- `404 Not Found` (`ROUTE_NOT_FOUND`): Route does not exist.

---

## 9. DELETE `/api/v1/projects/{project_id}/services/{service_id}/routes/{route_id}`
### Description
Deletes an ingress route.

- **Auth:** Required
- **Path Params:**
  - `project_id` (`string`, required)
  - `service_id` (`string`, required)
  - `route_id` (`string`, required)

### Success Response (`204 No Content`)
*Empty Body*

### Error Responses
- `401 Unauthorized` (`UNAUTHORIZED`): Not authenticated.
- `404 Not Found` (`ROUTE_NOT_FOUND`): Route not found.

### Side Effects
- Removes route from database.
- Hot-reloads reverse proxy config.
