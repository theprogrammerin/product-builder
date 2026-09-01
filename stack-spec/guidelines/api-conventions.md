# API Conventions

## Structure

- REST resources under `/api/v1/...` — version in the URL path from day
  one, even for the first generated version, so a v2 never requires
  retrofitting versioning.
- One controller per resource, standard 7 RESTful actions where
  applicable; custom actions only when the build spec's workflow doesn't
  map to CRUD (e.g. `POST /api/v1/bookings/:id/cancel`).
- Nested routes only one level deep (`/api/v1/listings/:listing_id/photos`);
  anything deeper becomes its own top-level resource with a filter param.

## Serialization

- **Blueprinter** for all JSON responses — one blueprint class per model,
  under `app/blueprints/`. Controllers never build response hashes by hand.
- Every list endpoint is paginated (cursor or page-based, pick one and use
  it everywhere — page-based via `kaminari` is the default) — never return
  an unbounded array.

## Errors

- Consistent error envelope across every endpoint:
  `{ "error": { "code": "...", "message": "...", "details": {...} } }`.
- Map exceptions to HTTP status once, in an `ApplicationController` rescue
  block — individual controllers don't each implement their own error
  formatting.
- See `error-handling.md` for the exception → status/code mapping.

## Do not:

- Return ActiveRecord objects or raw `to_json` from controllers.
- Introduce GraphQL or a second API style — REST/JSON is the only
  interface, for both the mobile/web frontend and any future integration.
