# Component Blueprint: `backend/`

## Purpose

Rails API for this app. Currently a structural skeleton only — see
[`../../../README.md`](../../../README.md).

## Key files

- [`Gemfile`](../../../backend/Gemfile) — locked gems (not yet bundled)
- [`config/database.yml`](../../../backend/config/database.yml) — MySQL
- [`config/mongoid.yml`](../../../backend/config/mongoid.yml) — MongoDB
- `app/{models,controllers,serializers,jobs}/` — empty, ready for content

## Known limitations

- Not `bundle install`ed — this is a skeleton, not a working Rails app.
- No models, controllers, migrations, or tests yet.
