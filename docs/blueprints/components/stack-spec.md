# Component Blueprint: `stack-spec/`

## Purpose

The opinionated brain: locked versions, codegen guidelines, and — as of
[project scaffolding](../../designs/project-scaffolding.md) — the actual
starting file structure copied into every new project. `versions.yaml`
and `guidelines/` are still not consumed programmatically (that's Phase
1's Codegen Agent); `template/` is, by `packages/orchestrator/src/scaffold.ts`.

## Key files

- [`versions.yaml`](../../../stack-spec/versions.yaml) — locked
  versions/libraries for both the generated-app stack and this builder
  platform itself
- [`guidelines/`](../../../stack-spec/guidelines) — one markdown file per
  decision area:
  - [`data-storage.md`](../../../stack-spec/guidelines/data-storage.md) — MySQL vs MongoDB, per entity
  - [`auth.md`](../../../stack-spec/guidelines/auth.md) — Devise + JWT, Pundit
  - [`background-jobs.md`](../../../stack-spec/guidelines/background-jobs.md) — Sidekiq/Redis conventions
  - [`api-conventions.md`](../../../stack-spec/guidelines/api-conventions.md) — REST/serialization rules
  - [`frontend-architecture.md`](../../../stack-spec/guidelines/frontend-architecture.md) — navigation/state/component-library picks
  - [`error-handling.md`](../../../stack-spec/guidelines/error-handling.md) — exception → status/code mapping
  - [`testing.md`](../../../stack-spec/guidelines/testing.md) — what "done" means for a generation run
- [`template/`](../../../stack-spec/template) — the structural skeleton
  copied verbatim into every new project by `scaffoldProject()`:
  `backend/`, `frontend/`, `docker-compose.yml`, plus a full copy of this
  repo's own governance loop (`CLAUDE.md`, `docs/backlog.md`,
  `docs/blueprints/`, `docs/designs/TEMPLATE.md`, `CHANGELOG.md`) scoped
  to that project. See [`template/README.md`](../../../stack-spec/template/README.md).

## Locked stack (generated apps)

Backend: Rails + MySQL + MongoDB + Redis/Sidekiq, Devise+JWT, Blueprinter,
RSpec. Frontend: Expo/React Native + React Navigation + Zustand + React
Native Paper, Jest. Infra: Docker + docker-compose (cloud IaC deferred).
Full detail and exact version pins: [`versions.yaml`](../../../stack-spec/versions.yaml).

## Known limitations

- `versions.yaml`/`guidelines/` are not yet consumed by any running
  code — Phase 1's Codegen Agent is what will load and enforce them.
- `template/`'s `backend/`/`frontend/` are a structural skeleton only —
  not `bundle install`ed or `npm install`ed, not yet a runnable app.
- The template is static: editing it only affects *future* projects, not
  ones already scaffolded.
