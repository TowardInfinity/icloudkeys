// Builds the unpacked MV3 extension into dist/. Content scripts can't be ES modules, so the
// content script is a separate IIFE build; the popup and service worker are ES modules.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const outDir = here("./dist");
const pkg = JSON.parse(await readFile(here("../../package.json"), "utf8"));
const { NAME } = await import("./src/name.ts");
// Apple's public key: Apple's helper only accepts the extension ID it produces
const key = (await readFile(here("./apple-key.txt"), "utf8")).trim();

await build({
  root: here("./src"),
  base: "./",
  logLevel: "warn",
  build: {
    outDir,
    emptyOutDir: true,
    target: "chrome120",
    rollupOptions: {
      input: { popup: here("./src/popup.html"), background: here("./src/background.ts") },
      output: { entryFileNames: "[name].js", chunkFileNames: "[name].js", assetFileNames: "[name][extname]" },
    },
  },
});

await build({
  configFile: false,
  logLevel: "warn",
  build: {
    outDir,
    emptyOutDir: false,
    target: "chrome120",
    lib: { entry: here("./src/content.ts"), formats: ["iife"], name: "icloudkeysContent", fileName: () => "content.js" },
  },
});

const manifest = {
  manifest_version: 3,
  name: NAME,
  version: pkg.version ?? "0.1.0",
  description: "Apple Passwords (iCloud Keychain) for Chromium browsers on macOS. Not affiliated with Apple.",
  key,
  background: { service_worker: "background.js", type: "module" },
  action: { default_popup: "popup.html", default_title: NAME },
  content_scripts: [{ matches: ["http://*/*", "https://*/*"], js: ["content.js"], run_at: "document_idle" }],
  permissions: ["nativeMessaging"],
  host_permissions: ["http://*/*", "https://*/*"],
};
await writeFile(here("./dist/manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`built ${NAME} into ${outDir}`);
