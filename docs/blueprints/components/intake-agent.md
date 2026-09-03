# Component Blueprint: `packages/intake-agent`

## Purpose

Turns a free-text product description into the markdown build-spec file
the [Codegen Agent](./codegen-agent.md)'s `--spec` flag reads directly.
First milestone (see [design record](../../designs/intake-agent-milestone-1.md)):
one resource, one LLM call, no schema — either a short markdown brief or
a single clarifying question, nothing in between. Extended to describe
an arbitrary number of related resources plus associations (see
[multi-resource-support.md](../../designs/multi-resource-support.md)).
Usable two ways: the standalone CLI, or as a library —
`packages/orchestrator`'s `/build` chat flow calls `runIntake()` directly
(see [wire-agents-into-chat.md](../../designs/wire-agents-into-chat.md)).

## Key files

- [`src/cli.ts`](../../../packages/intake-agent/src/cli.ts) — entrypoint;
  parses `--description`/`--description-file` + `--out`, writes the spec
  file or prints a clarifying question
- [`src/agent.ts`](../../../packages/intake-agent/src/agent.ts) —
  `runIntake`: one `llmClient.chat()` call, no tool-calling loop; returns
  `{ kind: "spec" | "question", content }` based on whether the response
  starts with the literal line `QUESTION:`. Retries once, silently, on a
  truly empty response before throwing `EmptyIntakeResponseError` — this
  model's hidden-reasoning token usage varies enough per call that an
  empty result is usually transient, not a real dead end (bug #2)
- [`src/promptContext.ts`](../../../packages/intake-agent/src/promptContext.ts) —
  the system prompt: the repeatable per-resource markdown shape (one or
  many `## Resource` blocks), the allowed field types and
  `belongs_to`/`has_many`/`has_one` association vocabulary, and the
  `QUESTION:` convention

## Design principle: markdown in, markdown out, no parser

The Codegen Agent already treats its `--spec` file as plain text dropped
into the prompt (see its blueprint) — there was never a real consumer of
structured JSON downstream. So this agent produces free-form markdown
too, and the only "structure" the CLI relies on is a `startsWith
("QUESTION:")` check to tell a clarifying question apart from a real
spec, not a parser. If the model misreads a field, that surfaces the same
way any other Codegen Agent mistake does — a failing `bundle exec rspec`
at the end, not a validation error here.

## CLI interface

```
intake-agent --description "<text>" --out <path-to-spec.md>
intake-agent --description-file <path> --out <path-to-spec.md>
```

Chained by hand into the Codegen Agent:

```
intake-agent --description "..." --out spec.md
codegen-agent --workspace <path> --spec spec.md
```

## Known limitations

- Associations limited to `belongs_to`/`has_many`/`has_one` — no
  many-to-many (`has_and_belongs_to_many`) yet; a description implying
  one gets a clarifying question instead.
- No entities beyond resources+fields+associations — no roles, workflows,
  or screens yet (the original plan's richer spec).
- One-shot clarification: a vague description gets one question, then the
  caller (CLI, or the orchestrator's `/build` handler) stops; there's no
  back-and-forth conversation loop.

## Tests

[`test/`](../../../packages/intake-agent/test) — unit tests for
`runIntake` (fake `LLMClient`: spec/question/empty-response/retry cases,
`maxTokens`, message shape) and `promptContext` (the markdown shape, the
`QUESTION:` convention, the field-type vocabulary, and the associations
shape). Verified manually against the real GLM endpoint for the spec
path, the clarifying-question path, and 2-/3-resource multi-resource
specs, and end-to-end as a library through the orchestrator's `/build`
flow (real browser UI) — see the design records.
