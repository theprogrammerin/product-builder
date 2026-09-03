# Design: Multi-Resource Support (Intake + Codegen Agents)

- **Backlog item**: [`docs/backlog.md`](../backlog.md) — # 6 (Phase 2 extension)
- **Status**: implemented — verified with real Docker/Rails runs 2026-09-02

## Outcome

Both required verification runs passed on the first try:

- **2 resources** (`List has_many :items` / `Item belongs_to :list`, from
  the user's real Todo List description): `bundle exec rspec` →
  **31 examples, 0 failures**. Converged in 35 iterations (scaled cap: 40).
  Built a `[:list_id, :done]` index, an `extended` Blueprinter view
  embedding items in a list response, and disabled Rails' implicit JSON
  param wrapping so the `params.require` → 400 contract actually holds.
- **3 resources** (`List → Item → Comment`, two chained associations):
  `bundle exec rspec` → **36 examples, 0 failures**. Converged in 40
  iterations (scaled cap: 60). Built all three resources in correct
  dependency order, nested routes one level deep as instructed, and
  independently adapted to the installed Blueprinter version's real API
  (`render` with `root:`/`meta:`, no `render_collection`) without being
  shown example code.

In both runs the model made and self-corrected a couple of ordinary
mistakes (a truncated spec-file write, a typo in a test fixture) before
its own final check — exactly what the "never trust the model's own
'done', verify by actually running the suite" design is for, not a new
bug. No changes were needed to the design as agreed; the iteration-budget
formula's starting constants (25 floor, +20/resource) held for both
cases without adjustment.

## Summary

Both agents are currently hard-limited to one resource per run: the
Intake Agent refuses (asks a `QUESTION:`) the moment a description
implies more than one resource, and the Codegen Agent's prompt only ever
describes building "the resource" singular. This lifts that limit for an
**arbitrary number** of related resources — not just two — e.g. a Todo
List app's `List has_many Items`, or a deeper chain like `List has_many
Items`, `Item has_many Comments`. The markdown brief format grows a
repeatable per-resource shape plus an associations line; the Codegen
Agent's system prompt changes from "build the resource" to "build every
resource described, in dependency order." No new components, no parser
introduced on either side — same "markdown in, markdown out, model
interprets it" principle as the rest of both agents.

This is real, uncertain scope, in the same category as Milestone 1: it
needs a real design doc and real Docker/Rails verification runs, not a
skip-the-doc bug fix.

## Feature-set impact

- **Intake Agent**: a description of N related resources produces one
  markdown brief describing all N of them and how they relate to each
  other, instead of asking the user to narrow to one. Still asks a
  `QUESTION:` when something is genuinely missing or unresolvable (no
  clear resource names/fields, or a circular relationship the model can't
  order — e.g. "A belongs to B and B belongs to A" with both required).
- **Codegen Agent**: given such a brief, builds every resource in it —
  models, migrations (with correct foreign keys), controllers,
  serializers, the associations themselves, and specs for each — in one
  CLI run, verified by one final `bundle exec rspec` covering all of
  them. Resources are built in dependency order (a resource other
  resources reference is built before them), the same way a human would
  do it by hand.
- **User-visible outcome**: a description like "a List that has many
  Items, and each Item can have many Comments" goes Intake → Codegen
  end-to-end and produces a working three-resource backend with both
  associations wired up.

## Architecture impact

No new components — both existing packages change; no CLI interface
change on either agent.

- **`packages/intake-agent`**: `promptContext.ts`'s system prompt allows
  repeated `## Resource` sections (see markdown shape below) and an
  association vocabulary (`belongs_to`/`has_many`/`has_one`); the
  "multi-resource → always ask a question" rule is replaced with "ask
  only when something's actually missing or unresolvable."
- **`packages/codegen-agent`**: `promptContext.ts`'s required-sequence
  instructions change from "build the one resource" to "build every
  resource described, in dependency order, each through the full
  sequence, then run the whole suite once." `agent.ts`'s
  `DEFAULT_MAX_ITERATIONS` (currently a fixed 25) becomes a function of
  how many resources the spec text mentions (see below) rather than a
  flat constant, since a fixed number that happens to work for two
  resources won't scale to five.
- **Real risk, flagged honestly**: whether this GLM model can correctly
  sequence and build N related resources (right foreign keys, right
  build order, every suite passing) within a reasonable iteration budget
  is genuinely unproven — the same category of uncertainty Milestone 1
  had, which took 5 real runs to resolve. This needs actual Docker/Rails
  verification against a 2-resource case (List/Item) and a 3-resource
  case (List/Item/Comment) before being called done, not unit tests
  alone.

## Components affected

- [`packages/intake-agent`](../../packages/intake-agent) — `promptContext.ts`
  (system prompt), see [component blueprint](../blueprints/components/intake-agent.md)
- [`packages/codegen-agent`](../../packages/codegen-agent) — `promptContext.ts`
  (system prompt), `agent.ts` (`DEFAULT_MAX_ITERATIONS`), see
  [component blueprint](../blueprints/components/codegen-agent.md)

## Design

### Markdown shape: repeated resource blocks, not capped at two

Each resource gets its own `## Resource` / `## Fields` pair, same as
today, plus an optional `## Associations` block using plain Rails
association syntax. Nothing caps the number of blocks — the Intake
Agent's prompt says "one block per resource, as many as the description
needs," and the Codegen Agent's prompt reads however many blocks are
actually there. Example for the three-resource chain:

```
## Resource
List

## Fields
- name: string

## Associations
- has_many :items

## Resource
Item

## Fields
- title: string
- done: boolean

## Associations
- belongs_to :list
- has_many :comments

## Resource
Comment

## Fields
- body: text

## Associations
- belongs_to :item
```

A single-resource brief (no `## Associations` block at all) stays exactly
as it is today — this is a strict superset of the existing shape, not a
breaking change to it.

### Intake Agent prompt changes

- State the resource-block-per-resource shape above, explicitly noting
  there's no limit on how many blocks — "describe every resource the
  product description implies, not just the first one."
- Association vocabulary: `belongs_to :x` / `has_many :xs` / `has_one :x`
  only. `has_and_belongs_to_many` / join-table associations are out of
  scope this milestone (see below) — if a description implies one, ask a
  `QUESTION:` rather than guessing a shape that isn't supported yet.
- `QUESTION:` still fires for: no clear resource/field info (as today),
  and now also a circular required relationship the model can't put in a
  buildable order (e.g. two resources each requiring a non-nullable
  reference to the other).

### Codegen Agent prompt changes

Required sequence changes from a single resource's steps to:

1. Read the full build spec; identify every `## Resource` block and the
   dependency order implied by `## Associations` (a resource referenced
   by `belongs_to` in another block must be built — migration + model —
   before the block that references it).
2. For each resource, in that order: migration + model (with its
   associations) → run the migration → controller + serializer → RSpec
   request/model specs, before moving to the next resource. Same
   per-resource sequence as Milestone 1, just repeated.
3. Only after every resource is done, run `bundle exec rspec` once for
   the whole suite and fix any failures before considering the work
   finished — unchanged from today, just now covering N resources'
   worth of specs instead of one.

### Iteration budget scales with resource count

`DEFAULT_MAX_ITERATIONS` (25, sized for one resource in Milestone 1)
becomes a function of how many `## Resource` headings the spec text
contains — a cheap `spec.match(/^## Resource$/gm)?.length ?? 1` count,
**not** a real parse of fields/associations, so it doesn't reintroduce
the JSON-spec parsing problem this design deliberately avoided elsewhere:

```
maxIterations = Math.max(25, resourceCount * 20)
```

25 stays the floor (matches the proven single-resource figure); each
additional resource adds a further 20 — a starting number to validate
against the real 2- and 3-resource runs below, not a figure treated as
final without that evidence.

## Out of scope (this milestone)

- `has_and_belongs_to_many` / join-table (many-to-many) associations —
  `belongs_to`/`has_many`/`has_one` only.
- Any resource count limit is a documented, not hard-coded — but only
  2- and 3-resource cases are actually verified before this is marked
  done; nothing stops a larger spec from being tried, but its iteration
  budget and success rate are unproven beyond that.
- Auth, MongoDB, Sidekiq, frontend generation — still real Phase 1/2 work
  untouched by this design.
- Multi-turn clarification — unchanged from Milestone 1: one `QUESTION:`
  and exit, no conversation loop.
