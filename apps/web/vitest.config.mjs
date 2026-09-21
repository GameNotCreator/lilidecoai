import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      "tests/__scratch/**",
      "tests/zz-*.test.ts",
    ],
  },
});
