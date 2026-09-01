# Design: Project Scaffolding

- **Backlog item**: [`docs/backlog.md`](../backlog.md) — # 1
- **Status**: implemented

## Summary

Every new project gets an identical starting codebase, copied from one
fixed structural-skeleton template matching the locked stack, so future
agent-built features (Phase 1+) land on a consistent, known base instead
of starting from nothing. That base includes not just app code but the
same governance loop this meta-project follows (`CLAUDE.md`,
`docs/backlog.md`, `docs/blueprints/`, `docs/designs/`, `CHANGELOG.md`) —
so any future agent or human building features *into* a generated app
follows the same backlog → prioritize → impact → design doc → build
discipline there, scoped to that app instead of the builder tool.

## Feature-set impact

Creating a project (via the UI's "+ New project" or `POST /api/projects`)
now also provisions a starting codebase for it on disk, deterministically
— no LLM call. No new user-facing UI in v1; the only visible change is
that project creation now returns a `workspacePath` and fails outright if
scaffolding fails. `docs/blueprints/features.md` gets a new "Project
scaffolding" entry once this ships.

## Architecture impact

- New data artifact: `stack-spec/template/` — a structural skeleton
  (folders + key config file stubs), not an installed/runnable app.
- `packages/orchestrator` gains a new responsibility: on project
  creation, copy `stack-spec/template/` to a per-project directory on
  disk before the project is considered to exist.
- `Project` gains a `workspacePath` field.
- No change to `packages/web` or `packages/llm-client`.

## Components affected

- [`stack-spec`](../blueprints/components/stack-spec.md) — add
  `template/` (backend skeleton, frontend skeleton, `docker-compose.yml`,
  a README explaining it's a skeleton and must not be hand-edited
  per-project).
- [`orchestrator`](../blueprints/components/orchestrator.md) —
  new `src/scaffold.ts`; `src/projectStore.ts` gets a `workspacePath`
  field and a changed `create()` shape; `src/app.ts`'s
  `POST /api/projects` calls scaffold before the project is stored;
  `src/server.ts` reads the new `PROJECT_FILES_DIR` env var.

## Design

### `stack-spec/template/` (new, structural skeleton)

```
template/
  README.md                    # explains: skeleton, not runnable, don't hand-edit
  CLAUDE.md                    # mandatory feature workflow, generic — same loop as this repo's, scoped to the generated app
  CHANGELOG.md                 # starts with one entry: "Initial project scaffold created"
  docs/
    backlog.md                 # phased roadmap (1 row: scaffold done) + empty feature-request table, same shape as ours
    designs/
      TEMPLATE.md              # identical shape to this repo's docs/designs/TEMPLATE.md
    blueprints/
      features.md              # "nothing built yet beyond the skeleton"
      architecture.md          # this app's own architecture: backend/frontend/docker-compose + diagram
      components/
        backend.md
        frontend.md
  docker-compose.yml            # rails + mysql + mongo + redis + sidekiq
  backend/
    Gemfile                     # rails/mongoid/sidekiq/devise/devise-jwt/blueprinter/pundit/kaminari, versions per ../../versions.yaml
    Dockerfile                  # placeholder, no RUN bundle install yet
    config/database.yml         # MySQL, env-driven
    config/mongoid.yml          # MongoDB, env-driven
    app/{models,controllers,serializers,jobs}/.gitkeep
  frontend/
    package.json                # expo/react-navigation/zustand/react-native-paper, versions per ../../versions.yaml
    app.json                    # minimal Expo config
    src/{screens,api,store}/.gitkeep
    src/App.tsx                 # minimal placeholder component
```

Nothing under `backend/`/`frontend/` is `bundle install`ed or
`npm install`ed. Making it an actually-runnable app is Phase 1 (Codegen
Agent) work. The `CLAUDE.md`/`docs/`/`CHANGELOG.md` files, however, are
fully real and usable from day one — they're the same governance
mechanism as this repo's, just scoped to the generated project instead of
the builder tool, so whoever (agent or human) works on that project next
follows the same discipline.

### `packages/orchestrator/src/scaffold.ts` (new)

```ts
export interface ScaffoldConfig { filesDir: string }

export function loadScaffoldConfig(env = process.env): ScaffoldConfig;
// PROJECT_FILES_DIR env var, default "./generated-projects" (relative to
// orchestrator process cwd)

export async function scaffoldProject(
  projectId: string,
  config: ScaffoldConfig,
  templateDir?: string, // defaults to stack-spec/template resolved from this file's location
): Promise<string>; // returns the absolute destination path
```

Implementation: `fs.promises.mkdir(config.filesDir, { recursive: true })`
then `fs.promises.cp(templateDir, destination, { recursive: true, force:
false, errorOnExist: true })`, where `destination =
path.resolve(config.filesDir, projectId)`. `force: false` +
`errorOnExist: true` makes a collision (shouldn't happen — `projectId` is
a fresh UUID) a loud failure rather than a silent overwrite.

### `packages/orchestrator/src/projectStore.ts` (changed)

- `Project` gains `workspacePath: string` (always set — a project never
  exists in the store without it; see below).
- `create()` changes shape to accept a pre-generated id +
  `workspacePath`, since the id must exist before scaffolding runs and a
  project is only inserted into the store *after* scaffolding succeeds:

```ts
create(input: { id: string; name: string; workspacePath: string }): Project;
```

### `packages/orchestrator/src/app.ts` (changed)

`POST /api/projects` handler:

```ts
const id = randomUUID();
try {
  const workspacePath = await scaffold(id);
  const project = projectStore.create({ id, name: name.trim(), workspacePath });
  res.status(201).json({ project });
} catch (error) {
  res.status(500).json({ error: { code: "scaffold_failed", message: ... } });
}
```

No rollback logic needed: the project is never stored unless scaffolding
already succeeded, so a failure just means nothing was created. `scaffold`
is an injectable `(projectId: string) => Promise<string>` param on
`createApp` (default wired to `scaffoldProject` + `loadScaffoldConfig()`)
so `app.test.ts` can inject a fake that touches no real disk, while
`scaffold.ts` gets its own test using real temp directories.

### `packages/orchestrator/src/server.ts` / `.env.example` (changed)

Add `PROJECT_FILES_DIR` (optional, default `./generated-projects`).

### Root `.gitignore` (changed)

Add a pattern covering `generated-projects/` wherever it lands (per-project
scaffolded output must never be committed to this meta-repo).

## Out of scope

- Making the scaffold an actual installed/runnable app — Phase 1.
- Any UI to browse or download a project's scaffolded files.
- Regenerating or updating a project's files after creation — this runs
  once, at creation time, only.
