# Background Jobs & Caching

Redis serves two distinct roles in every generated app — Sidekiq's job
backend and the Rails cache store. Both are the same Redis instance in
`docker-compose` (different logical DBs), but treat them as separate
concerns in code.

## When a controller action must enqueue a job instead of running sync:

- It calls an external service (email, SMS, payment provider, push
  notification) whose latency/availability shouldn't block the HTTP
  response.
- It does non-trivial work (image/video processing, generating a report,
  bulk updates across many records).
- The build spec's workflow describes an action as happening
  "eventually"/"in the background" rather than as part of the user's next
  screen transition.

Otherwise, keep it synchronous — don't add job indirection for work that's
fast and has no external dependency; that just adds latency and failure
modes for no benefit.

## Sidekiq conventions:

- One job class per distinct unit of work, named `<Verb><Noun>Job` (e.g.
  `SendBookingConfirmationJob`), living under `app/jobs/`.
- Jobs take primitive/ID arguments (record IDs, not full objects) so they
  serialize cleanly and re-fetch fresh state on execution.
- Idempotency: every job must be safe to run twice (checked before writing
  side effects) since Sidekiq's at-least-once delivery can redeliver.

## Redis cache conventions:

- Use Rails' cache store (`Rails.cache`) for read-heavy, expensive-to-
  compute, or rarely-changing data (e.g. computed listing aggregates).
- Do not use the cache as a system of record — anything that must survive
  a cache flush belongs in MySQL or MongoDB (see `data-storage.md`).
- Explicit TTLs on every cache write; no un-expiring cache entries.
