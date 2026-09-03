import { defineConfig } from "tsdown";

// biome-ignore lint/style/noDefaultExport: tsdown requires default export
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  dts: false,
  target: "node20",
  clean: true,
  sourcemap: true,
  fixedExtension: false,
  noExternal: [/.*/],
});
