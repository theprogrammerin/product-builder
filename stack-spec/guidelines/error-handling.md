# Error Handling

## Backend (Rails)

Single mapping, defined once in `ApplicationController`, from exception
class to `(http_status, error.code)`:

| Exception                          | HTTP status | `error.code`        |
|-------------------------------------|-------------|----------------------|
| `ActiveRecord::RecordNotFound`      | 404         | `not_found`          |
| `ActiveRecord::RecordInvalid`       | 422         | `validation_failed`  |
| `Pundit::NotAuthorizedError`        | 403         | `forbidden`          |
| `ActionController::ParameterMissing`| 400         | `bad_request`        |
| JWT decode/expiry errors            | 401         | `unauthorized`       |
| anything else (unexpected)          | 500         | `internal_error`     |

- Unexpected (500) errors are logged with full backtrace server-side but
  never leak internals (message, backtrace, SQL) to the client response.
- Validation errors (`422`) include per-field messages in `error.details`
  so the frontend can highlight the right form field.

## Frontend

- The API client's single interceptor turns a non-2xx response into a
  typed `ApiError` (status, code, message, details) — screens never parse
  raw response bodies themselves.
- `401` from any request triggers the shared "session expired" flow (clear
  auth store, redirect to sign-in) in one place, not per-screen.
- User-facing error messages come from `error.message`/`error.details`
  when present (validation errors), otherwise a generic fallback per
  error code — never show a raw exception string to the user.

## Background jobs

- Sidekiq's built-in retry (default backoff) handles transient failures.
- A job that fails permanently (exhausts retries) must leave the system in
  a safe, inspectable state — e.g. flip the related record to a `failed`
  status — not just disappear into Sidekiq's dead set silently.
