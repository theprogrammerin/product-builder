# Testing

Every generated app must be runnable and self-verifying — the Codegen
Agent uses these suites as its own feedback loop (write layer, run tests,
fix, move on), not just as a deliverable for the end user.

## Backend: RSpec + FactoryBot

- One factory per model in `spec/factories/`, built from the build spec's
  entity fields — no hand-written fixtures.
- Request specs (not just model specs) for every controller action, hitting
  real routes with `rack-test`, covering: happy path, validation failure,
  unauthorized access, not-found.
- Model specs for validations, associations, and any custom business logic
  methods.
- Job specs for every Sidekiq job (enqueued correctly, performs correctly,
  idempotent on re-run).

## Frontend: Jest + React Native Testing Library

- Render test per screen (renders without throwing, key elements present).
- Unit tests for every Zustand store's actions and derived selectors.
- API client tests using a mocked fetch layer — no real network calls in
  the test suite.

### Must-pass vs. nice-to-have

Not every assertion is worth the same fight. Split failures into two
tiers before deciding whether the suite blocks completion:

- **Must pass** — anything verifying the app actually works: rendering
  with real data, store/API/business logic, navigation, error and empty
  states. A failure here means the app is broken; keep fixing it.
- **Nice to have** — accessibility-attribute assertions (e.g.
  `getByLabelText`/`getByRole` on a third-party component like React
  Native Paper's `TextInput`, whose accessibility wiring is not always
  exposed the way React Native Testing Library expects). A failure here
  is usually a query-technique mismatch with the component library's
  internals, not evidence the screen is actually broken.

If a nice-to-have assertion won't pass after one real attempt (e.g.
switching to `getByPlaceholderText`/`getByTestId` didn't help either),
mark it `it.skip("reason: ...")` with a one-line reason instead of
burning further iterations on it — a skipped test doesn't fail the
suite. Never skip a must-pass test to force a green run; that's exactly
the kind of "looks done" the final verification step exists to catch.

## What "done" means for the Codegen Agent

A generation run is not complete until, inside the sandbox:

1. `bundle exec rspec` passes with no failures.
2. `bundle exec rails db:migrate` runs clean against a fresh MySQL +
   MongoDB pair (via `docker-compose`).
3. `npx jest` passes with no failures on the frontend — skipped
   nice-to-have tests (see above) don't count as failures.
4. `docker compose config` validates and `docker compose up` brings up
   rails + mysql + mongo + redis + sidekiq without crash-looping.

Any of these failing sends the agent back to fix the relevant layer before
it's allowed to report the run as finished.
