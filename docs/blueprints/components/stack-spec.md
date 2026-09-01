# Component Blueprint: `stack-spec/`

## Purpose

Not code — the opinionated brain the future Codegen Agent must consult
and follow when generating an app. Nothing currently reads this
programmatically; it's authored now so Phase 1 has a concrete spec to
build against.

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

## Locked stack (generated apps)

Backend: Rails + MySQL + MongoDB + Redis/Sidekiq, Devise+JWT, Blueprinter,
RSpec. Frontend: Expo/React Native + React Navigation + Zustand + React
Native Paper, Jest. Infra: Docker + docker-compose (cloud IaC deferred).
Full detail and exact version pins: [`versions.yaml`](../../../stack-spec/versions.yaml).

## Known limitations

- Not yet consumed by any running code — Phase 1's Codegen Agent is what
  will load and enforce these guidelines.
