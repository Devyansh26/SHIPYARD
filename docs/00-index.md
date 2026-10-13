# ShipYard — Low-Level Design Documentation

> **Platform Summary:** ShipYard is a self-hosted developer deployment platform in the spirit of Railway and Render. Developers connect their GitHub repositories, configure services, and trigger deployments — ShipYard handles the full lifecycle: build, containerisation, routing, secret injection, and live log streaming. The platform is built for a homelab-first model but is architected to support pluggable cloud providers (Vercel, Neon, Atlas) via a unified provider-adapter pattern.

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| **Frontend** | React 18, Vite, TypeScript | SPA, communicates with Control API only |
| **Control API** | Node.js, Express, TypeScript, MongoDB (Mongoose) | Primary backend; auth, project/service CRUD, deployment orchestration |
| **Container Management Service** | FastAPI, Python | Wraps Docker SDK; build, run, stop, inspect containers |
| **Container Deployer Service** | FastAPI, Python, Redis (worker) | BullMQ-compatible Redis consumer; pulls jobs, drives the deployment state machine |
| **Database** | MongoDB | Primary data store for all Control API entities |
| **Queue / Cache** | Redis | Job queue (deployments), live log pub/sub channel |
| **Reverse Proxy** | Nginx | TLS termination, routes public traffic to Frontend + Control API only |

---

## Service Map

```
┌──────────────────────────────────────────────────────────┐
│                     PUBLIC INTERNET                       │
└──────────────────────┬───────────────────────────────────┘
                       │ HTTPS
              ┌────────▼────────┐
              │  Nginx / Proxy  │  (TLS termination)
              └──┬──────────┬───┘
                 │          │
      ┌──────────▼──┐   ┌───▼──────────────┐
      │  Frontend   │   │   Control API     │
      │ React+Vite  │   │ Node/Express/TS   │  :3000
      └─────────────┘   └───┬──────────┬───┘
                             │          │
                    ┌────────▼─┐  ┌─────▼──────┐
                    │ MongoDB  │  │   Redis     │
                    └──────────┘  └─────┬───────┘
                                        │ job queue
                         ┌──────────────▼──────────────┐
                         │  Container Deployer Service  │
                         │  FastAPI + Python worker     │  (internal)
                         └──────────────┬──────────────┘
                                        │ HTTP
                         ┌──────────────▼──────────────┐
                         │ Container Management Service │
                         │  FastAPI + Python            │  (internal)
                         └──────────────┬──────────────┘
                                        │
                                  Docker socket
```

| # | Service | Short Name | Port | Network |
|---|---|---|---|---|
| 1 | Control API | `control-api` | 3000 | Public (via Nginx) |
| 2 | Container Management Service | `cms` | 8000 | Private |
| 3 | Container Deployer Service | `cds` | 8001 | Private |
| 4 | Frontend | `frontend` | 5173 (dev) / 80 (prod) | Public (via Nginx) |

---

## LLD Document Directory

```
docs/
├── 00-index.md                          ← Master index, tech stack, service map & reading guide.
├── 01-architecture.md                   ← System architecture, data flow, ADRs, sequence & boundary diagrams.
├── 02-database-schema.md                ← MongoDB collections, Mongoose schemas (TS), indexes, FSM state machine.
├── 03-control-api.md                    ← Node/Express backend: auth, projects, services, deployments, providers, TDD.
├── 04-container-management-service.md   ← Internal FastAPI service (8001): Docker SDK engine, container sandbox, stats.
├── 05-container-deployer-service.md     ← Internal FastAPI worker (8002): Redis consumer, git build, deployment pipeline.
└── api-docs/                            ← Comprehensive REST API documentation by area
    ├── A-auth.md                        ← Auth & GitHub Integration (OAuth, session, tokens, repos, branches)
    ├── B-projects-and-services.md       ← Projects & Service Nodes CRUD and configuration
    ├── C-deployments.md                 ← Deployment Orchestration (start, cancel, rollback, logs, SSE stream)
    ├── D-E-internal-services.md         ← Internal Container Management (8001) & Deployer (8002) endpoints
    ├── F-env-vars.md                    ← Environment variables & secret handling (AES-256-GCM, masking)
    ├── G-domains-and-routes.md          ← Custom domains, DNS TXT verification, Traefik reverse proxy routes
    ├── H-I-connections-resources.md     ← Provider Connections (Vercel, Neon, Atlas, Homelab) & Project Resources
    └── K-webhooks-misc.md               ← Webhooks (GitHub HMAC, Vercel), health, ready, metrics, activity
```

| File | What it covers |
|---|---|
| [`00-index.md`](file:///Users/divy13ansh/Projects/SHIPYARD/docs/00-index.md) | Platform overview, tech stack, service map, and doc directory |
| [`01-architecture.md`](file:///Users/divy13ansh/Projects/SHIPYARD/docs/01-architecture.md) | C4-style responsibilities, data-flow, architecture decision records (ADRs), mermaid diagrams |
| [`02-database-schema.md`](file:///Users/divy13ansh/Projects/SHIPYARD/docs/02-database-schema.md) | Every MongoDB collection: TypeScript interface, Mongoose schema, indexes, relationships, FSM |
| [`03-control-api.md`](file:///Users/divy13ansh/Projects/SHIPYARD/docs/03-control-api.md) | All Express modules, routes, controllers, services, BullMQ outbox, provider adapters, TDD |
| [`04-container-management-service.md`](file:///Users/divy13ansh/Projects/SHIPYARD/docs/04-container-management-service.md) | FastAPI routes, DockerClient wrapper, resource sandboxing, secret redaction, stats, TDD |
| [`05-container-deployer-service.md`](file:///Users/divy13ansh/Projects/SHIPYARD/docs/05-container-deployer-service.md) | Redis worker consumer, deployment state machine, image builder, health convergence, TDD |
| [`api-docs/`](file:///Users/divy13ansh/Projects/SHIPYARD/docs/api-docs) | Complete endpoint specifications with schemas, examples, error codes, and side effects |

---

## How to Read These Docs

1. **Start with `01-architecture.md`** — understand the big picture before diving into individual services. The sequence diagram there is the single source of truth for the deployment happy path.

2. **Read `02-database-schema.md` next** — every service ultimately reads from or writes to these collections. Understanding the schema prevents confusion about field names and state transitions later.

3. **Then read per-service docs (`03` → `05`)** in order — Control API orchestrates, Container Deployer consumes, Container Management executes. Reading them in sequence mirrors the runtime call chain.

4. **Cross-cutting concerns** (`07-auth.md`, `08-secrets.md`, `09-provider-adapters.md`) can be read in any order after `01` and `02`.

5. **`10-api-contracts.md`** is a reference doc — keep it open as a tab while reading the per-service docs.

> [!NOTE]
> Code snippets in these docs are **illustrative** — they show the important signatures, types, and logic. Full implementations live in the source tree under `/packages/` (monorepo). Every snippet specifies which service it belongs to in a comment at the top.

> [!TIP]
> Each ADR (Architecture Decision Record) in `01-architecture.md` follows the format: **Decision → Why → Trade-off**. When you want to challenge or revisit a choice, that is the first place to look.
