// Database targets (ADR-7, credential-only variant).
//
// Unlike Vercel and the container host, these adapters do NOT deploy anything.
// The user provisions the database themselves — a Neon project for Postgres, an
// Atlas cluster for Mongo — and pastes its connection string. ShipYard stores
// that string encrypted and hands it to a backend service as an environment
// variable when the two are wired together on the canvas. We never create, grow
// or destroy a database, which is deliberate: dropping someone's production
// data on a mis-click is not a risk worth the convenience.
//
// So the interface here is intentionally smaller than the deployment adapters':
//
//   verify()           -> { verified, method, detail }   does this string work?
//   connectionString() -> plaintext DSN (for env injection only)
//   describe()         -> { host, database, user, label } safe to send to a browser
//
// `database` stays absent from SERVICE_TARGETS in index.js — a database node is
// still not deployable, it is a reference to something that already exists.
import pg from 'pg';
import { buildConfig } from '../../db/pool.js';
import { decryptSecret } from '../../utils/crypto.js';

/**
 * The two supported stores, keyed by `provider_connections.provider_type`.
 * Those values are fixed by the column's CHECK constraint
 * (`vercel | neon | atlas | homelab`), so adding a third store means altering
 * the constraint in Neon as well as adding a row here.
 *
 * `engine` is what a database service node records in `service_config.engine`,
 * and is the user-facing choice ("postgres" / "mongodb") — the provider is
 * derived from it rather than picked separately, because there is exactly one
 * supported host per engine today.
 */
export const DATABASE_PROVIDERS = {
  neon: {
    providerType: 'neon',
    engine: 'postgres',
    label: 'Neon',
    kind: 'sql',
    // postgres:// is the historical alias; both are valid libpq URIs.
    schemes: ['postgresql:', 'postgres:'],
    defaultVarName: 'DATABASE_URL',
    consoleUrl: 'https://console.neon.tech',
    // A live SELECT 1 is possible because `pg` is already a dependency.
    verifyMethod: 'connect',
    placeholder: 'postgresql://user:password@ep-xxx.region.aws.neon.tech/neondb?sslmode=require',
  },
  atlas: {
    providerType: 'atlas',
    engine: 'mongodb',
    label: 'MongoDB Atlas',
    kind: 'nosql',
    schemes: ['mongodb+srv:', 'mongodb:'],
    defaultVarName: 'MONGODB_URI',
    consoleUrl: 'https://cloud.mongodb.com',
    // No Mongo driver in this service, so the string is checked for shape only.
    // Reported honestly to the UI rather than implied to be a live check.
    verifyMethod: 'format',
    placeholder: 'mongodb+srv://user:password@cluster0.xxxxx.mongodb.net/mydb?retryWrites=true',
  },
};

export const DATABASE_PROVIDER_TYPES = Object.keys(DATABASE_PROVIDERS);
export const DATABASE_ENGINES = DATABASE_PROVIDER_TYPES.map((p) => DATABASE_PROVIDERS[p].engine);

export function isDatabaseProvider(providerType) {
  return Object.hasOwn(DATABASE_PROVIDERS, providerType);
}

/** `service_config.engine` -> the provider that hosts it. */
export function providerForEngine(engine) {
  const normalized = String(engine ?? '').trim().toLowerCase();
  const match = DATABASE_PROVIDER_TYPES.find((p) => DATABASE_PROVIDERS[p].engine === normalized);
  return match ? DATABASE_PROVIDERS[match] : null;
}

export function databaseProvider(providerType) {
  return DATABASE_PROVIDERS[providerType] ?? null;
}

/**
 * Resolves which provider a `database` service node uses, from its engine.
 *
 * The user picks an *engine* ("postgres" / "mongodb") in Settings and the
 * provider follows, because there is exactly one supported host per engine —
 * asking them to choose both would let the two disagree. Lives here rather than
 * in a routes file because both the database routes and the link routes need
 * exactly these rules.
 *
 * Takes a serialized service (as returned by `serializeService`).
 */
export function providerForService(service) {
  if (service.serviceType !== 'database') {
    const e = new Error(
      `Only database services have a connection string — "${service.name}" is a `
      + `${service.serviceType} service.`
    );
    e.status = 400; e.code = 'NOT_A_DATABASE_SERVICE'; throw e;
  }
  const engine = service.serviceConfig?.engine ?? 'postgres';
  const provider = providerForEngine(engine);
  if (!provider) {
    const e = new Error(
      `Engine "${engine}" has no supported provider. Set the engine to one of: `
      + `${DATABASE_ENGINES.join(', ')}.`
    );
    e.status = 400; e.code = 'UNSUPPORTED_ENGINE'; throw e;
  }
  return provider;
}

/** The provider table, shaped for the browser. Contains nothing secret. */
export function publicProvider(provider) {
  return {
    providerType: provider.providerType,
    label: provider.label,
    engine: provider.engine,
    kind: provider.kind,
    consoleUrl: provider.consoleUrl,
    defaultVarName: provider.defaultVarName,
    verifyMethod: provider.verifyMethod,
    placeholder: provider.placeholder,
  };
}

function fail(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

/**
 * Pulls the host/database/user out of a connection string so the UI can show
 * WHICH database is attached without ever seeing the password.
 *
 * Throws 400 INVALID_CONNECTION_STRING on anything that is not a URI for this
 * provider — catching a pasted psql command or an Atlas "connect with mongosh"
 * snippet here is much kinder than a cryptic failure inside a container later.
 */
export function parseConnectionString(providerType, raw) {
  const provider = databaseProvider(providerType);
  if (!provider) throw fail(400, 'UNSUPPORTED_PROVIDER', `"${providerType}" is not a database provider`);

  const trimmed = String(raw ?? '').trim();
  if (trimmed === '') {
    throw fail(400, 'INVALID_CONNECTION_STRING', 'A connection string is required');
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw fail(
      400,
      'INVALID_CONNECTION_STRING',
      `That is not a valid ${provider.label} connection string. It should start with `
      + `${provider.schemes[0]}// — copy the URI form from ${provider.consoleUrl}.`
    );
  }

  if (!provider.schemes.includes(url.protocol)) {
    throw fail(
      400,
      'INVALID_CONNECTION_STRING',
      `Expected a ${provider.label} URI starting with ${provider.schemes.join(' or ')}`
      + `// but got "${url.protocol}//".`
    );
  }
  if (!url.hostname) {
    throw fail(400, 'INVALID_CONNECTION_STRING', 'The connection string has no host');
  }

  // Mongo allows an empty path (the database is then chosen by the driver);
  // Postgres effectively requires one, and a missing one is a common paste error.
  const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || null;
  if (provider.kind === 'sql' && !database) {
    throw fail(
      400,
      'INVALID_CONNECTION_STRING',
      'The connection string does not name a database (expected a path like /neondb).'
    );
  }

  // A URI with no user at all is a truncated paste in practice — both consoles
  // hand out `user:password@host`. Catching it here beats a container failing
  // to authenticate three minutes into a deploy.
  const user = url.username ? decodeURIComponent(url.username) : null;
  if (!user) {
    throw fail(
      400,
      'INVALID_CONNECTION_STRING',
      'The connection string has no username. Copy the full URI, including '
      + `credentials, from ${provider.consoleUrl}.`
    );
  }

  // Postgres without a password is always a truncated paste. Mongo is not: X.509
  // and AWS-IAM auth legitimately omit it, so warn instead of refusing.
  const warnings = [];
  if (!url.password) {
    if (provider.kind === 'sql') {
      throw fail(
        400,
        'INVALID_CONNECTION_STRING',
        'The connection string has no password. Copy the full URI, including the '
        + 'secret, from your provider console.'
      );
    }
    warnings.push(
      'No password in the URI — this only works if your cluster uses certificate '
      + 'or IAM authentication.'
    );
  }

  return {
    providerType,
    engine: provider.engine,
    scheme: url.protocol.replace(/:$/, ''),
    host: url.hostname,
    port: url.port || null,
    database,
    user,
    warnings,
    // Stored in `external_account_id` and shown in the UI: identifies the
    // database unambiguously and contains no credential.
    label: database ? `${url.hostname}/${database}` : url.hostname,
  };
}

/**
 * Redacts a connection string for display/logging. Never log the raw string —
 * it is a credential. Kept here next to the parser so there is one place that
 * knows which part is secret.
 */
export function redactConnectionString(raw) {
  try {
    const url = new URL(String(raw ?? '').trim());
    if (url.password) url.password = '****';
    return url.toString();
  } catch {
    return '(unparseable connection string)';
  }
}

const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Does this string actually work?
 *
 * Postgres gets a real connection and `SELECT 1`, so a wrong password fails
 * here rather than inside a container three minutes into a deploy. The TLS
 * handling is shared with the main pool (see db/pool.js) because Neon's
 * `?sslmode=require` otherwise means `verify-full` to pg-connection-string.
 *
 * Mongo gets shape validation only — this service has no Mongo driver — and
 * says so in `method`, which the UI surfaces rather than claiming a check it
 * did not perform.
 */
export async function verifyConnectionString(providerType, raw) {
  const parsed = parseConnectionString(providerType, raw);
  const provider = databaseProvider(providerType);

  if (provider.verifyMethod !== 'connect') {
    return {
      verified: false,
      method: 'format',
      detail: `${provider.label} connection strings are checked for format only — `
        + 'credentials are confirmed the first time a service uses them.',
      ...parsed,
    };
  }

  const config = buildConfig(String(raw).trim());
  const client = new pg.Client({
    ...config,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    // Never let a verification hang a request thread on a wedged server.
    query_timeout: CONNECT_TIMEOUT_MS,
    statement_timeout: CONNECT_TIMEOUT_MS,
    application_name: 'shipyard-connection-check',
  });

  try {
    await client.connect();
    const { rows } = await client.query('SELECT version() AS version, current_database() AS db');
    return {
      verified: true,
      method: 'connect',
      detail: String(rows[0]?.version ?? '').split(' ').slice(0, 2).join(' ') || 'Connected',
      ...parsed,
      database: rows[0]?.db ?? parsed.database,
    };
  } catch (e) {
    // Map the handful of pg failures a user can actually act on. The message is
    // authored (it carries .status), so errorHandler forwards it verbatim.
    const text = String(e.message ?? '');
    if (e.code === '28P01' || /password authentication failed/i.test(text)) {
      throw fail(409, 'DATABASE_AUTH_FAILED', 'The database rejected those credentials.');
    }
    if (e.code === '3D000' || /database .* does not exist/i.test(text)) {
      throw fail(409, 'DATABASE_NOT_FOUND', `Database "${parsed.database}" does not exist on that host.`);
    }
    if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') {
      throw fail(409, 'DATABASE_HOST_NOT_FOUND', `Host "${parsed.host}" could not be resolved.`);
    }
    if (e.code === 'ETIMEDOUT' || /timeout/i.test(text)) {
      throw fail(
        504,
        'DATABASE_UNREACHABLE',
        `Could not reach ${parsed.host} within ${CONNECT_TIMEOUT_MS / 1000}s. `
        + 'If the project is suspended, open it once in the provider console and retry.'
      );
    }
    throw fail(409, 'DATABASE_CONNECT_FAILED', `Could not connect: ${text || 'unknown error'}`);
  } finally {
    // end() on a client that never connected rejects; it is not worth surfacing.
    await client.end().catch(() => {});
  }
}

/**
 * Adapter over a stored database connection. `credentialsRef` is the stored
 * ciphertext, so decryption happens in here and no caller handles a plaintext
 * DSN except the one that injects it into an environment variable.
 */
export function createDatabaseAdapter({ providerType, credentialsRef }) {
  const provider = databaseProvider(providerType);
  if (!provider) {
    throw fail(400, 'UNSUPPORTED_PROVIDER', `No database adapter for "${providerType}"`);
  }

  // Decrypt lazily: describing a connection must keep working even if the row
  // was encrypted under a previous TOKEN_ENCRYPTION_KEY.
  const plaintext = () => {
    try {
      return decryptSecret(credentialsRef);
    } catch {
      throw fail(
        409,
        'DATABASE_DECRYPT_FAILED',
        'This connection string cannot be decrypted with the current '
        + 'TOKEN_ENCRYPTION_KEY — re-enter it.'
      );
    }
  };

  return {
    providerType,
    engine: provider.engine,
    label: provider.label,
    defaultVarName: provider.defaultVarName,

    /** Plaintext DSN. Only the env-injection path may call this. */
    connectionString: () => plaintext(),

    /** Safe for a browser: host, database and user, never the password. */
    describe() {
      try {
        return { decryptable: true, ...parseConnectionString(providerType, plaintext()) };
      } catch (e) {
        if (e.code === 'DATABASE_DECRYPT_FAILED') {
          return { decryptable: false, providerType, engine: provider.engine, label: null };
        }
        throw e;
      }
    },

    verify: () => verifyConnectionString(providerType, plaintext()),
  };
}
