# The audit-dashboard image for vm1, served at /audit on clics.ccme.or.th (#429).
#
# Not audit-dashboard/Dockerfile: that one is the Vercel-era image, and this one bakes in the vm1 build
# settings below. docker-compose.yml builds it with audit-dashboard/ as the context; the ignore rules are
# in dashboard.Dockerfile.dockerignore beside this file, as for backend.Dockerfile.
FROM node:22-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Next inlines NEXT_PUBLIC_* into the bundle at build time. The API and the Portal share the dashboard's
# origin, so both are same-origin paths; the dashboard's own /reset page stays unconfigured unless the
# Supabase values are passed as build args.
ARG NEXT_PUBLIC_SUPABASE_URL=
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_API_URL=/api \
    NEXT_PUBLIC_PORTAL_URL= \
    NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
RUN npm run build

FROM node:22-slim

WORKDIR /app
# The standalone bundle carries only the modules the server traced; static assets are copied beside it,
# as Next's standalone output expects.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
EXPOSE 3000

# Non-root; docker-compose.yml runs it as the host's clics uid instead.
USER node
CMD ["node", "server.js"]
