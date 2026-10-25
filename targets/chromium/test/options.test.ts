// Runs the built settings page with a stubbed `chrome` that records storage writes and
// browser-setting changes.

import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));

// `__grant` answers the permission prompt; a service left out of `__services` is one the browser lacks
const STUB = `(() => {
  window.__log = [];
  window.__stored = {};
  window.__grant = true;
  window.__granted = false;
  const setting = (name) => ({
    set: async (d) => void window.__log.push(["set", name, d.value]),
    clear: async () => void window.__log.push(["clear", name]),
  });
  const services = {};
  for (const n of ["passwordSavingEnabled", "autofillAddressEnabled", "autofillCreditCardEnabled"]) services[n] = setting(n);
  globalThis.chrome = {
    storage: { local: {
      get: async () => ({ ...window.__stored }),
      set: async (patch) => { Object.assign(window.__stored, patch); window.__log.push(["save", patch]); },
    } },
    permissions: {
      request: async () => (window.__granted = window.__grant),
      contains: async () => window.__granted,
    },
    privacy: { services },
  };
  window.__dropService = (n) => delete services[n];
})();`;

let server: Server;
let base: string;
let browser: Browser;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = (req.url ?? "/").slice(1);
    const body = await readFile(DIST + path).catch(() => null);
    if (!body) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": path.endsWith(".js") ? "text/javascript" : "text/html" }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  server?.close();
});

async function open(stored: Record<string, unknown> = {}): Promise<Page> {
  const page = await browser.newPage();
  await page.addInitScript(STUB);
  await page.addInitScript((s) => Object.assign((window as any).__stored, s), stored);
  await page.goto(`${base}/options.html`);
  await page.waitForFunction(() => document.title.endsWith("Settings") && document.title !== "Settings");
  return page;
}

const log = (page: Page) => page.evaluate(() => (window as any).__log as unknown[][]);
const SERVICES = ["passwordSavingEnabled", "autofillAddressEnabled", "autofillCreditCardEnabled"];

describe("settings page", () => {
  it("shows stored settings over the defaults", async () => {
    const page = await open({ keyButton: false, junk: 1 });
    expect(await page.isChecked("#inPageAutoFill")).toBe(true);
    expect(await page.isChecked("#keyButton")).toBe(false);
    expect(await page.isChecked("#browserAutoFillOff")).toBe(false);
    await page.close();
  });

  it("saves In-Page AutoFill and greys out the key button with it", async () => {
    const page = await open();
    await page.uncheck("#inPageAutoFill");
    expect(await page.isDisabled("#keyButton")).toBe(true);
    await expect.poll(() => log(page)).toEqual([["save", { inPageAutoFill: false }]]);
    await page.close();
  });

  it("saves Hide Browser Passkey Suggestions, off by default", async () => {
    const page = await open();
    expect(await page.isChecked("#hideBrowserPasskeys")).toBe(false);
    await page.check("#hideBrowserPasskeys");
    await expect.poll(() => log(page)).toEqual([["save", { hideBrowserPasskeys: true }]]);
    await page.close();
  });

  it("leaves the browser's AutoFill alone when the permission is refused", async () => {
    const page = await open();
    await page.evaluate(() => ((window as any).__grant = false));
    await page.click("#browserAutoFillOff");
    await expect.poll(() => page.isChecked("#browserAutoFillOff")).toBe(false);
    expect(await log(page)).toEqual([]);
    await page.close();
  });

  it("turns the browser's AutoFill off, then hands it back", async () => {
    const page = await open();
    await page.click("#browserAutoFillOff");
    await expect.poll(() => log(page)).toEqual([
      ...SERVICES.map((n) => ["set", n, false]),
      ["save", { browserAutoFillOff: true }],
    ]);
    await page.click("#browserAutoFillOff");
    await expect.poll(async () => (await log(page)).slice(4)).toEqual([
      ...SERVICES.map((n) => ["clear", n]),
      ["save", { browserAutoFillOff: false }],
    ]);
    await page.close();
  });

  it("skips a service the browser doesn't have", async () => {
    const page = await open();
    await page.evaluate(() => (window as any).__dropService("autofillCreditCardEnabled"));
    await page.click("#browserAutoFillOff");
    await expect.poll(() => log(page)).toEqual([
      ["set", "passwordSavingEnabled", false],
      ["set", "autofillAddressEnabled", false],
      ["save", { browserAutoFillOff: true }],
    ]);
    await page.close();
  });
});
