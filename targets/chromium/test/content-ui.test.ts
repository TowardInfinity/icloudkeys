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
  "/two-logins": `<form onsubmit="event.preventDefault()">
      <input id="user1" name="username" autocomplete="username">
      <input id="pw1" type="password" name="password" autocomplete="current-password"></form>
    <form onsubmit="event.preventDefault()">
      <input id="user2" name="username" autocomplete="username">
      <input id="pw2" type="password" name="password" autocomplete="current-password"></form>`,
  "/login": `<form action="/done" onsubmit="event.preventDefault()">
      <input id="user" name="username" autocomplete="username">
      <input id="pw" type="password" name="password" autocomplete="current-password">
      <button id="go" type="submit">Sign in</button></form>`,
  "/signup": `<form onsubmit="event.preventDefault()">
      <input id="email" type="email" name="email" autocomplete="email">
      <input id="pw" type="password" name="new" autocomplete="new-password">
      <input id="pw2" type="password" name="confirm" autocomplete="new-password">
      <button id="go" type="submit">Create account</button></form>`,
  "/two-step-beside-signup": `<form id="a" onsubmit="event.preventDefault()">
      <input id="user" name="username" autocomplete="username"><button>Next</button></form>
    <form id="b" onsubmit="event.preventDefault()">
      <input id="email" type="email" name="email" autocomplete="email">
      <input id="newpw" type="password" name="new" autocomplete="new-password"></form>`,
  "/button": `<form onsubmit="event.preventDefault()">
      <input id="user" name="username" autocomplete="username">
      <input id="pw" type="password" name="password" autocomplete="current-password"></form>
    <button id="other" style="position:absolute;top:300px;left:400px" onclick="window.__clicked=(window.__clicked||0)+1">Other</button>`,
  "/checkout": `<form onsubmit="event.preventDefault()">
      <input id="email" type="email" name="email" autocomplete="email">
      <input name="address" autocomplete="street-address"><input name="zip" autocomplete="postal-code">
      <button type="submit">Place order</button></form>`,
  "/formless": `<div><input id="user" autocomplete="username"><input id="pw" type="password" autocomplete="current-password">
      <button id="go" type="button">Continue</button></div>`,
  "/modal": `<dialog id="d"><form onsubmit="event.preventDefault()">
      <input id="user" autocomplete="username"><input id="pw" type="password" autocomplete="current-password">
      </form></dialog><script>d.showModal()</script>`,
  "/prefocused": `<form onsubmit="event.preventDefault()"><input id="user" autocomplete="username">
      <input id="pw" type="password" autocomplete="current-password"></form><script>user.focus()</script>`,
  "/framed": `<p>outer</p><iframe src="/inner" style="position:absolute;top:300px;left:50px;width:400px;height:120px;border:0"></iframe>`,
  "/inner": `<form onsubmit="event.preventDefault()"><input id="user" autocomplete="username">
      <input id="pw" type="password" autocomplete="current-password"></form>`,
  "/tall": `<form onsubmit="event.preventDefault()" style="margin-top:200px"><input id="user" autocomplete="username">
      <input id="pw" type="password" autocomplete="current-password"></form><div style="height:3000px"></div>`,
  "/fixed-bar": `<form onsubmit="event.preventDefault()" style="position:fixed;top:20px;left:20px"><input id="user" autocomplete="username">
      <input id="pw" type="password" autocomplete="current-password"></form><div style="height:3000px"></div>`,
  // the list's shadow root opened, so a test can read its scroll position
  "/many": `<script>const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (o) { return (this.__root = attach.call(this, { ...o, mode: "open" })); };
      window.__logins = Array.from({ length: 12 }, (_, i) => ({ username: "user" + i, sites: ["example.com"] }));</script>
      <form onsubmit="event.preventDefault()"><input id="user" autocomplete="username">
      <input id="pw" type="password" autocomplete="current-password"></form>`,
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
      const base = { ok: true, ...window.__reply, logins: window.__logins ?? [{ username: "alice", sites: ["example.com"] }, { username: "bob@example.com", sites: ["www.example.com"] }] };
      if (msg.type === "inlineCodes") return { ...base, codes: [{ id: 0, source: "sms", username: "", domain: location.hostname }] };
      if (msg.type === "hmeGenerate" && window.__hmeDelay) await new Promise((r) => setTimeout(r, window.__hmeDelay));
      if (msg.type === "hmeGenerate" && window.__hmeFail) return { ...base, ok: false, error: "wait a moment" };
      // like the router, reserve hands out the address last shown, never a refused one
      if (msg.type === "hmeGenerate") return { ...base, address: (window.__shown = "x" + window.__sent.filter((m) => m.type === "hmeGenerate").length + "@icloud.com") };
      if (msg.type === "hmeReserve") return { ...base, address: window.__shown };
      return base;
    },
    onMessage: { addListener: (fn) => listeners.push(fn) },
  } };
  // stored settings come in the URL hash, so they're there before the content script asks
  const stored = location.hash ? JSON.parse(decodeURIComponent(location.hash.slice(1))) : {};
  const changed = [];
  chrome.storage = {
    local: { get: async () => ({ ...stored }), set: async () => {} },
    onChanged: { addListener: (fn) => changed.push(fn) },
  };
  window.__setSettings = (patch) => {
    Object.assign(stored, patch);
    const changes = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { newValue: v }]));
    for (const fn of changed) fn(changes, "local");
  };
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
const fills = async (page: Page) => (await sent(page)).filter((m) => m.type === "inlineFill");
/** The middle of the first row under the header, in page coordinates. */
const firstRow = (page: Page) =>
  page.evaluate(() => {
    const r = document.querySelector("icloudkeys-suggestions")!.getBoundingClientRect();
    return { x: r.left + 60, y: r.top + 26 + 22 };
  });
const hostAt = (page: Page, p: { x: number; y: number }) =>
  page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.localName, p);

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
    expect(saves).toEqual([{ type: "offerSave", username: "me@example.com", password: a, isNew: true, afterSignIn: false }]);
    await page.close();
  });

  it("offers a Hide My Email address on a sign-up email field", async () => {
    const page = await open("/signup");
    await page.click("#email");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    // the address is shown first and nothing is created until Use
    await expect.poll(() => dropdownShown(page)).toBe(true);
    expect((await sent(page)).map((m) => m.type)).not.toContain("hmeReserve");
    expect(await page.inputValue("#email")).toBe("");
    // Refresh, then Use the second address
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await sent(page)).filter((m) => m.type === "hmeGenerate").length).toBe(2);
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.inputValue("#email")).toBe("x2@icloud.com");
    expect((await sent(page)).filter((m) => m.type === "hmeReserve")).toEqual([{ type: "hmeReserve" }]);
    await page.close();
  });

  it("marks a generated password yellow until the user edits it", async () => {
    const page = await open("/signup");
    await page.click("#pw");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const bg = (sel: string) => page.$eval(sel, (el) => getComputedStyle(el).backgroundColor);
    await expect.poll(() => bg("#pw")).toBe("rgb(255, 248, 196)");
    expect(await bg("#pw2")).toBe("rgb(255, 248, 196)");
    await page.keyboard.type("x");
    await expect.poll(() => bg("#pw")).not.toBe("rgb(255, 248, 196)");
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

describe("like Safari's list", () => {
  it("filters logins as the user types and closes when none match", async () => {
    const page = await open("/login");
    await page.click("#user");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.keyboard.type("bo");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    expect(await fills(page)).toEqual([{ type: "inlineFill", username: "bob@example.com" }]);
    await page.click("#user");
    await page.keyboard.type("zzz");
    await expect.poll(() => dropdownShown(page)).toBe(false);
    await page.close();
  });

  it("brings the list back on ArrowDown after Escape", async () => {
    const page = await open("/login");
    await page.click("#user");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.keyboard.press("Escape");
    expect(await dropdownShown(page)).toBe(false);
    await page.keyboard.press("ArrowDown");
    expect(await dropdownShown(page)).toBe(true);
    await page.close();
  });

  it("ends a login list with Open Passwords App", async () => {
    const page = await open("/login");
    await page.click("#pw");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    expect((await sent(page)).map((m) => m.type)).toContain("inlineLaunch");
    expect(await fills(page)).toEqual([]);
    await page.close();
  });

  it("fills on a real click on a row", async () => {
    const page = await open("/login");
    await page.click("#pw");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    const p = await firstRow(page);
    await page.mouse.click(p.x, p.y);
    expect(await fills(page)).toEqual([{ type: "inlineFill", username: "alice" }]);
    await page.close();
  });

  it("refuses a click on a list the page has faded out", async () => {
    const page = await open("/login");
    await page.click("#pw");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    const p = await firstRow(page);
    await page.evaluate(() => document.querySelector<HTMLElement>("icloudkeys-suggestions")!.style.setProperty("opacity", "0.01", "important"));
    await page.mouse.click(p.x, p.y);
    expect(await fills(page)).toEqual([]);
    await page.close();
  });

  it("shows and works over a modal login dialog", async () => {
    const page = await open("/modal");
    await page.click("#user");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    const p = await firstRow(page);
    expect(await hostAt(page, p)).toBe("icloudkeys-suggestions");
    await page.mouse.click(p.x, p.y);
    expect(await fills(page)).toEqual([{ type: "inlineFill", username: "alice" }]);
    await page.close();
  });

  it("stays above a popover the page opens later, and closes when a modal takes focus", async () => {
    const page = await open("/login");
    await page.click("#user");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    const p = await firstRow(page);
    await page.evaluate(() => {
      const cover = document.createElement("div");
      cover.popover = "manual";
      cover.style.cssText = "inset:0;width:100vw;height:100vh;margin:0;background:red";
      document.body.append(cover);
      cover.showPopover();
    });
    expect(await hostAt(page, p)).toBe("icloudkeys-suggestions");
    await page.evaluate(() => {
      const d = document.createElement("dialog");
      document.body.append(d);
      d.showModal();
    });
    await expect.poll(() => dropdownShown(page)).toBe(false);
    await page.close();
  });

  it("puts a key button in a focused login field that toggles the list", async () => {
    const page = await open("/login");
    await page.click("#pw");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    const key = await page.evaluate(() => {
      const r = document.querySelector("icloudkeys-key")?.getBoundingClientRect();
      return r && { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    expect(key).toBeTruthy();
    await page.mouse.click(key!.x, key!.y);
    expect(await dropdownShown(page)).toBe(false);
    await page.mouse.click(key!.x, key!.y);
    await expect.poll(() => dropdownShown(page)).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("pw");
    await page.mouse.click(5, 400);
    expect(await page.evaluate(() => !!document.querySelector("icloudkeys-key"))).toBe(false);
    await page.close();
  });

  it("keeps the list and key button away when In-Page AutoFill is off, but still fills from the toolbar", async () => {
    const page = await open("/two-logins#" + encodeURIComponent(JSON.stringify({ inPageAutoFill: false })));
    await page.waitForTimeout(100);
    await page.click("#pw2");
    await page.waitForTimeout(300);
    expect(await dropdownShown(page)).toBe(false);
    expect(await page.evaluate(() => !!document.querySelector("icloudkeys-key"))).toBe(false);
    await page.keyboard.press("ArrowDown");
    expect(await dropdownShown(page)).toBe(false);
    expect((await sent(page)).some((m) => m.type === "inlineLogins")).toBe(false);
    const res = await page.evaluate(() =>
      (window as any).__deliver({ type: "fill", expectedHost: "127.0.0.1", username: "alice", password: "hunter2" }, { id: "ext" }),
    );
    expect(res).toEqual({ filled: true });
    // into the form the user focused, not the first one on the page
    expect([await page.inputValue("#pw1"), await page.inputValue("#pw2")]).toEqual(["", "hunter2"]);
    await page.close();
  });

  it("closes an open list when In-Page AutoFill is turned off", async () => {
    const page = await open("/login");
    await page.click("#pw");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.evaluate(() => (window as any).__setSettings({ inPageAutoFill: false }));
    await expect.poll(() => dropdownShown(page)).toBe(false);
    expect(await page.evaluate(() => !!document.querySelector("icloudkeys-key"))).toBe(false);
    await page.close();
  });

  it("leaves the key button out when it is turned off", async () => {
    const page = await open("/login#" + encodeURIComponent(JSON.stringify({ keyButton: false })));
    await page.waitForTimeout(100);
    await page.click("#pw");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    expect(await page.evaluate(() => !!document.querySelector("icloudkeys-key"))).toBe(false);
    await page.close();
  });

  it("stays out of the way of a field we just filled, until asked", async () => {
    const page = await open("/login");
    await page.click("#user");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.evaluate(() =>
      (window as any).__deliver({ type: "fill", expectedHost: "127.0.0.1", username: "alice", password: "hunter2" }, { id: "ext" }),
    );
    // focus coming back to a filled field, as when the toolbar popup closes after a fill
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.focus("#pw");
    await page.waitForTimeout(300);
    expect(await dropdownShown(page)).toBe(false);
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.keyboard.press("Escape");
    await page.click("#user");
    await page.waitForTimeout(300);
    expect(await dropdownShown(page)).toBe(false);
    // emptying it asks again
    await page.fill("#user", "");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.close();
  });

  it("offers on a field focused before the script loaded", async () => {
    const page = await open("/prefocused");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.close();
  });

  it("draws a same-origin iframe's list in the top page, under the field", async () => {
    const page = await open("/framed");
    await page.frameLocator("iframe").locator("#user").click();
    await expect.poll(() => dropdownShown(page)).toBe(true);
    const top = await page.evaluate(() => document.querySelector("icloudkeys-suggestions")!.getBoundingClientRect().top);
    expect(top).toBeGreaterThan(300);
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
    expect(types).not.toContain("inlineLaunch");
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
      { type: "offerSave", username: "carol", password: "typed", isNew: false, afterSignIn: true },
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
      { type: "offerSave", username: "bob", password: "typed-pw", isNew: false, afterSignIn: true },
    ]);
    await page.close();
  });

  const outcomes = async (page: Page) => (await sent(page)).filter((m) => m.type === "signInOutcome").map((m) => m.ok);
  const submitTyped = async (page: Page) => {
    await page.fill("#user", "bob");
    await page.fill("#pw", "typed-pw");
    await page.keyboard.press("Escape");
    await page.click("#go");
  };

  it("reports a typed sign-in as working once the login form goes away", async () => {
    const page = await open("/login");
    await submitTyped(page);
    await page.waitForTimeout(600);
    expect(await outcomes(page)).toEqual([]);
    await page.evaluate(() => document.querySelector("form")!.remove());
    await expect.poll(() => outcomes(page)).toEqual([true]);
    await page.close();
  });

  it("reports a failed sign-in when the password is typed again", async () => {
    const page = await open("/login");
    await submitTyped(page);
    await page.fill("#pw", "");
    await page.type("#pw", "x");
    await expect.poll(() => outcomes(page)).toEqual([false]);
    await page.close();
  });

  it("reports a failed sign-in when the login form stays up", async () => {
    const page = await open("/login");
    await submitTyped(page);
    await expect.poll(() => outcomes(page), { timeout: 10_000 }).toEqual([false]);
    await page.close();
  }, 15_000);

  it("tells the background whether a newly loaded page still shows a login", async () => {
    const check = (page: Page) => page.evaluate(() => (window as any).__deliver({ type: "signInCheck" }, { id: "ext" }));
    const login = await open("/login");
    expect(await check(login)).toMatchObject({ loginShown: true });
    await login.close();
    const otp = await open("/otp");
    expect(await check(otp)).toMatchObject({ loginShown: false });
    await otp.close();
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

// Bugs found by review; each test failed before its fix.
describe("regressions", () => {
  const pickStrong = async (page: Page) => {
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
  };
  const bg = (page: Page, sel: string) => page.$eval(sel, (el) => getComputedStyle(el).backgroundColor);

  it("puts the user name in at once, before the helper answers with the password", async () => {
    const page = await open("/login");
    await page.click("#user");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    // the stub never delivers the fill, as a helper still looking up the password wouldn't
    expect([await page.inputValue("#user"), await page.inputValue("#pw")]).toEqual(["alice", ""]);
    await page.close();
  });

  it("puts no user name into a password field ahead of the fill", async () => {
    const page = await open("/login");
    await page.click("#pw");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    expect([await page.inputValue("#user"), await page.inputValue("#pw")]).toEqual(["", ""]);
    await page.close();
  });

  it("offers Use Complex Password second, and fills it", async () => {
    const page = await open("/signup");
    await page.click("#pw");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const pw = await page.inputValue("#pw");
    expect(pw).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!#$%&*+\-=?@^_])[a-zA-Z0-9!#$%&*+\-=?@^_]{20}$/);
    expect(await page.inputValue("#pw2")).toBe(pw);
    await page.close();
  });

  it("Enter on Use Strong Password doesn't offer to save before any submit", async () => {
    const page = await open("/signup");
    await page.click("#pw");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await pickStrong(page);
    await page.waitForTimeout(200);
    expect((await sent(page)).some((m) => m.type === "offerSave")).toBe(false);
    await page.close();
  });

  it("a second strong password still clears its highlight on edit", async () => {
    const page = await open("/signup");
    await page.click("#pw");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await pickStrong(page);
    await expect.poll(() => bg(page, "#pw")).toBe("rgb(255, 248, 196)");
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await pickStrong(page);
    await page.keyboard.type("x");
    expect(await bg(page, "#pw")).not.toBe("rgb(255, 248, 196)");
    await page.close();
  });

  it("closes the list when the page removes the field long after focus", async () => {
    const page = await open("/login");
    await page.click("#user");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.waitForTimeout(5_500);
    await page.evaluate(() => document.querySelector("form")!.remove());
    await expect.poll(() => dropdownShown(page)).toBe(false);
    await page.close();
  }, 15_000);

  it("keeps the key button on a field that moves", async () => {
    const page = await open("/login");
    await page.click("#pw");
    await page.evaluate(() => ((document.querySelector("#pw") as HTMLElement).style.marginTop = "200px"));
    await expect
      .poll(() =>
        page.evaluate(() => {
          const k = document.querySelector("icloudkeys-key")!.getBoundingClientRect();
          const f = document.querySelector("#pw")!.getBoundingClientRect();
          return Math.abs(k.top + k.height / 2 - (f.top + f.height / 2)) < 2;
        }),
      )
      .toBe(true);
    await page.close();
  });

  // read in the same task as the scroll, before any scroll event could let script move them
  const gapsAfterScroll = (page: Page) =>
    page.evaluate(() => {
      const gaps = () => {
        const f = document.querySelector("#pw")!.getBoundingClientRect();
        const l = document.querySelector("icloudkeys-suggestions")!.getBoundingClientRect();
        const k = document.querySelector("icloudkeys-key")!.getBoundingClientRect();
        return [Math.round(l.top - f.bottom), Math.round(k.top - f.top)];
      };
      const before = gaps();
      window.scrollBy(0, 150);
      return [before, gaps()];
    });

  it("keeps the list where the user scrolled it while it follows the field", async () => {
    const page = await open("/many");
    await page.click("#user");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    const rows = () => page.evaluate(() => (document.querySelector("icloudkeys-suggestions") as any).__root.querySelector(".rows").scrollTop);
    const r = await page.evaluate(() => document.querySelector("icloudkeys-suggestions")!.getBoundingClientRect());
    await page.mouse.move(r.left + 60, r.top + 100);
    await page.mouse.wheel(0, 120);
    await expect.poll(rows).toBeGreaterThan(0);
    const scrolled = await rows();
    // a few rounds of the 100ms tracker
    await page.waitForTimeout(400);
    expect(await rows()).toBe(scrolled);
    await page.close();
  });

  it("scrolls the list and key button with the page, not a frame behind it", async () => {
    const page = await open("/tall");
    await page.click("#pw");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    const [before, after] = await gapsAfterScroll(page);
    expect(after).toEqual(before);
    await page.close();
  });

  it("keeps the list on a field in a fixed bar while the page scrolls", async () => {
    const page = await open("/fixed-bar");
    await page.click("#pw");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    const [before, after] = await gapsAfterScroll(page);
    expect(after).toEqual(before);
    await page.close();
  });

  it("doesn't put a saved password into a sign-up form beside a two-step login", async () => {
    const page = await open("/two-step-beside-signup");
    await page.click("#user");
    const res = await page.evaluate(() =>
      (window as any).__deliver({ type: "fill", expectedHost: "127.0.0.1", username: "alice", password: "hunter2" }, { id: "ext" }),
    );
    expect(res).toEqual({ filled: true });
    expect([await page.inputValue("#user"), await page.inputValue("#newpw")]).toEqual(["alice", ""]);
    await page.close();
  });

  it("lets the click right after picking a row through", async () => {
    const page = await open("/button");
    await page.click("#user");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.mouse.click(...(Object.values(await firstRow(page)) as [number, number]));
    expect(await fills(page)).toHaveLength(1);
    await page.click("#other");
    expect(await page.evaluate(() => (window as any).__clicked)).toBe(1);
    await page.close();
  });

  it("drops a Hide My Email address that arrives after in-page AutoFill was turned off", async () => {
    const page = await open("/signup");
    await page.evaluate(() => ((window as any).__hmeDelay = 400));
    await page.click("#email");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.evaluate(() => (window as any).__setSettings({ inPageAutoFill: false }));
    await page.waitForTimeout(700);
    expect(await dropdownShown(page)).toBe(false);
    await page.close();
  });

  it("keeps the shown address when a Refresh is refused", async () => {
    const page = await open("/signup");
    await page.click("#email");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.evaluate(() => ((window as any).__hmeFail = true));
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await sent(page)).filter((m) => m.type === "hmeGenerate").length).toBe(2);
    await expect.poll(() => dropdownShown(page)).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.inputValue("#email")).toBe("x1@icloud.com");
    await page.close();
  });
});
