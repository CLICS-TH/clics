# The CLICS backend image for vm1 (Topology B, docs/adr/0002-vm1-topology-b.md).
#
# WHY THIS FILE IS HERE AND NOT AT backend/Dockerfile: Railway builds the live backend with Railpack,
# and switches a service to a Dockerfile build as soon as one appears at the service root. ADR 0001
# records that hazard, and scripts/deploy/vm1.test.mjs fails if backend/Dockerfile ever exists.
# docker-compose.yml builds this with backend/ as the context. The ignore rules are in
# backend.Dockerfile.dockerignore beside this file (BuildKit reads <Dockerfile>.dockerignore before the
# context's own .dockerignore), so backend/ gains no .dockerignore either.
FROM node:22-slim

WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them. --omit=dev drops jest and
# supertest. The npm cache is removed because nothing at runtime may write to the filesystem anyway.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

ENV NODE_ENV=production
EXPOSE 3001

# Non-root. docker-compose.yml runs it as the host's dedicated `clics` uid instead; `node` (from the
# base image) is what a plain `docker run` of this image gets.
USER node

# The same command as backend/package.json "start". node directly, not `npm start`: npm writes logs
# under $HOME, which the read-only root filesystem refuses, and it would sit between docker's SIGTERM
# and the backend's own graceful-shutdown handler (backend/src/index.js:135-141).
CMD ["node", "src/index.js"]
