# Providers (future extension point)

This folder is intentionally empty for now.

Planned interface (do NOT implement yet):

```js
// createAdapter({ providerType, credentialsRef }) => adapter
// adapter.deploy(service, deployment), adapter.logs(...), adapter.destroy(...)
```

Supported `provider_type` values later: `vercel`, `neon`, `atlas`, `homelab`.
`service_type` on services (`frontend` | `backend` | `postgres` | `mongodb`,
see `../services/serviceTypes.js`) will route to the right adapter.
