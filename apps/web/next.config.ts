import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  serverExternalPackages: ["mongodb", "sharp"],
  transpilePackages: [
    "@lili/analytics",
    "@lili/geometry",
    "@lili/types",
    "@lili/ui",
  ],
  images: {
    unoptimized: true,
  },
  poweredByHeader: false,
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
};

export default nextConfig;
