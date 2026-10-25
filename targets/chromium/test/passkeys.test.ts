// The page-world script behind "Hide Browser Passkey Suggestions", run in Chromium, and the
// registration that puts it in pages.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setPasskeyHiding } from "../src/settings.ts";

const SCRIPT = fileURLToPath(new URL("../dist/passkeys.js", import.meta.url));

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

async function open(): Promise<Page> {
  const page = await browser.newPage();
  // the page's real get is recorded, to see which requests reach the browser
  await page.addInitScript(() => {
    (window as any).__asked = [];
    navigator.credentials.get = async (o) => {
      (window as any).__asked.push(o?.mediation ?? "optional");
      return null;
    };
  });
  await page.addInitScript({ content: await readFile(SCRIPT, "utf8") });
  // a secure context, where WebAuthn exists
  await page.route("https://site.test/", (r) => r.fulfill({ contentType: "text/html", body: "<p>site</p>" }));
  await page.goto("https://site.test/");
  return page;
}

describe("passkey suggestions hidden", () => {
  it("tells the page passkey autofill is unavailable", async () => {
    const page = await open();
    expect(await page.evaluate(() => PublicKeyCredential.isConditionalMediationAvailable())).toBe(false);
    const caps = await page.evaluate(async () => (PublicKeyCredential as any).getClientCapabilities?.());
    if (caps) expect(caps.conditionalGet).toBe(false);
    await page.close();
  });

  it("holds a conditional request until the page aborts it, and passes others through", async () => {
    const page = await open();
    const outcome = await page.evaluate(async () => {
      const ctl = new AbortController();
      const pending = navigator.credentials.get({ mediation: "conditional", signal: ctl.signal } as CredentialRequestOptions);
      const early = await Promise.race([pending.then(() => "settled", () => "settled"), new Promise((r) => setTimeout(() => r("pending"), 200))]);
      ctl.abort();
      const aborted = await pending.then(() => "resolved", (e) => e.name);
      await navigator.credentials.get({ mediation: "required" } as CredentialRequestOptions);
      return { early, aborted, asked: (window as any).__asked };
    });
    expect(outcome).toEqual({ early: "pending", aborted: "AbortError", asked: ["required"] });
    await page.close();
  });
});

describe("setPasskeyHiding", () => {
  it("registers the script once when on, and removes it when off", async () => {
    const ids = new Set<string>();
    const calls: string[] = [];
    (globalThis as any).chrome = {
      scripting: {
        getRegisteredContentScripts: async ({ ids: want }: { ids: string[] }) => want.filter((i) => ids.has(i)).map((id) => ({ id })),
        registerContentScripts: async (s: { id: string; world: string; runAt: string }[]) => {
          for (const x of s) ids.add(x.id);
          calls.push(`register ${s[0]!.world} ${s[0]!.runAt}`);
        },
        unregisterContentScripts: async ({ ids: gone }: { ids: string[] }) => {
          for (const i of gone) ids.delete(i);
          calls.push("unregister");
        },
      },
    };
    await setPasskeyHiding(true);
    await setPasskeyHiding(true);
    await setPasskeyHiding(false);
    await setPasskeyHiding(false);
    expect(calls).toEqual(["register MAIN document_start", "unregister"]);
  });
});
