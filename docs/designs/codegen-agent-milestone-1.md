# Design: Codegen Agent — Milestone 1 (single CRUD resource)

- **Backlog item**: [`docs/backlog.md`](../backlog.md) — # 2 (Phase 1)
- **Status**: implemented — passing pilot run achieved 2026-09-02

## Outcome

Fifth real run passed end-to-end: `bundle exec rspec` → **21 examples, 0
failures**. The agent generated a migration (with tightened constraints
beyond the generator defaults), a `Task` model with real validations, a
`TaskBlueprint` serializer, a namespaced `Api::V1::TasksController` with
pagination, request + model specs, and a routes entry — and independently
followed `error-handling.md`/`api-conventions.md` closely enough to
reproduce their exact error-envelope shape and status-code mapping
without being shown example code. It hit the 25-iteration cap right at
the end (never explicitly said "done"), which the mandatory final
verification step exists precisely to not care about: the CLI ran
`bundle exec rspec` regardless and that's what certified the pass.

Getting here took 5 real runs, each surfacing a genuine bug fixed along
the way (recorded inline below and in `CHANGELOG.md`): an empty-response
loop bug, ephemeral-container state loss (both installed packages and
gems), a cross-project port collision, and — the biggest change — baking
a real `rails new --api` + `rspec:install` skeleton plus an ActiveRecord
generator-default fix into `stack-spec/template/backend/`, which removed
most of the setup work from every future run's iteration budget.

## Summary

A CLI tool that takes an already-scaffolded project (from
[project scaffolding](./project-scaffolding.md)) plus a hand-written
build spec describing one resource, and runs an LLM tool-calling loop
that writes and *actually runs* Rails backend code — inside Docker, to
sidestep this machine's Ruby/Rails version mismatch — until a real
`bundle exec rspec` run passes. This is the first, deliberately narrow
slice of Phase 1: no auth, no MongoDB, no Sidekiq, no frontend yet. The
goal is to prove the core loop (LLM + tools + real verification) works at
all before adding complexity.

Validated before writing this doc: the configured GLM endpoint/model
returns proper OpenAI-style `tool_calls` (confirmed with a one-off
script against `write_file`-shaped tool definitions) — the core mechanism
this design depends on is real, not assumed.

Known environment facts driving this design: this machine has Ruby 3.0.5
but the locked stack requires 3.3.x; Docker's CLI is present but its
daemon isn't running yet (will be started as part of building this).

## Feature-set impact

New: given a project (already scaffolded) and a build spec like
`{ "resource": "Task", "fields": [{"name": "title", "type": "string"}, {"name": "done", "type": "boolean"}] }`,
running the Codegen Agent CLI against it produces real, working Rails
code for that resource — model, migration, controller, serializer, and
RSpec tests — verified by actually running the test suite inside Docker.
This is CLI-only in this milestone; no web UI or orchestrator involvement.

## Architecture impact

New component: **Codegen Agent** (`packages/codegen-agent`), the first
piece of the "Codegen Agent" box in the
[target architecture](../blueprints/architecture.md#target-architecture)
diagram. It:

- Depends on `@app-builder/llm-client` for the tool-calling loop.
- Reads `stack-spec/versions.yaml` + all of `stack-spec/guidelines/*.md`
  programmatically for the first time (previously authored but unused).
- Operates on a project's `workspacePath` (produced by
  `packages/orchestrator/src/scaffold.ts`) — decoupled from the
  orchestrator process; this is a standalone CLI invocation, per the
  roadmap's "CLI-driven" framing.

No change to `packages/web` or `packages/orchestrator`. Changes to
`stack-spec/template/` — affecting every future scaffold, which is why
they belong in the template, not just this new package:

- `docker-compose.yml`: `rails`/`sidekiq` bind-mount `./backend:/app` so
  files the agent writes are visible inside containers without an image
  rebuild each turn; both also mount a named `bundle_cache` volume at
  `/usr/local/bundle` — **found during the first real run**: `docker
  compose run --rm` gives every command a fresh, ephemeral container, so
  without a persistent volume, gems installed by one `bundle install`
  call would vanish before the next command ran.
- `backend/Dockerfile`: bakes in `build-essential`, `pkg-config`,
  `default-libmysqlclient-dev`, `git` at image-build time. **Also found
  during the first real run**: the agent burned its entire iteration
  budget re-discovering and re-installing these native build deps via
  `run_command` every call (same ephemeral-container issue) — they must
  be part of the image, not something the agent installs ad hoc.
- `docker-compose.yml`: dropped host `ports:` publishing from
  `rails`/`mysql`/`mongo`/`redis`/`sidekiq` entirely. **Found in the
  second real run**: `mysql`/`mongo`/`redis` only need to be reachable
  from `rails`/`sidekiq` over the compose-internal network (by service
  name — `MYSQL_HOST=mysql`, etc.), never from the host. Publishing fixed
  host ports meant a second project's stack couldn't start at all once
  the first project's leftover containers (never torn down between CLI
  runs) held those same ports — `docker compose run` starts `depends_on`
  services but only removes the one-off command container, not them.

## Cleanup between runs

The CLI now runs `docker compose down` for the target workspace after
every run (success or failure), so dependency containers (mysql/mongo/
redis) don't linger holding resources between invocations. This doesn't
by itself fix cross-project port collisions — the dropped `ports:`
publishing above does — but it's the right hygiene regardless.

## Components affected

- [`stack-spec`](../blueprints/components/stack-spec.md) — the
  `docker-compose.yml`/`Dockerfile` changes above.
- **`packages/codegen-agent`** (new) — the CLI itself; no existing
  blueprint yet, one will be added under `docs/blueprints/components/`
  once built.

## Design

### Execution model: Docker, via `docker compose run`

Backend commands run as `docker compose -f <workspace>/docker-compose.yml
run --rm rails <command>` (working directory = the project's
`workspacePath`). This:

- Uses the project's own `Dockerfile` (`ruby:3.3-slim`), sidestepping the
  host's Ruby 3.0.5 entirely.
- Starts declared dependencies (`mysql`, `mongo`, `redis`) automatically
  via `depends_on` — harmless if some aren't needed yet for milestone 1.
- Never runs `docker compose up` (the `rails` service's own `CMD` expects
  a working, bundled app — which doesn't exist yet at the start of a run
  and would just crash-loop). `run` starts a fresh one-off container per
  command instead, which is what an iterative build loop needs.
- Needs the `./backend:/app` volume mount (see above) so a file the agent
  just wrote via `write_file` is visible to the *next* `run_command` call
  without rebuilding the image.

### Tools exposed to the model

All file tools are scoped to `<workspacePath>/backend` and reject any
resolved path that escapes that root (path-traversal check on every
call — this is the one place a bug is a real security issue, not just a
correctness one).

- `read_file(path)`
- `write_file(path, content)`
- `list_dir(path)` — immediate children of one directory
- `list_files(path?)` — **added after the first run's exploration was
  too slow**: recursively lists every file under `path` (default: the
  whole root), skipping `.git`/`tmp`/`log`/`node_modules`. One call
  instead of many nested `list_dir` calls.
- `search_files(pattern, path?)` — **added for the same reason**: a
  grep-style content search under `path` (default: root); `pattern` is
  used as a regex, falling back to an escaped literal match if it isn't
  valid regex. Returns up to 200 `{ path, line, text }` matches. Lets the
  model find where something is defined/referenced without reading files
  one at a time.
- `run_command(command)` — executed via the `docker compose run` wrapper
  above, output (stdout+stderr, exit code) returned to the model

`list_files` and `search_files` are pure host-side `fs` operations, like
`read_file`/`write_file`/`list_dir` — no need to go through Docker, since
the `./backend:/app` bind mount means the host and container see the same
files. Same path-traversal scoping as the other file tools.

### Loop

1. Build the system prompt from `stack-spec/versions.yaml` +
   every `stack-spec/guidelines/*.md` file, concatenated verbatim (per
   the original architecture: "a fixed set of docs, always included").
   The prompt also spells out the required sequence (bundle install →
   generate/write model+migration → migrate → controller+serializer →
   specs → run rspec) — **added after the first run**: without it, the
   model spent its whole budget exploring and never wrote any code.
2. Seed the conversation with the build spec and the tool definitions.
3. Call `llmClient.chat()` with a generous `maxTokens` (4096) — **added
   after the first run**: this model spends tokens on hidden reasoning
   before visible output, and an unset/low cap risked silently truncating
   to an empty response. If the response has `tool_calls`, execute each
   locally, append the results as `role: "tool"` messages, and call
   `chat()` again.
4. If the response has no tool calls **and** non-empty content, treat
   that as the model claiming it's done and exit the loop. If it has no
   tool calls **and** empty/blank content — **added after the first
   run**, where this happened and was wrongly treated as "done" — don't
   converge; push a nudge message and keep looping.
5. Hard cap: 25 iterations. Hitting the cap ends the run as "did not
   converge," not an error — whatever partial state exists is left on
   disk for inspection.
6. **Regardless of how the loop ended**, run `bundle exec rspec` inside
   Docker as the final, authoritative check. The model's own "I'm done"
   claim is never trusted on its own — this is what makes "done" mean
   something (per `stack-spec/guidelines/testing.md`).
7. Report: iterations used, final rspec pass/fail, exit code.

### CLI interface

```
codegen-agent --workspace <path-to-scaffolded-project> --spec <path-to-build-spec.json>
```

## Out of scope (this milestone)

- MongoDB, Devise/JWT auth, Sidekiq jobs, Blueprinter serialization
  conventions beyond the basics — all real Phase 1 work, just not in this
  first slice.
- Frontend/Expo generation.
- Any orchestrator/web integration — this is a standalone CLI run by a
  developer, not something triggered from the chat UI yet.
- Gem-install caching across runs (`bundle install` may rerun each time);
  fine for a single-resource proof of concept, worth revisiting if the
  loop is slow in practice.
