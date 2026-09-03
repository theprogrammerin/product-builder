FROM node:20-slim

WORKDIR /app
COPY . .

# node_modules (installed by `npm install`, run by the Codegen Agent,
# since dependencies aren't final at scaffold time) land in the
# frontend_node_modules volume mounted in docker-compose.yml, not this
# image layer — so they persist across the ephemeral containers
# `docker compose run --rm` creates. Same lesson as backend/Dockerfile.

CMD ["npx", "expo", "start", "--web"]
