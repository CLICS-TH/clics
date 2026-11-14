import type { NextConfig } from "next";
import path from "path";
import { BASE_PATH } from "./lib/base-path";

const nextConfig: NextConfig = {
  basePath: BASE_PATH,
  // vm1 runs the dashboard as `node server.js` from the standalone bundle (deploy/vm1/dashboard.Dockerfile).
  output: 'standalone',
  // The image optimizer writes a cache under .next/, and the vm1 container's root is read-only.
  images: { unoptimized: true },
  // Pin the workspace root to THIS directory. The repo root now also has a package-lock.json (for the
  // one-command `npm run dev` dev stack), so without this Next detects multiple lockfiles and infers the
  // repo root — which mis-resolves modules under Turbopack dev and over-traces the serverless output.
  turbopack: { root: path.join(__dirname) },
  outputFileTracingRoot: path.join(__dirname),

  // The CLE -> PLE rename moved three staff routes. Admins and auditors bookmark their queue, so
  // keep the old paths working rather than answering 404 the moment this deploys. Temporary (307)
  // on purpose: a permanent redirect is cached in the browser and cannot be withdrawn.
  async redirects() {
    return [
      { source: '/admin/cles', destination: '/admin/ples', permanent: false },
      { source: '/admin/cles/:id', destination: '/admin/ples/:id', permanent: false },
      { source: '/auditor/cles/:id', destination: '/auditor/ples/:id', permanent: false },
    ];
  },
};

export default nextConfig;
