# CLICS license-verifier — runs Chromium via Playwright, so we build on the
# official Playwright image (Chromium + all system deps preinstalled). This keeps
# the heavy browser stack OFF the main API host; the backend only ever talks to
# this service over internal HTTP.
#
# Pin to a Playwright image tag whose Chromium matches the `playwright` npm
# version in package.json. Bump BOTH together when upgrading.
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

ENV NODE_ENV=production \
    PORT=3004

WORKDIR /app

# Install deps first for layer caching. Use npm ci against the committed
# lockfile for reproducible builds (run `npm install` once locally to generate
# package-lock.json before the first image build).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Browsers ship with the base image; skip the post-install download.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# App source.
COPY src ./src

EXPOSE 3004

# Run as the non-root user that ships with the Playwright image.
USER pwuser

CMD ["node", "src/index.js"]
