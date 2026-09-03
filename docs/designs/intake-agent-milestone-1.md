# Design: Intake Agent — Milestone 1 (single resource, markdown brief)

- **Backlog item**: [`docs/backlog.md`](../backlog.md) — # 5 (Phase 2)
- **Status**: implemented — verified against the real GLM endpoint 2026-09-02

## Outcome

Verified against the live model on both paths:

- A clear description ("a task tracker app where each task has a title
  and a due date") produced exactly the specified shape:
  ```
  ## Resource
  Task

  ## Fields
  - title: string
  - due_date: date
  ```
- A vague description ("build me an app for my business") correctly
  triggered the `QUESTION:` path, with no file written to `--out`:
  > What single resource should the app manage first — for example,
  > Customers, Invoices, or Products — and what fields should each record
  > have (e.g., name, email, price)?

The corresponding `codegen-agent --spec` change (JSON.parse → plain-text
read) is covered by its own updated unit tests and a typecheck, not a
fresh full Docker/Rails pilot run — the design already treats a misread
spec as something the existing final `bundle exec rspec` check catches,
same as any other Codegen Agent mistake, so re-proving the whole Rails
pipeline wasn't judged necessary for a change this small and
this well-covered by existing tests.

## Summary

A CLI tool that takes a free-text product description and turns it into a
short markdown "build brief" describing one resource and its fields — the
same file the Codegen Agent's `--spec` flag then reads directly. No JSON,
no schema, no parser: both the Intake Agent's output and the Codegen
Agent's input are just text handed between two LLM-driven steps, the same
way `stack-spec/guidelines/*.md` is already handed to the Codegen Agent
verbatim rather than parsed into a data structure. This is the smallest
possible slice: it plugs straight into the Codegen Agent that already
exists, rather than building the richer spec format (entities/relations,
roles, workflows, screens, multi-resource) from the original plan before
anything downstream can consume it.

This revises an earlier draft of this doc, which proposed either a
tool-called JSON object or a markdown-in/JSON-out deterministic parser.
Both were dropped: the Codegen Agent already just does
`JSON.stringify(buildSpec)` into a plain-text prompt message (see
[`agent.ts:61`](../../packages/codegen-agent/src/agent.ts)) — the JSON
was never doing real structural work downstream, only adding a place for
the model's tool-call arguments to come back malformed.

## Feature-set impact

New: given a plain-English description like "a task tracker where each
task has a title and a due date," running the Intake Agent CLI produces a
markdown build-brief file — the same input `codegen-agent --spec` already
takes — without the user hand-writing anything. If the description is
missing something a build needs (no clear resource name, no fields), the
CLI prints one clarifying question and exits instead of writing a guessed
brief. CLI-only in this milestone; no web UI or orchestrator involvement,
and the two agents are chained by hand:

```
intake-agent --description "..." --out spec.md
codegen-agent --workspace <path> --spec spec.md
```

This also changes existing, already-shipped behavior: the Codegen Agent's
`--spec` file is no longer required to be JSON — it's read as plain text
and dropped into the prompt as-is. A hand-written spec (JSON or otherwise)
still works exactly as before, since the Codegen Agent no longer inspects
its structure at all.

## Architecture impact

New component: **Intake Agent** (`packages/intake-agent`), the first
piece of the "Intake Agent" box in the
[target architecture](../blueprints/architecture.md#target-architecture)
diagram. It depends on `@app-builder/llm-client` — the same
provider-agnostic client the Codegen Agent uses — making a single request
per run (no tool-calling loop; there's no code to write or run here, just
one piece of text to produce).

Also changes an existing, already-implemented component:
**`packages/codegen-agent`** — `--spec` moves from "parse this file as
JSON into a `BuildSpec` object" to "read this file as text and pass it
through." This is a small, backward-compatible change (any existing JSON
spec file still works — it just becomes literal text in the prompt
instead of a re-serialized object) but it does touch code from an already
`done` backlog item, which is why it's called out explicitly here rather
than folded silently into the Intake Agent build.

No change to `packages/web`, `packages/orchestrator`, or `stack-spec/`.

## Components affected

- **`packages/intake-agent`** (new) — the CLI itself; no existing
  blueprint yet, one will be added under `docs/blueprints/components/`
  once built.
- **`packages/codegen-agent`** — `promptContext.ts`'s `loadBuildSpec`
  (currently `JSON.parse`) becomes a plain `readFile(..., "utf8")`
  returning a string; the `BuildSpec` type and its use in `agent.ts`
  (`RunCodegenLoopOptions.buildSpec`) become `string`; `agent.ts`'s
  `Build spec:\n${JSON.stringify(buildSpec, null, 2)}` becomes
  `Build spec:\n${buildSpec}`; `cli.ts`'s log line, which currently reads
  `buildSpec.resource`, logs the spec file path instead (there's no
  structured field left to read).

## Design

### Intake Agent: one call, free-form markdown out

No tool-calling, no schema. The system prompt asks the model to read a
product description and reply with a short markdown brief for **one**
Rails resource: a heading naming the resource, and a bullet list of
fields with plain-language types (`string`, `text`, `integer`, `boolean`,
`date`, `datetime`, etc. — the same vocabulary `stack-spec/guidelines`
already assumes for migrations). Example of what the model's raw response
looks like:

```
## Resource
Task

## Fields
- title: string
- done: boolean
```

If the description doesn't contain enough to do that — no clear resource
name, no fields, or it describes more than one resource (multi-resource
is out of scope this milestone) — the model instead replies with a single
clarifying question, and its response **must start with the literal line
`QUESTION:`** so the CLI can tell the two cases apart without parsing
anything else. This is the one bit of structure being kept, and it's a
`startsWith` check, not a parser:

```
QUESTION:
Which type should "priority" be — string or integer?
```

### CLI interface

```
intake-agent --description "<text>" --out <path-to-spec.md>
```

(`--description-file <path>` as an alternative to inline `--description`
for longer text.)

### Loop (single call)

1. Build a short system prompt: the task (write a one-resource markdown
   brief from a description, or ask one clarifying question), the field-
   type vocabulary, and the `QUESTION:` convention above.
2. One `llmClient.chat()` call with the description as the user message
   and a generous `maxTokens` (reuse the 4096 figure already proven
   sufficient for this endpoint in the Codegen Agent).
3. Read `message.content`:
   - Starts with `QUESTION:` → print it to stdout, write nothing to
     `--out`, exit 1 (distinguishes "needs more input" from "wrote a
     spec" for scripting).
   - Otherwise → write the content verbatim to `--out`, exit 0.
   - Empty content → agent error, exit non-zero (this model spends tokens
     on hidden reasoning before visible output, same as the Codegen
     Agent — an empty result here means something went wrong, not that
     there was nothing to say).
4. No retry loop. If the model asks a clarifying question, the human
   re-runs the CLI with a fuller `--description`. Multi-turn conversation
   is real scope, deferred (see below).

### Codegen Agent side change

- `promptContext.ts`: `loadBuildSpec(specPath)` → `readFile(specPath,
  "utf8")`, return type `string`. Delete the `BuildSpec`/`BuildSpecField`
  interfaces.
- `agent.ts`: `RunCodegenLoopOptions.buildSpec: string`; the seed message
  becomes `` `Build spec:\n${buildSpec}` `` (no `JSON.stringify`).
- `cli.ts`: drop the `buildSpec.resource` reference in the startup log
  line; log the resolved `--spec` path instead.
- Existing tests referencing the JSON `BuildSpec` shape update to pass a
  plain string instead — no test currently depends on `resource`/`fields`
  being structured (confirmed by reading `test/agent.test.ts` before this
  change).

## Out of scope (this milestone)

- The original plan's richer spec: entities/relations, roles, workflows,
  screens, multi-resource. Revisit once the Codegen Agent itself can
  consume more than one resource — no point extracting structure nothing
  downstream reads yet.
- Any schema or type validation of the markdown brief's fields — the
  Codegen Agent LLM interprets it itself, same as it already interprets
  `stack-spec/guidelines/*.md`. If it misreads a field, that surfaces the
  same way any other Codegen Agent mistake does: a failing `bundle exec
  rspec` at the end.
- Multi-turn clarification (a back-and-forth conversation instead of
  "print one question and exit"). Fine for a single-resource proof of
  concept; worth revisiting if one-shot clarification proves too blunt in
  practice.
- Any orchestrator/web integration — standalone CLI, chained by hand into
  the Codegen Agent, not triggered from the chat UI yet.
