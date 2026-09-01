# Project Template (structural skeleton)

This is the fixed starting structure copied verbatim into every new
project (`stack-spec/template/` → `<generated-projects>/<project-id>/`),
matching the locked stack in [`../versions.yaml`](../versions.yaml).

**This is a skeleton, not a working app.** Nothing under `backend/` or
`frontend/` has been `bundle install`ed or `npm install`ed — file
contents (`Gemfile`, `package.json`, `docker-compose.yml`) declare the
intended dependencies per `../versions.yaml`, but making this an
actually-runnable app is Phase 1's job (the Codegen Agent — see
[`../../docs/backlog.md`](../../docs/backlog.md)).

## Layout

- `backend/` — Rails API skeleton (`Gemfile`, `config/`, `app/` dirs)
- `frontend/` — Expo/React Native skeleton (`package.json`, `app.json`, `src/` dirs)
- `docker-compose.yml` — wires rails + mysql + mongo + redis + sidekiq
- `docs/`, `CLAUDE.md`, `CHANGELOG.md` — the same governance loop this
  builder-tool repo follows (backlog → prioritize → impact review →
  design doc → build), scoped to this generated app instead. Whoever
  builds features into this project next — agent or human — follows it.

## Do not

Do not hand-edit this template for a specific project's needs — it's
copied by `packages/orchestrator/src/scaffold.ts` on project creation.
Changes here affect every future project, not just one.
