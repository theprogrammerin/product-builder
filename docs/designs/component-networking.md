# Design: Component networking guideline — no hardcoded cross-component URLs

- **Backlog item**: [`docs/backlog.md`](../backlog.md) — Feature # 17
  (supersedes bug # 13)
- **Status**: implemented — unit-tested (`run-agent` provides
  `<NAME>_URL` for every component to every component) and live-verified
  against `test_feature14_a`: a `/stop` + `/run` cycle recreated its
  containers with the new `docker-compose.yml`, the frontend bundle
  correctly embedded the real allocated backend URL, and the app loaded
  real data end-to-end in the browser with no CORS or connection error.
  Scope adjustment made during implementation: `test_feature14_a`'s own
  `cors.rb`/`Gemfile` were **not** retrofitted with the template's
  version — its own Debug Agent had already fixed CORS there
  independently (a deliberately-reasoned wildcard-origin approach,
  justified by non-credentialed JWT auth, with its own design doc) before
  this feature's work began; only its `docker-compose.yml` was aligned to
  the new `${RAILS_URL}` convention (a mechanically-equivalent change, no
  behavior difference).

## Summary

Two point-fixes already happened this week for the same underlying gap:
bug #12 (frontend hardcoded to port 3000) and bug #13 (missing CORS,
still open) are both instances of generated code assuming a fixed,
shared origin between components — an assumption that's false the moment
the Run Agent allocates a different free port on every run. Rather than
patch each occurrence as it's found, this establishes the convention
properly: a new stack-spec guideline instructs the Codegen Agent (and
Debug Agent, which shares its prompt-loading mechanism) to always assume
components run on separate origins, and the Run Agent is extended to
generically provide every component's full URL as an environment
variable — not just its own port — so any component can correctly
reference any other one regardless of what got allocated.

## Feature-set impact

- Every newly generated project's backend comes with working CORS out of
  the box — `rack-cors` in the `Gemfile`, `config/initializers/cors.rb`
  actually configured to read the allowed origin from an environment
  variable, not the framework's default commented-out stub.
- The Codegen Agent is instructed to never hardcode a URL/port when one
  component needs to reach another — always read it from an environment
  variable, following a documented naming convention
  (`<NAME>_HOST_PORT`, now joined by `<NAME>_URL`).
- The Run Agent provides `<NAME>_URL` (a component's full reachable URL)
  for every exposable component it brings up, alongside the existing
  `<NAME>_HOST_PORT`.
- This properly, generically fixes bugs #12 and #13 — replacing bug
  #12's ad-hoc patch (`http://localhost:${RAILS_HOST_PORT}`) with the
  general mechanism, and giving bug #13 (CORS) a real fix instead of
  remaining deferred.

## Architecture impact

No new components.

- **`packages/run-agent`**: `runAgent.ts`'s `start()` gains one more
  computed env var per component (`<NAME>_URL`) alongside the existing
  `<NAME>_HOST_PORT`, passed to the same `docker compose up -d` call —
  so it's available for `${...}` interpolation in *any* service's
  `environment:` block, not just the component that owns that port.
- **`stack-spec/guidelines/`**: new guideline file. No code change to
  either agent package — both already load every `guidelines/*.md` file
  verbatim into their system prompts ([`promptContext.ts`](../../packages/codegen-agent/src/promptContext.ts)
  in each).
- **`stack-spec/template/`**: retrofit the starting scaffold to already
  follow the convention (same precedent as bug #7's `puma` fix — bake it
  in, don't rely on the model remembering every time):
  `backend/Gemfile`+`Gemfile.lock` gain `rack-cors`; `cors.rb` is
  actually configured; `docker-compose.yml`'s `frontend`/`rails`
  services reference `${RAILS_URL}`/`${FRONTEND_URL}` instead of bug
  #12's ad-hoc interpolation.
- **`test_feature14_a`**'s own copy gets the identical retrofit, so bug
  #13 is actually resolved there too, not just for future projects.

## Components affected

- `packages/run-agent` — [`src/runAgent.ts`](../../packages/run-agent/src/runAgent.ts):
  compute and pass `<NAME>_URL` per component.
  [component blueprint](../blueprints/components/run-agent.md)
- `stack-spec` — new [`guidelines/component-networking.md`](../../stack-spec/guidelines/component-networking.md);
  `template/backend/Gemfile`+`Gemfile.lock`, `template/backend/config/initializers/cors.rb`,
  `template/docker-compose.yml`. [component blueprint](../blueprints/components/stack-spec.md)
- `packages/orchestrator/generated-projects/4ed8e3c1-.../` (the
  `test_feature14_a` workspace) — same retrofit as the template, applied
  directly (never regenerated/deleted, per this repo's own convention).

## Design

**`packages/run-agent/src/runAgent.ts`** — one change, in the existing
env-building loop:

```ts
const componentEnv: Record<string, string> = {};
for (const component of components) {
  const port = ports.get(component.name)!;
  componentEnv[component.envVar] = String(port);
  componentEnv[`${component.name.toUpperCase()}_URL`] = `http://localhost:${port}`;
}
```

Every component already gets the *same* `componentEnv` map passed to the
*same* `docker compose up -d` invocation (see existing code just below),
so a service's `environment:` block can reference `${RAILS_URL}`,
`${FRONTEND_URL}`, etc. regardless of which of those services it itself
is.

**`stack-spec/guidelines/component-networking.md`** (new):

```markdown
# Component networking

Every component this stack can generate (Rails backend, Expo/React
Native frontend, Sidekiq, and anything added later) can run on its own,
independently-allocated host port and origin — never assume a fixed
port or that two components share an origin.

## Never hardcode another component's URL

If a component needs to reach another component (the frontend calling
the backend's API; the backend needing to know the frontend's origin for
CORS), read that URL from an environment variable — never hardcode
`localhost:<port>` or any other fixed host/port.

The Run Agent provides, for every component declared in
`docker-compose.yml` with a `${<NAME>_HOST_PORT}:<container-port>` port
mapping:

- `<NAME>_HOST_PORT` — the raw allocated host port.
- `<NAME>_URL` — that component's full reachable URL (e.g. `RAILS_URL`,
  `FRONTEND_URL` — the service name, upper-cased, plus `_URL`).

Reference these via docker-compose's own `${...}` interpolation in a
service's `environment:` block, e.g.:

    frontend:
      environment:
        EXPO_PUBLIC_API_BASE_URL: "${RAILS_URL}/api/v1"
    rails:
      environment:
        FRONTEND_ORIGIN: "${FRONTEND_URL}"

then read the resulting env var in application code
(`process.env.EXPO_PUBLIC_API_BASE_URL`, `ENV["FRONTEND_ORIGIN"]`) —
never a literal string.

These env vars are only populated once the Run Agent brings the stack up
(`docker compose up -d`) — they are **not** set during your own
`docker compose run --rm` build/verify commands. Code and tests must not
assume they're present at build time: fall back to a permissive default
(e.g. `ENV.fetch("FRONTEND_ORIGIN", "*")`) rather than failing when unset.

## CORS

Any backend component serving a frontend on a different origin (which,
per above, is always assumed) must configure CORS to allow that
origin — sourced from an environment variable as above, not a hardcoded
domain and not left as the framework's default commented-out stub.
```

**`stack-spec/template/backend/Gemfile`**: add `gem "rack-cors"`,
regenerate `Gemfile.lock` via a real `bundle install` (same process as
bug #7's `puma` fix — not hand-edited).

**`stack-spec/template/backend/config/initializers/cors.rb`**: replace
the commented-out stub with a real, working configuration:

```ruby
Rails.application.config.middleware.insert_before 0, Rack::Cors do
  allow do
    origins ENV.fetch("FRONTEND_ORIGIN", "*")
    resource "*", headers: :any, methods: [:get, :post, :put, :patch, :delete, :options, :head]
  end
end
```

**`stack-spec/template/docker-compose.yml`**: `rails` gains
`FRONTEND_ORIGIN: "${FRONTEND_URL}"`; `frontend`'s
`EXPO_PUBLIC_API_BASE_URL` changes from bug #12's
`"http://localhost:${RAILS_HOST_PORT}/api/v1"` to `"${RAILS_URL}/api/v1"`.

`test_feature14_a`'s own `docker-compose.yml`, `Gemfile`, `Gemfile.lock`,
and `cors.rb` get the identical retrofit, applied directly to that
workspace (not regenerated).

## Out of scope

- Retrofitting *every* other already-generated test project in
  `generated-projects/` — only `test_feature14_a` (the one actively
  being tested/debugged) gets the direct retrofit; others pick up the
  fix only if rebuilt from the template going forward.
- A general mechanism for the Codegen Agent to declare *new* components
  beyond backend/frontend/sidekiq (e.g. a worker dashboard) — the
  guideline covers the convention for when that happens, but no new
  scaffold/template support for additional component types is added
  here.
- Changing how CORS behaves for the CLI-driven (non-Docker,
  `docker compose run --rm`) codegen/debug flow — those never talk to a
  live frontend origin at all.
