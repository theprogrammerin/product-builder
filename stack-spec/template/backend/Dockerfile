FROM ruby:3.3-slim

# System build deps for native gem extensions (mysql2, etc.) — baked into
# the image at build time, not something the Codegen Agent installs via
# run_command: `docker compose run --rm` gives every command a fresh
# ephemeral container, so anything installed ad hoc there is lost before
# the next command runs. This apt layer is the one thing here that must
# be baked in rather than left for the agent to (re)discover.
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
      build-essential \
      pkg-config \
      default-libmysqlclient-dev \
      git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# Gems installed by `bundle install` (run by the Codegen Agent, since the
# Gemfile isn't final at scaffold time) land in the bundle_cache volume
# mounted in docker-compose.yml, not this image layer — so they persist
# across the ephemeral containers `docker compose run --rm` creates.

CMD ["bin/rails", "server", "-b", "0.0.0.0"]
