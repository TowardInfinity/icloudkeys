// Builds the unpacked MV3 extension into dist/. Content scripts can't be ES modules, so the
// content script is a separate IIFE build; the popup and service worker are ES modules.
import { cp, readFile, writeFile } from "node:fs/promises";
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
      input: { popup: here("./src/popup.html"), options: here("./src/options.html"), background: here("./src/background.ts") },
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

// runs in the page's world, so it's bundled on its own
await build({
  configFile: false,
  logLevel: "warn",
  build: {
    outDir,
    emptyOutDir: false,
    target: "chrome120",
    lib: { entry: here("./src/passkeys.ts"), formats: ["iife"], name: "icloudkeysPasskeys", fileName: () => "passkeys.js" },
  },
});

await cp(here("./icons"), here("./dist/icons"), { recursive: true });
const icons = Object.fromEntries([16, 32, 48, 128].map((n) => [n, `icons/icon-${n}.png`]));

const manifest = {
  manifest_version: 3,
  name: NAME,
  version: pkg.version ?? "0.1.0",
  description: "Apple Passwords (iCloud Keychain) for Chromium browsers on macOS. Not affiliated with Apple.",
  key,
  background: { service_worker: "background.js", type: "module" },
  icons,
  action: { default_popup: "popup.html", default_title: NAME, default_icon: icons },
  options_ui: { page: "options.html", open_in_tab: false },
  content_scripts: [
    { matches: ["http://*/*", "https://*/*"], js: ["content.js"], run_at: "document_idle", all_frames: true },
  ],
  // header rewrites for Hide My Email; scoped to our own requests in packages/hme/src/dnr.ts
  permissions: ["nativeMessaging", "declarativeNetRequestWithHostAccess", "storage", "scripting"],
  // asked for only when the user turns the browser's AutoFill off in settings
  optional_permissions: ["privacy"],
  host_permissions: ["http://*/*", "https://*/*"],
};
await writeFile(here("./dist/manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`built ${NAME} into ${outDir}`);
