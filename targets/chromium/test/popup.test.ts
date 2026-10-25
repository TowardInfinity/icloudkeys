// Runs the built popup with a stubbed `chrome`, the way the toolbar opens it.

import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));

const STUB = `(() => {
  window.__sent = [];
  const status = (state) => ({ state, hasChallenge: state === "needs_pin", canFillCodes: false, canOpenNewPassword: false, canHideEmail: false, hmeNeedsSignIn: false });
  globalThis.chrome = { runtime: { sendMessage: async (msg) => {
    window.__sent.push(msg);
    if (msg.type === "verify") return { ok: true, status: status("unlocked") };
    return { ok: true, status: status(window.__sent.some((m) => m.type === "verify") ? "unlocked" : "needs_pin"), logins: [] };
  } } };
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

async function open(): Promise<Page> {
  const page = await browser.newPage();
  await page.addInitScript(STUB);
  await page.goto(`${base}/popup.html`);
  await page.waitForSelector("#pin-form:not([hidden])");
  return page;
}

const verifies = (page: Page) =>
  page.evaluate(() => ((window as any).__sent as { type: string }[]).filter((m) => m.type === "verify"));

describe("pairing code", () => {
  it("has no Unlock button; the sixth digit is the submit", async () => {
    const page = await open();
    expect(await page.locator("#pin-form button").count()).toBe(0);
    await page.close();
  });

  it("submits on the sixth digit", async () => {
    const page = await open();
    await page.locator("#pin").pressSequentially("12345");
    expect(await verifies(page)).toEqual([]);
    await page.locator("#pin").pressSequentially("6");
    await expect.poll(() => verifies(page)).toEqual([{ type: "verify", pin: "123456" }]);
    await page.close();
  });

  it("submits a pasted code once", async () => {
    const page = await open();
    await page.locator("#pin").fill("654321");
    await expect.poll(() => verifies(page)).toEqual([{ type: "verify", pin: "654321" }]);
    await page.waitForTimeout(200);
    expect(await verifies(page)).toHaveLength(1);
    await page.close();
  });
});
