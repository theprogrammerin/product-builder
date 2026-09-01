# Data Storage: MySQL vs MongoDB

Every entity in the build spec goes in exactly one of the two stores. Decide
per entity, not per app — a single app can and usually will use both.

## Put it in MySQL when:

- The entity has a fixed, well-known shape (columns known up front) and
  participates in relational integrity (foreign keys, joins) with other
  entities — e.g. `User`, `Order`, `Booking`, `Payment`.
- Strong consistency / transactions matter (money, inventory counts,
  anything where "read-then-write" races are unacceptable).
- The data is queried relationally (filter/sort/join across entities) more
  than it's queried as a whole document.

This is the default. If in doubt, use MySQL.

## Put it in MongoDB when:

- The shape is naturally variable or nested and forcing it into columns
  would mean either a wide sparse table or a maze of join tables — e.g.
  user-generated content with flexible fields, activity/event logs, audit
  trails, denormalized "feed" documents assembled for fast reads.
- It's high-write, append-mostly data that's read back mostly by ID or by
  a small set of indexed fields, not joined against other entities.
- Schema is expected to evolve per-tenant or per-feature without a
  migration each time.

## Do not:

- Split a single entity's fields across both stores.
- Use MongoDB as a cache — that's Redis's job (see `background-jobs.md`).
- Add a third datastore for a use case one of these two already covers.

## In code:

- MySQL-backed models: standard `ActiveRecord::Base` models, one migration
  per schema change.
- MongoDB-backed models: `Mongoid::Document` models (per
  `versions.yaml`'s ODM pin) — no raw driver calls in application code.
