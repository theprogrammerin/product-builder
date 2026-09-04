# Component Blueprint: `packages/run-agent`

## Purpose

Stands up a generated project's own `docker-compose.yml` as long-lived
containers and hands back a live, reachable URL per component — distinct
from the Codegen Agent's `dockerExec.ts`, which only ever runs ephemeral
`docker compose run --rm` commands for its build/verify loop. Usable
standalone as a library; `packages/orchestrator` is its consumer, both
automatically (once a build finishes writing its app) and via `/run`/
`/stop`. See [run-deploy-agent.md](../../designs/run-deploy-agent.md).

A project is not assumed to be exactly "one backend + one frontend" — the
Run Agent discovers however many components a project's own
`docker-compose.yml` declares as exposable and treats them uniformly.

## Key files

- [`src/composeInfo.ts`](../../../packages/run-agent/src/composeInfo.ts) —
  parses `docker-compose.yml` (via the `yaml` package); a service is
  "exposable" if one of its `ports:` entries matches
  `${<NAME>_HOST_PORT}:<container-port>` — no separate manifest file, no
  build-spec parsing
- [`src/portAllocator.ts`](../../../packages/run-agent/src/portAllocator.ts) —
  `findFreePort()`: binds to port 0, reads back the OS-assigned port,
  releases it
- [`src/dockerCompose.ts`](../../../packages/run-agent/src/dockerCompose.ts) —
  runs `docker compose <args>` rooted at a workspace; used for `up -d`,
  the migration `run --rm`, and `stop` — long-lived lifecycle commands,
  unlike the Codegen Agent's one-off `run --rm`
- [`src/healthCheck.ts`](../../../packages/run-agent/src/healthCheck.ts) —
  `waitForHealthy(url)`: polls until any HTTP response comes back or a
  timeout elapses — confirms the server is reachable, not that the app
  behind it is bug-free
- [`src/runAgent.ts`](../../../packages/run-agent/src/runAgent.ts) —
  `createRunAgent().start()`/`.stop()`, the orchestration: discover →
  allocate ports → bring up dependencies → migrate (if a `rails`
  component is present) → bring up components → health-check → report

## `start()` sequence

1. Parse `docker-compose.yml`; discover exposable components.
2. `docker compose up -d <dependency services>` — everything with no port
   placeholder (mysql/mongo/redis today).
3. If a `rails` component is present: `docker compose run --rm rails
   bin/rails db:create db:migrate`.
4. `docker compose up -d <components>`, with each one's `<NAME>_HOST_PORT`
   env var set to its freshly allocated port, *and* a `<NAME>_URL` (the
   component's full `http://localhost:<port>`) for every component,
   passed to every other one too — so any service's `environment:` block
   can reference any other component's real URL regardless of which of
   those services it itself is (feature #17; see
   [stack-spec guideline](../../../stack-spec/guidelines/component-networking.md)).
5. Health-check every component's URL; report `{ status: "live",
   components }` or `{ status: "failed", error }`.

`stop()` runs `docker compose stop` with no service arguments — not
`down`: named volumes, the network, and data all survive, so a follow-up
`start()` is fast and doesn't need to re-run migrations.

## A real bug this surfaced

Unit tests mock Docker, so they couldn't have caught this: live
verification found that `docker compose up -d` returns once a container
*starts*, not once the process inside is ready. The migration step raced
MySQL's first-boot initialization and failed
(`Can't connect to server on 'mysql' (115)`). Fixed with a real Compose
healthcheck on `mysql` (`mysqladmin ping`) plus `depends_on: condition:
service_healthy` on `rails`/`sidekiq` in
[`stack-spec/template/docker-compose.yml`](../../../stack-spec/template/docker-compose.yml) —
both `up -d` and `run --rm` now genuinely wait for MySQL. A second, unrelated
gap found the same way: the generated backend's `Gemfile` never included a
web server gem (`rails server` needs `puma`), unnoticed until now because
verification only ever ran `bundle exec rspec`. Fixed in
[`stack-spec/template/backend/Gemfile`](../../../stack-spec/template/backend/Gemfile).

A third gap, found live much later (bug #12): the Run Agent allocates a
fresh, unpredictable `RAILS_HOST_PORT` on every `start()`, but nothing
propagated it into the `frontend` component — its API client fell back to
a hardcoded `http://localhost:3000/api/v1` default, which only happened
to work when the allocated port landed on exactly 3000. First patched
ad hoc (`EXPO_PUBLIC_API_BASE_URL: http://localhost:${RAILS_HOST_PORT}/api/v1`),
then properly generalized as feature #17: the Run Agent now computes a
`<NAME>_URL` for every component and passes it to every other component
too, and `docker-compose.yml` references `${RAILS_URL}` generically
instead. This also gave bug #13 (missing CORS — a generated backend's
`cors.rb` was the framework's default commented-out stub, so the
frontend could never complete a real request regardless of port) a real
fix: the template now ships `rack-cors` configured to read the allowed
origin from `FRONTEND_ORIGIN` (itself sourced from `${FRONTEND_URL}`).
Live re-verified end-to-end on a real generated project: the served
frontend bundle embeds the real allocated backend URL, and the app loads
real data in the browser with no CORS or connection error. See
[component-networking.md](../../designs/component-networking.md).

## Known limitations

- Assumes a single running instance per project — no support for multiple
  concurrent instances of the same project.
- No reconciliation if containers are stopped/removed outside the app
  (e.g. `docker compose down` run by hand) — `running_instances` can go
  stale; a stuck "already live" state needs a manual `/stop` then `/run`.
- No idle-timeout auto-stop — a live instance stays up until explicitly
  stopped.
- `HTTPS`/reverse proxy/stable domains are out of scope — `localhost:PORT`
  only.

## Tests

[`test/`](../../../packages/run-agent/test) — `composeInfo.test.ts`
(parsing, including scaling to a third/unrelated component with no code
change) and `runAgent.test.ts` (fake docker/port/health-check deps —
the full dependency→migrate→components sequence, failure at each step,
and `stop()`). No Docker required for these. The real sequence — port
allocation, the MySQL healthcheck race, the missing `puma` gem, and a
full live start → fetch → stop → restart cycle — was verified against a
real, previously-built generated project; see
[run-deploy-agent.md](../../designs/run-deploy-agent.md)'s Outcome section.
