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
