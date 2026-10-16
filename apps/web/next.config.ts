import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@retail/core", "@retail/db", "@retail/i18n", "@retail/ui"],
};

export default createNextIntlPlugin("./i18n/request.ts")(nextConfig);
