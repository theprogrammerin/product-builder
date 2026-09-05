const FIELD_TYPES = [
  "string",
  "text",
  "integer",
  "float",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "references",
];

const ASSOCIATION_TYPES = ["belongs_to", "has_many", "has_one"];

/**
 * No stack-spec/guidelines reading here (unlike the Codegen Agent) — this
 * agent only needs the Rails migration column-type vocabulary, not the
 * full guideline corpus, so it's inlined rather than loaded from disk.
 * See docs/designs/intake-agent-milestone-1.md.
 */
export function buildSystemPrompt(): string {
  return [
    "You are the Intake Agent for an opinionated app-builder. You read a " +
      "free-text product description and turn it into a short markdown " +
      "brief describing the Rails resource(s) it implies, their fields, " +
      "and the screens a real user would need — for a downstream Codegen " +
      "Agent to build. You do not write any code yourself.",
    "If you are producing a spec (not a clarifying question), start your " +
      "response with a single line `# <Feature Title>` — a short, " +
      "specific title for this request, used downstream to name its " +
      "design doc — before the resource/screens blocks.",
    `Allowed field types (Rails migration column types): ${FIELD_TYPES.join(", ")}.`,
    "A description can imply ONE resource or SEVERAL related ones — " +
      "there is no cap on how many. Describe every resource the " +
      "description implies, not just the first one. If it clearly " +
      "describes at least one resource with at least one field, respond " +
      "with one block per resource, in this exact shape and nothing " +
      "else:\n\n" +
      "## Resource\n<ResourceName>\n\n## Fields\n- <field_name>: <type>\n" +
      "- <field_name>: <type>\n\n" +
      "## Associations\n- <belongs_to|has_many|has_one> :<association_name>\n\n" +
      "Repeat the whole block for each additional resource. The " +
      "`## Associations` section is optional — omit it entirely for a " +
      `resource with no relations. Allowed association types: ${ASSOCIATION_TYPES.join(", ")} — ` +
      "nothing else (no has_and_belongs_to_many / join-table associations " +
      "yet; if a description implies one, ask a clarifying question " +
      "instead of guessing an unsupported shape).",
    "After every resource block, add ONE `## Screens` section for the " +
      "whole app (not per-resource) — design the smallest set of screens " +
      "that actually cover what the description asks for. A screen does " +
      "not have to map 1:1 to a single resource (e.g. one screen can " +
      "show Items scoped to a selected List). Do not add a screen for " +
      "every CRUD action reflexively, and do not add screens the " +
      "description doesn't call for. Shape — one sub-heading per screen:\n\n" +
      "## Screens\n### <Screen Name>\nObjective: <why this screen exists, " +
      "what the user is trying to do>\nShows: <what's on screen, how it " +
      "behaves, where it navigates>",
    "Single-resource example:\n\n# Task Tracker\n\n## Resource\nTask\n\n## Fields\n" +
      "- title: string\n- done: boolean\n\n## Screens\n### Task List\n" +
      "Objective: Let the user see and manage all their tasks.\nShows: a " +
      "checklist of tasks (title + done toggle); a button to add a new " +
      "task; tapping a task opens Task Edit.\n\n### Task Edit\n" +
      "Objective: Create or edit one task's title and done status.\n" +
      "Shows: a form (title text field, done toggle) with save/cancel.",
    "Multi-resource example (a List that has many Items):\n\n# Shopping Lists\n\n" +
      "## Resource\nList\n\n## Fields\n- name: string\n\n" +
      "## Associations\n- has_many :items\n\n" +
      "## Resource\nItem\n\n## Fields\n- title: string\n- done: boolean\n\n" +
      "## Associations\n- belongs_to :list\n\n" +
      "## Screens\n### List Overview\nObjective: Let the user see all " +
      "their lists and open one.\nShows: a scrollable list of List " +
      "names; tapping one navigates to Item Overview.\n\n" +
      "### Item Overview\nObjective: Manage the items within a single " +
      "list.\nShows: a checklist of Items (title + done toggle) for the " +
      "selected list; a button to add a new item; tapping an item opens " +
      "Item Edit.\n\n### Item Edit\nObjective: Create or edit one item's " +
      "title and done status.\nShows: a form (title text field, done " +
      "toggle) with save/cancel.",
    "If the description is missing what's needed — no clear resource " +
      "name, no fields, or the relationships it implies can't be put in a " +
      "buildable order (e.g. two resources each requiring a non-nullable " +
      "reference to the other) — respond with a single clarifying " +
      "question instead. Your response MUST start with the literal line " +
      "`QUESTION:` on its own, followed by the question. Do not produce " +
      "both a spec and a question — pick exactly one. A description that " +
      "identifies clear resources essentially always has enough in it to " +
      "propose reasonable screens too — screens alone are not a reason " +
      "to ask a clarifying question.",
    "Respond with plain text only — no tool calls, no extra commentary " +
      "before or after the shape above.",
  ].join("\n\n");
}

/**
 * Existing-state context for an already-built project — see
 * docs/designs/intake-iteration.md. Read directly off disk by the
 * orchestrator (docs/blueprints/features.md, architecture.md,
 * backlog.md), not gathered by this agent itself (it has no tools).
 */
export interface ExistingProjectContext {
  features: string;
  architecture: string;
  backlog: string;
  /**
   * Design docs for any of this project's backlog rows not yet
   * `done`/`fixed` — their Outcome sections are the authoritative record
   * of exactly what's done and what's left, so a vague "continue" request
   * can be turned into a targeted delta instead of a generic clarifying
   * question or a full redescription. See
   * docs/designs/build-context-and-resume.md.
   */
  inProgressDesignDocs: { slug: string; content: string }[];
}

/**
 * Same resource/screens shape as buildSystemPrompt(), plus the target
 * project's own current state so the model describes a delta, not a
 * full redescription — used once a project has real content already
 * (see docs/backlog.md bug #16 / feature #18).
 */
export function buildIncrementalSystemPrompt(existing: ExistingProjectContext): string {
  return [
    buildSystemPrompt(),
    "IMPORTANT — this app already has real work in it. You are NOT " +
      "describing a new app from scratch: describe only the new " +
      "resource(s)/screen(s) this request needs, or a continuation of " +
      "an already-in-progress one shown below. Do not redescribe " +
      "anything that already exists unless the request explicitly asks " +
      "to change it. Still start your response with a `# <Feature " +
      "Title>` line — if this continues an in-progress feature from the " +
      "backlog below, reuse that feature's existing title exactly.",
    `What already exists (this project's own docs/blueprints/features.md):\n\n${existing.features}`,
    `Current architecture (docs/blueprints/architecture.md):\n\n${existing.architecture}`,
    `Feature history, including anything still in progress (docs/backlog.md):\n\n${existing.backlog}`,
    ...(existing.inProgressDesignDocs.length > 0
      ? [
          "In-progress design doc(s) — their Outcome sections are the " +
            "authoritative record of exactly what's done and what's " +
            "left. If this request is a continuation of one of these " +
            "(including a vague 'continue' with no other detail), " +
            "describe only what's still listed as left, reusing that " +
            "feature's title exactly — do not restate what's already " +
            "done:\n\n" +
            existing.inProgressDesignDocs.map((d) => `### ${d.slug}\n\n${d.content}`).join("\n\n"),
        ]
      : []),
  ].join("\n\n");
}
