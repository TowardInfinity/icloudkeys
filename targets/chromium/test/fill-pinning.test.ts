// Loads the built extension in Chromium and drives the content script's fill handler the way
// the service worker does, to prove a credential only lands on the host it was pinned to.

import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Worker } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";

const EXT = fileURLToPath(new URL("../dist", import.meta.url));
const PAGE = fileURLToPath(new URL("../../../packages/classifier/test/fixtures/login-standard.html", import.meta.url));

let server: Server;
let url: string;
let profile: string;
let ctx: BrowserContext;
let sw: Worker;

beforeAll(async () => {
  const html = await readFile(PAGE);
  server = createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end(html));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/login`;
  profile = await mkdtemp(join(tmpdir(), "icloudkeys-e2e-"));
  ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new", "--no-first-run"],
  });
  sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
});

afterAll(async () => {
  await ctx?.close();
  server?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

async function fillFromWorker(expectedHost: string) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load" });
  await page.focus("#password");
  const res = await sw.evaluate(
    async ({ target, expectedHost }) => {
      const [tab] = await chrome.tabs.query({ url: target });
      // a slow machine can reach here before the content script is listening
      for (let waited = 0; ; waited += 100) {
        try {
          return await chrome.tabs.sendMessage(
            tab!.id!,
            { type: "fill", expectedHost, username: "alice", password: "s3cret" },
            { frameId: 0 },
          );
        } catch (e) {
          if (waited >= 15_000 || !String(e).includes("Receiving end does not exist")) throw e;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    },
    { target: url, expectedHost },
  );
  const values = await page.evaluate(() => [
    (document.querySelector("#username") as HTMLInputElement).value,
    (document.querySelector("#password") as HTMLInputElement).value,
  ]);
  await page.close();
  return { res, values };
}

it("extension ID is Apple's, which the helper requires", () => {
  expect(new URL(sw.url()).host).toBe("pejdijmoenmkgeppbflobdenhhabjlaj");
});

it("refuses a credential pinned to another host", async () => {
  const { res, values } = await fillFromWorker("evil.test");
  expect(res).toEqual({ filled: false, error: "page changed origin" });
  expect(values).toEqual(["", ""]);
}, 30_000);

it("fills a credential pinned to this host", async () => {
  const { res, values } = await fillFromWorker("127.0.0.1");
  expect(res).toEqual({ filled: true });
  expect(values).toEqual(["alice", "s3cret"]);
}, 30_000);

it("installs the Hide My Email header rules scoped to itself", async () => {
  const rules = await sw.evaluate(async () => {
    // registered from top-level worker code; give it a moment on a cold start
    for (let i = 0; i < 20; i++) {
      const r = await chrome.declarativeNetRequest.getSessionRules();
      if (r.length) return r;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    return [];
  });
  expect(rules.map((r) => r.id).sort()).toEqual([1, 2]);
  for (const r of rules) {
    expect(r.condition.initiatorDomains).toEqual(["pejdijmoenmkgeppbflobdenhhabjlaj"]);
    expect(r.condition.tabIds).toEqual([-1]);
  }
});
