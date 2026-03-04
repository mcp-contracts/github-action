import { defineConfig } from "tsup";

// biome-ignore lint/style/noDefaultExport: tsup requires default export
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  target: "node20",
  clean: true,
  sourcemap: true,
  noExternal: [/.*/],
});
