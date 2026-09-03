# Component Blueprint: `packages/codegen-agent`

## Purpose

The sandboxed LLM tool-calling loop that writes and *runs* real code
against an already-scaffolded project until it works. First proven on a
single CRUD resource (Milestone 1 — see
[design record](../../designs/codegen-agent-milestone-1.md)), then
extended to an arbitrary number of related resources plus associations
built in dependency order (see
[multi-resource-support.md](../../designs/multi-resource-support.md)):
backend only, no auth/Mongo/Sidekiq/frontend yet. Usable two ways: the
standalone CLI, or as a library — `packages/orchestrator`'s `/build` chat
flow calls `runCodegenAgent()` directly (see
[wire-agents-into-chat.md](../../designs/wire-agents-into-chat.md)).

## Key files

- [`src/cli.ts`](../../../packages/codegen-agent/src/cli.ts) — entrypoint;
  wires everything together, prints progress, runs the mandatory final
  `bundle exec rspec` check, tears down containers when done
- [`src/agent.ts`](../../../packages/codegen-agent/src/agent.ts) — the
  tool-calling loop (`runCodegenLoop`): calls the model, executes tool
  calls, feeds results back, until the model responds with non-empty
  plain text or the iteration cap is hit. `defaultMaxIterations(buildSpec)`
  scales the cap with how many `## Resource` headings the spec text
  contains (`max(25, resourceCount * 20)`) — a cheap heading count, not a
  real parse of fields/associations. `runCodegenAgent()` wraps the loop
  with the final `bundle exec rspec` check and returns a plain result
  (`testsPassed`, `rspecSummary`, `rspecOutput`) — the shared entrypoint
  both `cli.ts` and the orchestrator use; teardown (`dockerRunner.down()`)
  stays the caller's job either way
- [`src/tools.ts`](../../../packages/codegen-agent/src/tools.ts) —
  `read_file`/`write_file`/`list_dir`/`list_files`/`search_files` (all
  path-scoped, host-side `fs` ops against the bind-mounted `backend/`)
  and the `run_command` tool definition
- [`src/dockerExec.ts`](../../../packages/codegen-agent/src/dockerExec.ts) —
  runs commands via `docker compose run --rm rails <cmd>`; `down()` tears
  down dependency containers after a run
- [`src/promptContext.ts`](../../../packages/codegen-agent/src/promptContext.ts) —
  builds the system prompt from `stack-spec/versions.yaml` +
  `guidelines/*.md`; `loadBuildSpec` reads the `--spec` file as plain
  text, no parsing — it can be hand-written or produced by the
  [Intake Agent](./intake-agent.md)

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
codegen-agent --workspace <path-to-scaffolded-project> --spec <path-to-build-spec.md>
```

`--spec` is read as plain text — any format works as far as the code is
concerned, but a short markdown brief (resource name + a bulleted field
list) is what the [Intake Agent](./intake-agent.md) produces and what
this has been validated against.

## Known limitations

- No auth, MongoDB, Sidekiq, or frontend generation yet — all real Phase
  1 work still ahead.
- Associations limited to `belongs_to`/`has_many`/`has_one` — no
  many-to-many (`has_and_belongs_to_many`)/join-table support yet.
- No schema or validation on the spec file's content — a malformed or
  misleading brief surfaces the same way any other Codegen Agent mistake
  does, via a failing `bundle exec rspec` at the end.
- `bundle install` may rerun on each invocation depending on gem cache
  state; not yet optimized.
- The iteration-budget formula's constants (25 floor, +20/resource) are
  validated against 1-, 2-, and 3-resource specs only; unproven beyond
  that.

## Tests

[`test/`](../../../packages/codegen-agent/test) — unit tests for the loop
and `runCodegenAgent` (fake `LLMClient`/tools/docker runner —
pass/fail/rspec-summary-parsing cases), `defaultMaxIterations`'s scaling
formula, the file tools (real temp dirs, path-traversal rejection,
recursive listing, grep-style search), and prompt-context building (real
`stack-spec/` content). No Postgres or Docker required. The Docker-based
execution and full end-to-end runs are verified manually — see the design
records (Milestone 1's single-resource run, the multi-resource design's
2- and 3-resource runs, and wire-agents-into-chat.md's real run through
the orchestrator/web UI) for what that took.
