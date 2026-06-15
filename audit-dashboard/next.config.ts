import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Pin the workspace root to THIS directory. The repo root now also has a package-lock.json (for the
  // one-command `npm run dev` dev stack), so without this Next detects multiple lockfiles and infers the
  // repo root — which mis-resolves modules under Turbopack dev and over-traces the serverless output.
  turbopack: { root: path.join(__dirname) },
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
