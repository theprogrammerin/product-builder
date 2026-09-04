# Be sure to restart your server when you modify this file.

# The frontend always runs on a different, dynamically-allocated origin
# than this backend (see ../../../../guidelines/component-networking.md)
# — CORS is required, not optional. FRONTEND_ORIGIN is set by the Run
# Agent at `docker compose up -d` time (from that run's actual allocated
# frontend port); it's absent during `docker compose run --rm` build/
# verify commands, so this falls back to "*" rather than failing then.
#
# Read more: https://github.com/cyu/rack-cors

Rails.application.config.middleware.insert_before 0, Rack::Cors do
  allow do
    origins ENV.fetch("FRONTEND_ORIGIN", "*")

    resource "*",
      headers: :any,
      methods: [:get, :post, :put, :patch, :delete, :options, :head]
  end
end
