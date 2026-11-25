// Railway GraphQL client (https://backboard.railway.com/graphql/v2).
//
// Railway has **no REST API** — everything is one POST to a single GraphQL
// endpoint. Two consequences shape this file, and getting either wrong makes
// failures look like successes:
//
//   1. **Errors arrive in a 200 response.** GraphQL reports problems in an
//      `errors[]` array alongside (or instead of) `data`, with HTTP 200. A
//      client that only checks `res.ok` treats "Not Authorized" as success and
//      then crashes on undefined data. `call()` below checks `errors` first.
//   2. **Partial success is possible.** A response can carry both `data` and
//      `errors`. We treat any `errors` entry as a failure rather than using
//      half a result, because every call here is either a lookup we need whole
//      or a mutation we need to have happened.
//
// Auth is an account or workspace token the user creates in their own Railway
// dashboard and pastes in. (Railway also has project tokens, which use a
// different header and are scoped to one environment — not used here, because
// ShipYard needs to list projects before one is chosen.)
//
// Railway's object model, which the adapter maps onto:
//
//   Workspace → Project → Environment ("production") → Service → Deployment
//
// A ShipYard backend service becomes a Railway **Service** inside the Railway
// **Project** the connection is pinned to.
const ENDPOINT = 'https://backboard.railway.com/graphql/v2';
const TIMEOUT_MS = 25_000;

function fail(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

/** Flattens GraphQL's error array into one line. */
function errorText(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return 'Unknown GraphQL error';
  return errors
    .map((e) => {
      const path = Array.isArray(e?.path) && e.path.length > 0 ? ` at ${e.path.join('.')}` : '';
      return `${e?.message ?? String(e)}${path}`;
    })
    .join('; ');
}

/**
 * Maps a GraphQL error to one of our codes.
 *
 * Railway does not use typed error codes consistently, so this matches on the
 * message text — deliberately, and only to pick a status. The original message
 * is always forwarded, so a match we do not anticipate still reaches the user
 * intact rather than being swallowed.
 */
function mapGraphqlError(errors, context) {
  const text = errorText(errors);
  const lower = text.toLowerCase();
  const detail = `Railway ${context} failed: ${text}`;

  if (lower.includes('not authorized') || lower.includes('unauthorized')
    || lower.includes('invalid token') || lower.includes('authentication')) {
    // "Not Authorized" from Railway is usually about the token's TYPE, not its
    // validity, so the message says so — a flat "invalid or revoked" sends
    // people to regenerate a token that was fine.
    return fail(
      401,
      'RAILWAY_UNAUTHORIZED',
      `${detail}. Railway answers this for a valid-but-wrong-kind token as well as a bad one: `
      + 'a project token is read-only and uses a different header, so it cannot be used here. '
      + 'Create one at railway.com/account/tokens — choosing "No workspace" gives an account '
      + 'token that works everywhere. Also check the value was not truncated when copied.'
    );
  }
  if (lower.includes('not found') || lower.includes('does not exist')) {
    return fail(404, 'RAILWAY_NOT_FOUND', detail);
  }
  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return fail(429, 'RAILWAY_RATE_LIMITED', detail);
  }
  if (lower.includes('not allowed') || lower.includes('permission') || lower.includes('forbidden')) {
    return fail(403, 'RAILWAY_FORBIDDEN', detail);
  }
  if (lower.includes('limit') && lower.includes('plan')) {
    return fail(402, 'RAILWAY_PLAN_LIMIT', detail);
  }
  return fail(502, 'RAILWAY_API_ERROR', detail);
}

export function railwayClient({ token }) {
  async function call(query, variables, context) {
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'shipyard-control-plane',
        },
        body: JSON.stringify({ query, variables: variables ?? {} }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw fail(504, 'RAILWAY_UNREACHABLE', `Railway ${context} did not respond: ${e.name}`);
    }

    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }

    // Transport-level failures still happen (429, 5xx, an HTML error page), and
    // those never carry a GraphQL envelope.
    if (!res.ok) {
      if (res.status === 429) {
        const retry = res.headers.get('retry-after');
        throw fail(
          429,
          'RAILWAY_RATE_LIMITED',
          `Railway rate limit reached for ${context}`
          + (retry ? ` — retry in ${retry}s.` : '.')
          + ' Railway allows 100 requests/hour on the free plan, 1000/hour on Hobby.'
        );
      }
      if (res.status === 401 || res.status === 403) {
        throw fail(401, 'RAILWAY_UNAUTHORIZED', `Railway rejected the token on ${context} (HTTP ${res.status}). Reconnect Railway.`);
      }
      throw fail(502, 'RAILWAY_API_ERROR', `Railway ${context} failed: HTTP ${res.status}${body?.errors ? ` — ${errorText(body.errors)}` : ''}`);
    }

    // The important branch: HTTP 200 carrying errors.
    if (body?.errors) throw mapGraphqlError(body.errors, context);
    if (!body || body.data === undefined || body.data === null) {
      throw fail(502, 'RAILWAY_API_ERROR', `Railway ${context} returned no data`);
    }
    return body.data;
  }

  return {
    /** Also doubles as token validation on connect. */
    me: () => call(
      `query { me { id name email } }`,
      {},
      'identity lookup',
    ).then((d) => d.me),

    listProjects: () => call(
      `query { projects { edges { node { id name description createdAt } } } }`,
      {},
      'project listing',
    ).then((d) => (d.projects?.edges ?? []).map((e) => e?.node).filter(Boolean)),

    /** Project plus its environments and services — one call, used everywhere. */
    getProject: (id) => call(
      `query project($id: String!) {
         project(id: $id) {
           id
           name
           environments { edges { node { id name } } }
           services { edges { node { id name } } }
         }
       }`,
      { id },
      'project lookup',
    ).then((d) => {
      const p = d.project;
      if (!p) throw fail(404, 'RAILWAY_NOT_FOUND', `Railway project ${id} not found`);
      return {
        id: p.id,
        name: p.name,
        environments: (p.environments?.edges ?? []).map((e) => e?.node).filter(Boolean),
        services: (p.services?.edges ?? []).map((e) => e?.node).filter(Boolean),
      };
    }),

    // --- services -------------------------------------------------------------
    // `source.repo` is "owner/repo", NOT a URL — unlike Render, which wants the
    // full https://github.com/... form.
    createService: ({ projectId, name, repo, branch }) => call(
      `mutation serviceCreate($input: ServiceCreateInput!) {
         serviceCreate(input: $input) { id name }
       }`,
      // `branch` is TOP-LEVEL on ServiceCreateInput, not inside `source`:
      // `ServiceSourceInput` is only { repo | image }, and sending a branch
      // there answers `HTTP 400 ... Field "branch" is not defined by type
      // "ServiceSourceInput"`.
      { input: { projectId, name, branch: branch ?? null, source: { repo } } },
      'service creation',
    ).then((d) => d.serviceCreate),

    /** Settings live on the service INSTANCE — the service × environment pair. */
    updateServiceInstance: ({ serviceId, environmentId, input }) => call(
      `mutation serviceInstanceUpdate(
         $serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!
       ) {
         serviceInstanceUpdate(
           serviceId: $serviceId, environmentId: $environmentId, input: $input
         )
       }`,
      { serviceId, environmentId, input },
      'service settings update',
    ),

    // --- deployments ----------------------------------------------------------
    // V2 is the variant that accepts a commit sha, which is what lets ShipYard
    // deploy the exact commit it resolved from GitHub rather than branch HEAD.
    deployServiceInstance: ({ serviceId, environmentId, commitSha }) => call(
      `mutation serviceInstanceDeployV2(
         $serviceId: String!, $environmentId: String!, $commitSha: String
       ) {
         serviceInstanceDeployV2(
           serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha
         )
       }`,
      { serviceId, environmentId, commitSha: commitSha ?? null },
      'deploy trigger',
    ).then((d) => d.serviceInstanceDeployV2),

    listDeployments: ({ projectId, environmentId, serviceId, first = 20 }) => call(
      `query deployments($input: DeploymentListInput!, $first: Int) {
         deployments(input: $input, first: $first) {
           edges {
             node {
               id status createdAt url staticUrl canRedeploy canRollback
             }
           }
         }
       }`,
      { input: { projectId, environmentId, serviceId }, first },
      'deployment listing',
    ).then((d) => (d.deployments?.edges ?? []).map((e) => e?.node).filter(Boolean)),

    cancelDeployment: (id) => call(
      `mutation deploymentCancel($id: String!) { deploymentCancel(id: $id) }`,
      { id },
      'deploy cancel',
    ),

    // --- logs -----------------------------------------------------------------
    // Both are keyed directly on the deployment, so unlike Render there is no
    // time window or build id to reconstruct.
    buildLogs: ({ deploymentId, limit = 200 }) => call(
      `query buildLogs($deploymentId: String!, $limit: Int) {
         buildLogs(deploymentId: $deploymentId, limit: $limit) {
           timestamp message severity
         }
       }`,
      { deploymentId, limit },
      'build log fetch',
    ).then((d) => d.buildLogs ?? []),

    deploymentLogs: ({ deploymentId, limit = 200 }) => call(
      `query deploymentLogs($deploymentId: String!, $limit: Int) {
         deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
           timestamp message severity
         }
       }`,
      { deploymentId, limit },
      'runtime log fetch',
    ).then((d) => d.deploymentLogs ?? []),

    // --- variables ------------------------------------------------------------
    // `replace: false` MERGES, which is the "only touch keys we manage" rule —
    // `replace: true` would delete every variable the user set in Railway's own
    // dashboard. `skipDeploys` stops each write from triggering its own deploy.
    upsertVariables: ({ projectId, environmentId, serviceId, variables }) => call(
      `mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
         variableCollectionUpsert(input: $input)
       }`,
      {
        input: {
          projectId, environmentId, serviceId, variables, replace: false, skipDeploys: true,
        },
      },
      'variable upsert',
    ),

    listVariables: ({ projectId, environmentId, serviceId }) => call(
      `query variables($projectId: String!, $environmentId: String!, $serviceId: String) {
         variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
       }`,
      { projectId, environmentId, serviceId },
      'variable listing',
    ).then((d) => d.variables ?? {}),

    deleteVariable: ({ projectId, environmentId, serviceId, name }) => call(
      `mutation variableDelete($input: VariableDeleteInput!) {
         variableDelete(input: $input)
       }`,
      { input: { projectId, environmentId, serviceId, name } },
      `variable delete (${name})`,
    ),

    // --- domains --------------------------------------------------------------
    // A Railway service has NO public URL until one is created. This is the
    // step that has no Render or Vercel equivalent, and skipping it leaves a
    // running service that nothing can reach.
    listDomains: ({ projectId, environmentId, serviceId }) => call(
      `query domains($projectId: String!, $environmentId: String!, $serviceId: String!) {
         domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
           serviceDomains { id domain suffix targetPort }
           customDomains { id domain status { dnsRecords { hostlabel requiredValue } } }
         }
       }`,
      { projectId, environmentId, serviceId },
      'domain listing',
    ).then((d) => d.domains ?? { serviceDomains: [], customDomains: [] }),

    createServiceDomain: ({ serviceId, environmentId, targetPort }) => call(
      `mutation serviceDomainCreate($input: ServiceDomainCreateInput!) {
         serviceDomainCreate(input: $input) { id domain }
       }`,
      {
        input: {
          serviceId,
          environmentId,
          ...(targetPort ? { targetPort } : {}),
        },
      },
      'domain creation',
    ).then((d) => d.serviceDomainCreate),
  };
}
