import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./mock-obsidian.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: true,
  },
});
