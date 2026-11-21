import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { STOREFRONT_VISUALIZATION_PAUSED: "false" },
    exclude: [
      ...configDefaults.exclude,
      "tests/__scratch/**",
      "tests/zz-*.test.ts",
    ],
  },
});
