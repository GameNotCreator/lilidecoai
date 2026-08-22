import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

/**
 * Next reads .env from the application directory, so the monorepo-root .env the
 * README asks for was silently ignored. Load it here, without ever overriding a
 * value the platform already provides — on Vercel the file is absent and the
 * dashboard variables win.
 */
function loadRepositoryRootEnv(): void {
  const appDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = join(appDirectory, "..", "..");
  for (const name of [".env", ".env.local"]) {
    let contents: string;
    try {
      contents = readFileSync(join(repositoryRoot, name), "utf8");
    } catch {
      continue;
    }
    for (const line of contents.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
        line,
      );
      if (!match) continue;
      const [, key, rawValue = ""] = match;
      if (!key || process.env[key] !== undefined) continue;
      const value = rawValue.trim();
      const unquoted =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
          ? value.slice(1, -1)
          : value.replace(/\s+#.*$/, "").trim();
      if (unquoted) process.env[key] = unquoted;
    }
  }
}

loadRepositoryRootEnv();

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  // The monorepo hoists sharp and mongodb into the repository-root
  // node_modules; without this, Vercel's file tracing never leaves apps/web
  // and the deployed function is missing sharp's native linux binaries.
  outputFileTracingRoot: join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  ),
  // sharp selects its platform binary with a computed require the static
  // tracer cannot follow, so the linux binaries must be included by hand.
  outputFileTracingIncludes: {
    "/**/*": [
      "../../node_modules/@img/**/*",
      "../../node_modules/sharp/**/*",
      "./node_modules/@img/**/*",
      "./node_modules/sharp/**/*",
    ],
  },
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
