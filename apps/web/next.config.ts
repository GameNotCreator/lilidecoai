import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  transpilePackages: [
    "@lili/analytics",
    "@lili/geometry",
    "@lili/types",
    "@lili/ui",
  ],
  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: "http", hostname: "127.0.0.1", port: "8000" },
      { protocol: "http", hostname: "localhost", port: "8000" },
    ],
  },
  poweredByHeader: false,
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
};

export default nextConfig;
