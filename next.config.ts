import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root so stray lockfiles in parent directories are ignored.
  turbopack: {
    root: import.meta.dirname,
  },
};

export default nextConfig;
