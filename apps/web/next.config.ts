import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@retail/core", "@retail/db", "@retail/i18n", "@retail/ui"],
};

export default nextConfig;
