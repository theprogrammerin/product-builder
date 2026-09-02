# Component Blueprint: `packages/codegen-agent`

## Purpose

The sandboxed LLM tool-calling loop that writes and *runs* real code
against an already-scaffolded project until it works. First proven on a
single CRUD resource (Milestone 1 — see
[design record](../../designs/codegen-agent-milestone-1.md)): backend
only, no auth/Mongo/Sidekiq/frontend yet. CLI-driven — no orchestrator or
web UI integration in this milestone.

## Key files

- [`src/cli.ts`](../../../packages/codegen-agent/src/cli.ts) — entrypoint;
  wires everything together, prints progress, runs the mandatory final
  `bundle exec rspec` check, tears down containers when done
- [`src/agent.ts`](../../../packages/codegen-agent/src/agent.ts) — the
  tool-calling loop (`runCodegenLoop`): calls the model, executes tool
  calls, feeds results back, until the model responds with non-empty
  plain text or a 25-iteration cap is hit
- [`src/tools.ts`](../../../packages/codegen-agent/src/tools.ts) —
  `read_file`/`write_file`/`list_dir`/`list_files`/`search_files` (all
  path-scoped, host-side `fs` ops against the bind-mounted `backend/`)
  and the `run_command` tool definition
- [`src/dockerExec.ts`](../../../packages/codegen-agent/src/dockerExec.ts) —
  runs commands via `docker compose run --rm rails <cmd>`; `down()` tears
  down dependency containers after a run
- [`src/promptContext.ts`](../../../packages/codegen-agent/src/promptContext.ts) —
  builds the system prompt from `stack-spec/versions.yaml` +
  `guidelines/*.md`, loads the hand-written build spec JSON

## Execution model

Backend commands run inside Docker (`docker compose run --rm rails
<command>`), never on the host — sidesteps this machine's Ruby version
entirely and matches the locked stack exactly. `stack-spec/template/`
provides a real `rails new --api` + `rspec:install` skeleton (not a bare
scaffold) with `config.generators.orm = :active_record` set explicitly,
so `mysql2`/build-essential native deps and Rails/rspec boilerplate don't
have to be regenerated — or rediscovered — on every run. See
[stack-spec blueprint](./stack-spec.md) for what's baked into the
template versus left for the agent.

The model's own "I'm done" is never trusted: the CLI always runs
`bundle exec rspec` itself as the final, authoritative check, regardless
of whether the loop converged or hit its iteration cap.

## CLI interface

```
codegen-agent --workspace <path-to-scaffolded-project> --spec <path-to-build-spec.json>
```

## Known limitations

- Single resource only; no auth, MongoDB, Sidekiq, or frontend generation
  yet — all real Phase 1 work still ahead.
- No orchestrator/web integration — a developer runs this by hand against
  a project's `workspacePath`.
- Build spec is hand-written JSON; there's no Intake Agent yet to produce
  one from a free-text description.
- `bundle install` may rerun on each invocation depending on gem cache
  state; not yet optimized.
- 25-iteration cap is a fixed constant, not tuned per resource complexity.

## Tests

[`test/`](../../../packages/codegen-agent/test) — unit tests for the loop
(fake `LLMClient`/tools/docker runner), the file tools (real temp dirs,
path-traversal rejection, recursive listing, grep-style search), and
prompt-context building (real `stack-spec/` content). No Postgres or
Docker required. The Docker-based execution and full end-to-end runs are
verified manually — see the design record for what that took.
