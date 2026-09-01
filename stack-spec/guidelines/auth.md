# Authentication & Authorization

Fixed pattern for every generated app — do not substitute a different auth
gem or a hand-rolled scheme.

## Authentication

- **Devise + devise-jwt**, Rails app in API-only mode.
- Every generated app gets: `POST /auth/sign_up`, `POST /auth/sign_in`,
  `DELETE /auth/sign_out` (token revocation), and a JWT returned in the
  `Authorization` header on sign-in.
- Tokens are short-lived (default: 24h) with revocation via
  `devise-jwt`'s denylist strategy backed by the MySQL `User` table (not
  Redis — token revocation must survive a cache flush).
- Password reset / email confirmation: include Devise's modules for these
  only if the build spec's workflows call for them; don't add unused
  Devise modules by default.

## Authorization (roles from the build spec)

- Roles from the build spec (e.g. `renter`, `owner`, `admin`) become a
  `role` enum column on `User`, not a separate roles table, unless the
  spec explicitly describes users holding multiple simultaneous roles —
  in that case use a join table (`user_roles`).
- Use **Pundit** for authorization policies, one policy class per
  MySQL-backed resource that needs access control. Do not scatter
  `current_user.role == :admin` checks directly in controllers.

## Frontend

- Store the JWT in secure storage appropriate to platform (Expo
  SecureStore on native, encrypted storage abstraction on web — the
  frontend's `auth` module wraps this so screens never touch storage
  directly).
- Attach the token as `Authorization: Bearer <token>` via a single API
  client interceptor, not per-request.
