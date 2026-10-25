// Runs the classifier in real Chromium: it depends on layout (visibility, bounding boxes),
// which jsdom-style DOMs don't compute. Fixtures are served over 127.0.0.1 because
// loginishContext reads location.hostname and pathname.

import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css" };

let server: Server;
let base: string;
let browser: Browser;
let bundle: string;

beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    bundle: true,
    format: "iife",
    globalName: "Classifier",
    write: false,
    footer: { js: "globalThis.Classifier = Classifier;" },
  });
  bundle = out.outputFiles[0]!.text;

  server = createServer(async (req, res) => {
    const path = normalize(join(FIXTURES, decodeURIComponent(new URL(req.url!, "http://x").pathname)));
    if (!path.startsWith(FIXTURES)) return void res.writeHead(403).end();
    try {
      const body = await readFile(path);
      res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
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
  await page.addInitScript(bundle);
  await page.goto(`${base}/${path}`, { waitUntil: "load" });
  return page;
}

async function classify(page: Page, selector: string): Promise<string | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`selector not found: ${sel}`);
    return (globalThis as any).Classifier.classifyFocus(el);
  }, selector);
}

// open-passwords' 23 adversarial fields, plus one of ours, that must never get a login offer
const negatives: [string, string[]][] = [
  ["search-bar", ["#header-search", "#inline-search", "#form-search"]],
  ["social-tag", ["#tag-search", "#tag-combobox"]],
  ["compose-message", ["#dm-input", "#compose-textarea", "#compose-editable"]],
  ["comment-box", ["#comment-input", "#reply-input"]],
  ["checkout-address", ["#first-name", "#last-name", "#address", "#city", "#postal-code", "#email"]],
  ["newsletter", ["input[type=email]"]],
  ["profile-edit", ["#display-name", "#profile-email", "#profile-phone"]],
  ["otp-password-field", ["#otp-pass"]],
  ["mixed-footer-email", ["#foot-email"]],
  ["waitlist", ["#waitlist-email"]],
  // not from open-passwords: isolates the address-form fix behind a "Sign in" button
  ["checkout-signin", ["#email"]],
];

describe.each(negatives)("adversarial/%s", (page, selectors) => {
  it.each(selectors)("%s gets no login offer", async (sel) => {
    const p = await open(`adversarial/${page}.html`);
    expect(await classify(p, sel)).not.toBe("login");
    await p.close();
  });
});

const positives: [string, string[]][] = [
  ["adversarial/mixed-page.html", ["#login-username", "#login-password"]],
  ["adversarial/mixed-footer-email.html", ["#login-user", "#login-pass"]],
  ["login-standard.html", ["#username", "#password"]],
  // the two-step first page: the Continue/Next fix must not break it
  ["login-twostep.html", ["#username"]],
  ["tricky.html", ["#visible-user"]],
];

describe.each(positives)("%s", (page, selectors) => {
  it.each(selectors)("%s gets a login offer", async (sel) => {
    const p = await open(page);
    expect(await classify(p, sel)).toBe("login");
    await p.close();
  });
});

it("mixed-page search boxes get no offer next to a real login", async () => {
  const p = await open("adversarial/mixed-page.html");
  expect(await classify(p, "#header-search")).toBeNull();
  expect(await classify(p, "#body-search")).toBeNull();
  await p.close();
});

it("the password-typed OTP box is routed to one-time codes, not logins", async () => {
  const p = await open("adversarial/otp-password-field.html");
  expect(await classify(p, "#otp-pass")).toBe("otp");
  await p.close();
});

it("fills username and password in the anchor's form, not the newsletter", async () => {
  const p = await open("adversarial/mixed-footer-email.html");
  const values = await p.evaluate(() => {
    const C = (globalThis as any).Classifier;
    const ok = C.fillCredentials("alice", "s3cret", document.querySelector("#login-pass"));
    const v = (s: string) => (document.querySelector(s) as HTMLInputElement).value;
    return { ok, user: v("#login-user"), pass: v("#login-pass"), foot: v("#foot-email") };
  });
  expect(values).toEqual({ ok: true, user: "alice", pass: "s3cret", foot: "" });
  await p.close();
});

it("refuses to fill a transparent clickjacking field", async () => {
  const p = await open("login-standard.html");
  const filled = await p.evaluate(() => {
    const pw = document.querySelector("#password") as HTMLInputElement;
    pw.style.opacity = "0";
    return (globalThis as any).Classifier.isFillable(pw);
  });
  expect(filled).toBe(false);
  await p.close();
});

describe("forms", () => {
  // each case swaps the body of a served page, so location stays on 127.0.0.1
  async function withBody<T>(html: string, fn: () => T): Promise<Awaited<T>> {
    const page = await open("login-standard.html");
    try {
      await page.evaluate((html) => void (document.body.innerHTML = html), html);
      return (await page.evaluate(fn)) as Awaited<T>;
    } finally {
      await page.close();
    }
  }

  it("collects a sign-in and keeps the username before the password", async () => {
    const got = await withBody(
      `<form><input name="q" value="search"><input autocomplete="username" value="alice">
       <input type="password" value="pw"></form>`,
      () => (globalThis as any).Classifier.collectSubmitted(document),
    );
    expect(got).toEqual({ username: "alice", password: "pw", allPasswords: ["pw"], isNew: false });
  });

  it("takes the repeated value on a change form, not the current password", async () => {
    const got = await withBody(
      `<form><input type="password" value="old"><input type="password" value="new1"><input type="password" value="new1"></form>`,
      () => (globalThis as any).Classifier.collectSubmitted(document),
    );
    expect(got).toMatchObject({ password: "new1", isNew: true });
  });

  it("won't take a short code as the username", async () => {
    const got = await withBody(
      `<form><input name="digit" value="9"><input type="password" value="pw"></form>`,
      () => (globalThis as any).Classifier.collectSubmitted(document),
    );
    expect(got.username).toBe("");
  });

  it("offers Hide My Email on a sign-up email, never on a sign-in email", async () => {
    const signUp = await withBody(
      `<form><input id="e" type="email"><input type="password" autocomplete="new-password"></form>`,
      () => (globalThis as any).Classifier.isEmailField(document.getElementById("e")),
    );
    const signIn = await withBody(
      `<form><input id="e" type="email"><input type="password" autocomplete="current-password"></form>`,
      () => (globalThis as any).Classifier.isEmailField(document.getElementById("e")),
    );
    const newsletter = await withBody(
      `<form><input id="e" type="email" name="newsletter"><button>Subscribe</button></form>`,
      () => (globalThis as any).Classifier.isEmailField(document.getElementById("e")),
    );
    expect([signUp, signIn, newsletter]).toEqual([true, false, true]);
  });

  it("spreads a code across single-character boxes", async () => {
    const got = await withBody(
      `<div>${'<input maxlength="1" autocomplete="one-time-code">'.repeat(6)}</div>`,
      () => {
        const boxes = Array.from(document.querySelectorAll("input"));
        (globalThis as any).Classifier.fillOneTimeCode(boxes[0], "12-34 56");
        return boxes.map((b) => b.value).join("");
      },
    );
    expect(got).toBe("123456");
  });
});
