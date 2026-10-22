// Must stay in sync with the services.service_type CHECK constraint in Neon.
// Database *engine* (postgres/mongodb/...) is not a service_type — it belongs in
// service_config, e.g. { "engine": "postgres", "version": "16" }.
export const SERVICE_TYPES = ['frontend', 'backend', 'database'];
