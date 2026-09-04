# Component Blueprint: `stack-spec/`

## Purpose

The opinionated brain: locked versions, codegen guidelines, and the
starting file structure copied into every new project. `guidelines/` are
now consumed programmatically — the Codegen Agent's system prompt is
built from them verbatim (see
[codegen-agent blueprint](./codegen-agent.md)). `template/` is consumed by
`packages/orchestrator/src/scaffold.ts` at project-creation time.

## Key files

- [`versions.yaml`](../../../stack-spec/versions.yaml) — locked
  versions/libraries for both the generated-app stack and this builder
  platform itself
- [`guidelines/`](../../../stack-spec/guidelines) — one markdown file per
  decision area, loaded verbatim into the Codegen Agent's system prompt:
  - [`data-storage.md`](../../../stack-spec/guidelines/data-storage.md) — MySQL vs MongoDB, per entity
  - [`auth.md`](../../../stack-spec/guidelines/auth.md) — Devise + JWT, Pundit
  - [`background-jobs.md`](../../../stack-spec/guidelines/background-jobs.md) — Sidekiq/Redis conventions
  - [`api-conventions.md`](../../../stack-spec/guidelines/api-conventions.md) — REST/serialization rules
  - [`frontend-architecture.md`](../../../stack-spec/guidelines/frontend-architecture.md) — navigation/state/component-library picks
  - [`error-handling.md`](../../../stack-spec/guidelines/error-handling.md) — exception → status/code mapping
  - [`testing.md`](../../../stack-spec/guidelines/testing.md) — what "done" means for a generation run
  - [`component-networking.md`](../../../stack-spec/guidelines/component-networking.md) —
    every component can run on its own origin; cross-component URLs come
    from environment variables (`<NAME>_URL`, provided by the Run Agent),
    never hardcoded; CORS is required, not optional (feature #17)
- [`template/`](../../../stack-spec/template) — copied verbatim into every
  new project by `scaffoldProject()`:
  - `backend/` — a **real** `rails new --api` + `rails generate
    rspec:install` output (Rails 7.1.6, generated inside the same Docker
    image projects run in), with our locked Gemfile restored afterward
    and `config.generators.orm = :active_record` set explicitly (Mongoid's
    presence in the Gemfile otherwise hijacks `rails generate model` to
    default to Mongoid — found the hard way in Milestone 1). Not
    `bundle install`ed — no `Gemfile.lock`-derived gems are vendored, and
    `config/master.key`/`credentials.yml.enc` are deliberately excluded
    (secrets must never be shared across projects; Rails regenerates them
    fresh on first use).
  - `frontend/` — still a bare structural skeleton (package.json/app.json
    stubs) — Milestone 1 was backend-only; upgrading this the same way
    `backend/` was upgraded is future Phase 1 work.
  - `docker-compose.yml` — no service publishes a host port; mysql/mongo/
    redis only need to be reachable by service name over the
    compose-internal network. Publishing fixed host ports used to mean
    two projects' stacks could never run at the same time (found in
    Milestone 1) — see [codegen-agent blueprint](./codegen-agent.md).
  - A full copy of this repo's own governance loop (`CLAUDE.md`,
    `docs/backlog.md`, `docs/blueprints/`, `docs/designs/TEMPLATE.md`,
    `CHANGELOG.md`) scoped to that project. See
    [`template/README.md`](../../../stack-spec/template/README.md).

## Locked stack (generated apps)

Backend: Rails + MySQL + MongoDB + Redis/Sidekiq, Devise+JWT, Blueprinter,
RSpec. Frontend: Expo/React Native + React Navigation + Zustand + React
Native Paper, Jest. Infra: Docker + docker-compose (cloud IaC deferred).
Full detail and exact version pins: [`versions.yaml`](../../../stack-spec/versions.yaml).

## Known limitations

- `template/frontend/` is still a bare skeleton, unlike the now-real
  `backend/` — inconsistent fidelity until frontend generation is tackled.
- The template is static: editing it only affects *future* projects, not
  ones already scaffolded.
- No cached/pre-installed gems — `bundle install` still runs (and can be
  slow) on a project's first real command.
