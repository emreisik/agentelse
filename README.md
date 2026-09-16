# Agentelse

**Your AI Growth Team.** Agentelse is a multi-tenant **AI agency operating system** that manages research, planning, approval, execution, verification, and learning flows for multiple brands in one place. The codebase is not a microservice; it is built as a **modular monolith** with clearly defined boundaries.

## Workspace structure

This root directory is also an npm workspace root. The app itself (everything this README describes) continues to live in the root directory. Under `apps/` there are standalone apps meant to be deployed to separate domains:

- `apps/marketing` — **agentelse.com**, the marketing/promo site. Has its own `package.json` and is its own standalone Next.js app; run it with `npm run dev -w apps/marketing`.
- `apps/docs` — reserved for **agentelse.io**, a placeholder that hasn't been scaffolded yet.

This root app, in turn, is positioned as **agentelse.ai** (the actual product/dashboard).

## Architecture

```text
Next.js UI / Server Actions / API
                 |
          Auth + tenant check
                 |
       Command and Agency services
                 |
        TaskPlanner + ApprovalPolicy
                 |
    ExecutionJob + OutboxEvent (transaction)
                 |
          PostgreSQL worker
                 |
       CapabilityRouter + ProviderRegistry
          /              |              \
     OpenClaw         OpenAI           Mock fleet
                 |
    Verification -> Measurement -> Learning
```

Core design decisions:

- **Modular monolith:** UI, domain services, worker, and data access all live in the same app; module boundaries are enforced under `src/server`.
- **Capability-first routing:** Work is planned by `CapabilityKey` value, not by provider name. `CapabilityRouter` selects the appropriate provider.
- **Transactional outbox:** `ExecutionJob` and `OutboxEvent` are written in the same Prisma transaction. The provider call is never made inside the HTTP request.
- **Approval and verification:** Risky work is sent for approval before execution. A provider result that requires verification does not complete the task directly; an independent `ExecutionVerification` record is created first.
- **Tenant isolation:** Every access is checked at the `Workspace -> Project -> Brand` boundary. Denormalizing the relevant IDs across tables is a deliberate query and security choice.
- **Measurement loop:** Completed work can feed back into signal, measurement, and learning flows.

### Main execution flow

1. Web, API, system, or the scheduler produces a command/task.
2. `TaskPlanner` computes the execution policy and the required approval level.
3. If no approval is needed, `ExecutionService` records the job and the outbox event atomically.
4. `ExecutionWorker` claims the event, selects the appropriate provider, and tracks the result.
5. If OTP, MFA, login, or CAPTCHA is required, the task moves to the `WAITING_HUMAN` state.
6. Results with external effects are verified; the task then completes.
7. The continuous agency engine processes the measurement and learning steps.

### Tenant hierarchy

```text
Workspace (agency)
└── Project (client/project)
    └── Brand (brand; usually a single default brand)
```

The central entry point for authorization checks is `src/server/security/tenant-context.ts`. Server Actions and routes must not rely solely on tenant IDs coming from the client.

## Tech stack

- Next.js 16.3 App Router and React 19
- TypeScript (`strict`, `noUncheckedIndexedAccess`)
- Prisma 6 and PostgreSQL
- Auth.js v5 Credentials + JWT session
- Tailwind CSS 4 and shadcn/ui components
- Vitest 2

## Directory structure

```text
src/
  app/                    Pages, route handlers, and layouts
  components/             App and shared UI components
  lib/                    Auth, Prisma, env, and general utilities
  server/
    actions/              Next.js Server Action adapters
    agency/               Setup, intelligence, opportunity, idea, council,
                           work-plan, measurement, and learning engines
    commands/              CommandService, intent routing, and task planning
    context/               Brand context policy and immutable snapshot generation
    execution/              Policy, routing, provider registry, and execution
      providers/            OpenClaw, OpenAI, and mocks for explicit test mode
    reasoning/              OpenAI-backed structured reasoning
    repositories/           Tenant-scoped Prisma data access
    scheduler/              CRON, interval, and one-off project schedulers
    security/               Tenant validation, errors, and temporary secret encryption
    state-machine/          Domain state transitions
    workers/                PostgreSQL outbox worker
prisma/
  schema.prisma            Domain data model
  migrations/               Versioned PostgreSQL migrations
  seed.ts                   Local demo data
```

## Local setup

Recommended requirements: Node.js 22.22+ and PostgreSQL 16. If OpenClaw won't be used, the Node.js 20.9+ supported by Next.js is also sufficient.

```bash
npm ci
cp .env.example .env
npx prisma generate
npx prisma migrate dev
npm run db:seed
npm run dev
```

The app opens at `http://localhost:3000`. Demo seed login credentials:

```text
admin@agentelse.dev / agentelse-dev
```

If using Neon, `DATABASE_URL` should be the pooled connection URL and `DIRECT_URL` the direct connection URL. On local PostgreSQL, both values can be the same.

## Provider and reasoning modes

Execution providers and Agency OS's internal reasoning calls are separate layers:

- If `OPENCLAW_CLI_PATH` is set, the OpenClaw provider runs through a real `openclaw` CLI process. There is no HTTP-based `OPENCLAW_BASE_URL` integration.
- `OPENAI_API_KEY` enables the text/analysis and creative copy execution providers (`OpenAiAiProvider`/`OpenAiCreativeProvider`), and is the sole backend for Agency OS's internal reasoning calls.
- The 4 search-grounded research capabilities (`BRAND_DISCOVERY`, `WEB_RESEARCH`, `COMPETITOR_RESEARCH`, `SEO_RESEARCH`) are served entirely by OpenClaw's real browser-based research — OpenAI's Chat Completions API has no built-in web-search tool.
- `AGENTELSE_PROVIDER_MODE=mock` forces the mock provider fleet, for development and testing only.
- If the provider mode is not `mock`, the registry only considers real providers. If no real provider is configured, the job explicitly fails with `PROVIDER_UNAVAILABLE`; there is no silent mock fallback.
- Under the `AGENTELSE_REASONING_MODE=auto` default (the only real backend), OpenAI is used.
- `AGENTELSE_REASONING_MODE=mock` produces deterministic reasoning for test and seed scenarios.

OpenClaw is used in two different ways:

- Browser/research/publish jobs are executed via `openclaw agent --agent ... --message ... --json`.
- The image generation action uses the `openclaw infer image generate` call and stores the result under `storage/assets` in the development environment.

Because OpenClaw has no structured field to report the need for human intervention, OTP/MFA/CAPTCHA detection relies on signals in the provider's text output. This is a known limitation of this integration.

## Agency OS

The continuously running core flow:

```text
Signal
  -> Finding / Insight
  -> Opportunity
  -> multi-lens Idea
  -> CouncilEvaluation
  -> AgencyDecision
  -> WorkPlan / Task
  -> Execution / Verification
  -> Measurement / BrandLearning
```

The setup engine manages 12 stages: intake, deep discovery, brand constitution, signal profile, baseline audits, goal generation, department/autonomy configuration, initial opportunity/idea/work plan generation, and project activation.

The web UI includes the following areas:

- Workspace dashboard
- Project/agency panel and setup
- Brand Brain, intelligence, opportunities, and ideas
- Tasks and handoff/work plan view
- Department and autonomy settings
- Approval center and human intervention center
- Creative detail view

## Security

- Auth.js Credentials sessions use the JWT strategy.
- Tenant relationships are re-validated server-side.
- OTP/MFA values are encrypted with AES-256-GCM, kept with a short TTL, and are single-use.
- The local asset route validates user and project access; it only accepts safe filenames generated by the app.
- OpenClaw and provider responses are validated with Zod schemas.
- The worker cron endpoint requires `Authorization: Bearer $CRON_SECRET`; it does not allow access even if the secret is undefined.

## Tests

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

The Vitest collection has two groups:

- Pure unit tests: state machine, execution/approval policy, intent parser, fingerprint, department registry, and next-best-action scoring.
- PostgreSQL integration tests: tenant isolation, temporary secret lifecycle, the 12-stage setup, and signal-to-work-plan/SEO handoff scenarios.

The development database must not be used for integration tests. `TEST_DATABASE_URL` must point to a separate PostgreSQL database whose name/host/schema clearly indicates a test environment. In environments with a pooled/direct split, like Neon, `TEST_DIRECT_URL` can also be provided. If the variable is absent, suites that require a DB are skipped; an unsafe test URL, or one identical to the development URL, is rejected.

Example local flow:

```bash
createdb agentelse_test

DATABASE_URL='postgresql://localhost:5432/agentelse_test?schema=public' \
DIRECT_URL='postgresql://localhost:5432/agentelse_test?schema=public' \
npx prisma migrate deploy

TEST_DATABASE_URL='postgresql://localhost:5432/agentelse_test?schema=public' \
npm test
```

Test fixtures are namespaced with a random run ID and clean up their own data. This isolation still does not replace the requirement to use a separate test database.

## CI

`.github/workflows/ci.yml` runs the following quality gates on every push and pull request:

1. `npm ci`
2. Prisma Client generation
3. Applying migrations to an empty, ephemeral PostgreSQL test database
4. TypeScript check
5. ESLint
6. The full Vitest suite
7. Next.js production build

CI uses no Neon/development secrets. The ephemeral PostgreSQL service attached to the GitHub Actions job is fully torn down when the job finishes.

## Worker and deployment

The development server can start a three-second local worker loop via `src/instrumentation.ts`, opt-in only: set `ENABLE_LOCAL_WORKER=true`. It stays off by default because this app's `DATABASE_URL` is routinely the same live database production reads from — an unconditional local worker would silently start executing real production jobs the moment `npm run dev` runs.

In production, a long-lived interval should not be relied upon. An external scheduler must call the following endpoint:

```text
POST /api/cron/worker
Authorization: Bearer <CRON_SECRET>
```

A worker tick covers the scheduler, outbox dispatch, running job polling, verification, the Continuous Agency Engine, and cleanup of expired records. In production this scheduler is `.github/workflows/cron-worker.yml`, calling the endpoint above every 5 minutes. Each tick only processes a bounded batch (at most 10 dispatch events, 20 running jobs — see `execution-worker.ts`), so this cadence is far slower than local dev's 3-second loop; a large backlog drains visibly slower than it would locally.

## Current limitations

- The OpenAI creative provider generates copy and the image prompt; the actual image is generated separately (OpenAI's image API primarily, falling back to the OpenClaw image action if that isn't configured or fails).
- Competitor models exist; the regular research -> snapshot -> diff pipeline is not yet complete.
- `Skill` and `ProjectSkill` models exist; the skill discovery/review/sandbox/approval pipeline is not yet complete.
- `SENTRY_DSN` is readable, but there is no direct Sentry bootstrap integration yet.
- OpenClaw's CLI call is blocking within the worker; a separate process/queue model for long browser tasks has not been implemented yet.
