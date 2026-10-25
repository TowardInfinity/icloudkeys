// Runs the built content script in plain pages with a stubbed `chrome`, to check what the page
// can and can't make it do: the dropdown acts only on trusted input, saves are captured on
// submit, and fills from anything but our background are refused.

import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CONTENT = fileURLToPath(new URL("../dist/content.js", import.meta.url));

const PAGES: Record<string, string> = {
  "/login": `<form action="/done" onsubmit="event.preventDefault()">
      <input id="user" name="username" autocomplete="username">
      <input id="pw" type="password" name="password" autocomplete="current-password">
      <button id="go" type="submit">Sign in</button></form>`,
  "/signup": `<form onsubmit="event.preventDefault()">
      <input id="email" type="email" name="email" autocomplete="email">
      <input id="pw" type="password" name="new" autocomplete="new-password">
      <input id="pw2" type="password" name="confirm" autocomplete="new-password">
      <button id="go" type="submit">Create account</button></form>`,
  "/checkout": `<form onsubmit="event.preventDefault()">
      <input id="email" type="email" name="email" autocomplete="email">
      <input name="address" autocomplete="street-address"><input name="zip" autocomplete="postal-code">
      <button type="submit">Place order</button></form>`,
  "/formless": `<div><input id="user" autocomplete="username"><input id="pw" type="password" autocomplete="current-password">
      <button id="go" type="button">Continue</button></div>`,
  "/otp": `<form onsubmit="event.preventDefault()"><input id="code" autocomplete="one-time-code" inputmode="numeric"></form>`,
};

// The stub answers the content script's requests and records them; `deliver` plays the
// background sending a fill down to the page.
const STUB = `(() => {
  const listeners = [];
  window.__sent = [];
  window.__reply = { status: { state: "unlocked", hasChallenge: false, canFillCodes: true, canOpenNewPassword: false, canHideEmail: true } };
  globalThis.chrome = { runtime: {
    id: "ext",
    sendMessage: async (msg) => {
      window.__sent.push(msg);
      // logins ride along on every reply, so only the content script's own gating keeps them off a field
      const base = { ok: true, ...window.__reply, logins: [{ username: "alice", sites: [] }] };
      if (msg.type === "inlineCodes") return { ...base, codes: [{ id: 0, source: "sms", username: "", domain: location.hostname }] };
      if (msg.type === "hmeCreate") return { ...base, address: "x7@icloud.com" };
      return base;
    },
    onMessage: { addListener: (fn) => listeners.push(fn) },
  } };
  window.__deliver = (msg, sender) => new Promise((r) => { for (const fn of listeners) fn(msg, sender, r); });
})();`;

let server: Server;
let base: string;
let browser: Browser;

beforeAll(async () => {
  const script = await readFile(CONTENT, "utf8");
  server = createServer((req, res) => {
    const body = PAGES[req.url ?? ""] ?? "";
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><body>${body}<script>${STUB}</script><script>${script}</script>`);
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

async function open(path: string): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(base + path);
  return page;
}

const sent = (page: Page) => page.evaluate(() => (window as any).__sent as { type: string; [k: string]: unknown }[]);
const dropdownShown = (page: Page) => page.evaluate(() => !!document.querySelector("icloudkeys-suggestions"));

describe("dropdown", () => {
  it("offers logins on focus and fills the picked one by keyboard", async () => {
    const page = await open("/login");
    await page.click("#pw");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    expect((await sent(page)).filter((m) => m.type === "inlineFill")).toEqual([{ type: "inlineFill", username: "alice" }]);
    expect(await dropdownShown(page)).toBe(false);
    await page.close();
  });

  it("ignores keys a page script synthesizes", async () => {
    const page = await open("/login");
    await page.click("#pw");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.evaluate(() => {
      const pw = document.querySelector("#pw")!;
      for (const key of ["ArrowDown", "Enter"]) pw.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
    expect((await sent(page)).some((m) => m.type === "inlineFill")).toBe(false);
    await page.close();
  });

  it("offers to unlock while locked, without listing anything", async () => {
    const page = await open("/login");
    await page.evaluate(() => ((window as any).__reply.status.state = "needs_pin"));
    await page.click("#user");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    expect((await sent(page)).map((m) => m.type)).toContain("openPopup");
    expect((await sent(page)).some((m) => m.type === "inlineFill")).toBe(false);
    await page.close();
  });

  it("generates a password into both new-password fields and saves it on submit", async () => {
    const page = await open("/signup");
    await page.fill("#email", "me@example.com");
    await page.click("#pw");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const [a, b] = await page.evaluate(() => ["#pw", "#pw2"].map((s) => (document.querySelector(s) as HTMLInputElement).value));
    expect(a).toMatch(/^[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}$/);
    expect(b).toBe(a);
    await page.click("#go");
    const saves = (await sent(page)).filter((m) => m.type === "offerSave");
    expect(saves).toEqual([{ type: "offerSave", username: "me@example.com", password: a, isNew: true }]);
    await page.close();
  });

  it("offers a Hide My Email address on a sign-up email field", async () => {
    const page = await open("/signup");
    await page.click("#email");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.inputValue("#email")).toBe("x7@icloud.com");
    await page.close();
  });

  it("says to sign in to iCloud.com instead of hiding the alias row", async () => {
    const page = await open("/signup");
    await page.evaluate(() => {
      const w = window as any;
      Object.assign(w.__reply.status, { canHideEmail: false, hmeNeedsSignIn: true });
      w.__opened = [];
      w.open = (url: string) => void w.__opened.push(url);
    });
    await page.click("#email");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => (window as any).__opened)).toEqual(["https://www.icloud.com/"]);
    expect((await sent(page)).map((m) => m.type)).not.toContain("hmeCreate");
    expect(await page.inputValue("#email")).toBe("");
    await page.close();
  });

  it("lists codes on a one-time-code field and picks by id", async () => {
    const page = await open("/otp");
    await page.click("#code");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    expect((await sent(page)).filter((m) => m.type === "inlineFillCode")).toEqual([{ type: "inlineFillCode", id: 0 }]);
    await page.close();
  });
});

describe("not a login", () => {
  it("never offers a login on a checkout email field", async () => {
    const page = await open("/checkout");
    await page.click("#email");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.click("#email");
    }
    const types = (await sent(page)).map((m) => m.type);
    expect(types).not.toContain("inlineFill");
    expect(types).not.toContain("inlineLogins");
    await page.close();
  });

  it("offers no alias without an iCloud+ session", async () => {
    const page = await open("/checkout");
    await page.evaluate(() => ((window as any).__reply.status.canHideEmail = false));
    await page.click("#email");
    await page.waitForTimeout(200);
    expect(await dropdownShown(page)).toBe(false);
    await page.close();
  });

  it("offers no generated password while locked, since it couldn't be saved", async () => {
    const page = await open("/signup");
    await page.evaluate(() => ((window as any).__reply.status.state = "needs_pin"));
    await page.click("#pw");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.click("#pw");
    }
    expect(await page.inputValue("#pw")).toBe("");
    await page.close();
  });
});

describe("saving", () => {
  it("offers a formless login submitted with Enter while the dropdown is open", async () => {
    const page = await open("/formless");
    await page.fill("#user", "carol");
    await page.click("#pw");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.keyboard.type("typed");
    await page.keyboard.press("Enter");
    expect((await sent(page)).filter((m) => m.type === "offerSave")).toEqual([
      { type: "offerSave", username: "carol", password: "typed", isNew: false },
    ]);
    await page.close();
  });

  it("offers a typed login once per submit burst", async () => {
    const page = await open("/login");
    await page.fill("#user", "bob");
    await page.fill("#pw", "typed-pw");
    await page.keyboard.press("Escape");
    await page.click("#go");
    await page.press("#pw", "Enter");
    expect((await sent(page)).filter((m) => m.type === "offerSave")).toEqual([
      { type: "offerSave", username: "bob", password: "typed-pw", isNew: false },
    ]);
    await page.close();
  });

  it("doesn't offer a login it just filled", async () => {
    const page = await open("/login");
    await page.click("#pw");
    const res = await page.evaluate(() =>
      (window as any).__deliver({ type: "fill", expectedHost: "127.0.0.1", username: "alice", password: "hunter2" }, { id: "ext" }),
    );
    expect(res).toEqual({ filled: true });
    await page.click("#go");
    expect((await sent(page)).some((m) => m.type === "offerSave")).toBe(false);
    await page.close();
  });
});

describe("fills from outside", () => {
  it("refuses a fill from another extension or a tab", async () => {
    const page = await open("/login");
    const msg = { type: "fill", expectedHost: "127.0.0.1", username: "a", password: "b" };
    const results = await page.evaluate(
      (msg) => Promise.all([(window as any).__deliver(msg, { id: "other" }), (window as any).__deliver(msg, { id: "ext", tab: { id: 1 } })]),
      msg,
    );
    expect(results).toEqual([
      { filled: false, error: "forbidden" },
      { filled: false, error: "forbidden" },
    ]);
    expect(await page.inputValue("#pw")).toBe("");
    await page.close();
  });

  it("fills a code into the focused field", async () => {
    const page = await open("/otp");
    await page.click("#code");
    const res = await page.evaluate(() => (window as any).__deliver({ type: "fillCode", expectedHost: "127.0.0.1", code: "123456" }, { id: "ext" }));
    expect(res).toEqual({ filled: true });
    expect(await page.inputValue("#code")).toBe("123456");
    await page.close();
  });
});
