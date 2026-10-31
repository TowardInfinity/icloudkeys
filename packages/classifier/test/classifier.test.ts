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
  async function withBody<T>(html: string, fn: () => T, path = "/account"): Promise<Awaited<T>> {
    const page = await open("login-standard.html");
    try {
      await page.evaluate(
        ({ html, path }) => {
          // the path and title are part of what's being classified
          history.replaceState(null, "", path);
          document.title = path === "/login" ? "Log in or Sign up" : "";
          document.body.innerHTML = html;
        },
        { html, path },
      );
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

  it.each([
    // [case, body, path, expected]
    ["new-password form", `<form><input id="e" type="email"><input type="password" autocomplete="new-password"></form>`, "/account", true],
    ["sign-in form", `<form><input id="e" type="email"><input type="password" autocomplete="current-password"></form>`, "/account", false],
    ["newsletter", `<form><input id="e" type="email" name="newsletter"><button>Subscribe</button></form>`, "/blog", true],
    ["email-first sign-in", `<form><input id="e" type="email"><button>Continue</button></form>`, "/login", false],
    ["sign-up marked username (Figma, Dropbox)", `<form><input id="e" type="email" autocomplete="username webauthn"><button>Continue</button></form>`, "/signup", true],
    ["sign-up with a sign-in box on the page (Notion)", `<form><input id="e" type="email" autocomplete="email"><input type="password" autocomplete="current-password"></form>`, "/signup", true],
    ["text field named for email (LinkedIn)", `<form><input id="e" name="email-address" autocomplete="username"><input type="password" autocomplete="new-password"></form>`, "/signup", true],
    ["create-account button", `<form><input id="e" type="email"><input type="password"><button>Create account</button></form>`, "/start", true],
    ["sign-in page with a sign-up button (Dropbox)", `<form><input id="e" type="email" autocomplete="username webauthn"><button>Continue</button></form><button>Sign up</button>`, "/login", false],
    ["sign-in page with a hidden password and a Create account button (Google)", `<form><input id="e" name="identifier" autocomplete="username webauthn" aria-label="Email or phone"><input type="password" style="display:none"><button type="button">Create account</button></form>`, "/v3/signin/identifier", false],
    ["not an email", `<form><input id="e" name="first_name"><input type="password" autocomplete="new-password"></form>`, "/signup", false],
  ])("Hide My Email offer: %s", async (_, body, path, expected) => {
    const got = await withBody(body, () => (globalThis as any).Classifier.isEmailField(document.getElementById("e")), path);
    expect(got).toBe(expected);
  });

  it.each([
    ["Google authenticator", `<input id="e" type="tel" name="totpPin" autocomplete="off" aria-label="Enter code" pattern="[0-9 ]*">`, true],
    ["Google text message", `<input id="e" type="tel" name="Pin" id="idvPin" aria-label="Enter the code">`, true],
    ["Amazon", `<input id="e" name="otpCode" aria-label="Enter OTP">`, true],
    ["GitHub", `<input id="e" name="app_otp" autocomplete="off">`, true],
    ["LinkedIn", `<input id="e" name="verification_pin">`, true],
    ["Microsoft", `<input id="e" type="tel" name="otc">`, true],
    ["camelCase", `<input id="e" name="verificationCode">`, true],
    ["emailed login code", `<input id="e" aria-label="Login code">`, true],
    ["emailed magic code", `<input id="e" name="magicCode">`, true],
    ["card security code by autocomplete", `<input id="e" autocomplete="cc-csc" aria-label="Security code">`, false],
    ["card security code by name", `<input id="e" name="cardSecurityCode" aria-label="Security code">`, false],
    ["cvv", `<input id="e" name="cvv" aria-label="Security code">`, false],
    ["promo code", `<input id="e" name="promo" aria-label="Enter promo code">`, false],
    ["indian postal code", `<input id="e" name="pincode" aria-label="Enter pincode">`, false],
    ["zip", `<input id="e" name="zipCode">`, false],
    ["confirm a password", `<input id="e" type="password" name="passwordVerification">`, false],
    ["an email to verify", `<input id="e" type="email" name="verificationEmail">`, false],
    ["hot pot", `<input id="e" name="hotPot">`, false],
  ])("one-time-code field: %s", async (_, body, expected) => {
    const got = await withBody(body, () => (globalThis as any).Classifier.isOtpField(document.getElementById("e")));
    expect(got).toBe(expected);
  });

  it.each([
    // [case, body, expected]
    ["login with a Create account button beside it", `<form><input name="u"><input id="e" type="password"><button type="submit">Log in</button><button type="button">Create account</button></form>`, false],
    ["register page", `<form><input name="u"><input id="e" type="password"><button type="submit">Register</button></form>`, true],
    ["sign-up named by its id", `<form><input type="email"><input id="e" type="password" name="reg-password"><button>Continue</button></form>`, true],
    ["sign-up named by its placeholder", `<form><input type="email"><input id="e" type="password" placeholder="Choose a password"><button>Continue</button></form>`, true],
    ["new-password set on a login by mistake", `<form><input name="u"><input id="e" type="password" autocomplete="new-password"><button type="submit">Sign in</button></form>`, false],
    ["new-password on a Continue button", `<form><input type="email"><input id="e" type="password" autocomplete="new-password"><button>Continue</button></form>`, true],
    ["two passwords, sign-up", `<form><input type="email"><input id="e" type="password"><input type="password"></form>`, true],
    ["change form, the current one", `<form><input id="e" type="password"><input type="password"><input type="password"></form>`, false],
    ["change form, the new one", `<form><input type="password"><input id="e" type="password"><input type="password"></form>`, true],
    ["change form, current named", `<form><input id="e" type="password" name="old_password"><input type="password" name="password"></form>`, false],
    ["two fields, current then new", `<form><input id="e" type="password"><input type="password" name="new_password"></form>`, false],
    ["reset form", `<form><input id="e" type="password" name="password"><input type="password" name="password_confirmation"><button>Reset password</button></form>`, true],
    ["forgot-password link marks a login", `<form><input name="u"><input id="e" type="password"><a href="/f">Forgot password?</a><button>Continue</button></form>`, false],
    ["already-have-an-account marks a sign-up", `<form><input type="email"><input id="e" type="password"><p>Already have an account?</p><button>Continue</button></form>`, true],
    ["login and sign-up in one page-wide form", `<form><nav></nav><div><input name="u"><input id="e" type="password"><button type="submit">Log in</button></div><div><input type="email"><input type="password"><input type="password"><button type="submit">Sign up</button></div></form>`, false],
    ["a sign-in with terms small print", `<form><input name="u"><input id="e" type="password"><p>By continuing you agree to our Terms of Service</p><button>Continue</button></form>`, false],
    ["hidden already-have-an-account text", `<form><input name="u"><input id="e" type="password"><p style="display:none">Already have an account?</p><button>Continue</button></form>`, false],
    ["german login", `<form><input name="u"><input id="e" type="password"><button type="submit">Anmelden</button><a>Registrieren</a></form>`, false],
    ["german sign-up", `<form><input name="u"><input id="e" type="password"><button type="submit">Registrieren</button></form>`, true],
    ["hindi sign-up", `<form><input name="u"><input id="e" type="password"><button type="submit">साइन अप</button></form>`, true],
  ])("new password: %s", async (_, body, expected) => {
    expect(await withBody(body, () => (globalThis as any).Classifier.isNewPasswordField(document.getElementById("e")))).toBe(expected);
  });

  it.each([
    ["underscored name", `<form><input id="e" name="j_username"><input type="password"></form>`, "login"],
    ["camelCase name", `<form><input id="e" name="txtUserName"><input type="password"></form>`, "login"],
    ["any box right above a login password", `<form><input id="e" name="uwinid"><input type="password"><button>Log in</button></form>`, "login"],
    ["non-English name right above a password", `<form><input id="e" name="codeUtilisateur"><input type="password"></form>`, "login"],
    ["two-step, german label", `<form action="/x"><label for="e">Benutzername</label><input id="e"><button>Anmelden</button></form>`, "login"],
    ["first name above a sign-up password", `<form><input id="e" name="first_name"><input type="password" autocomplete="new-password"></form>`, null],
    ["name inside a bracketed key", `<form><input id="e" name="email-signup-user[first_name]"><input type="password"></form>`, null],
    ["captcha above a password", `<form><input id="e" name="captcha"><input type="password"></form>`, null],
    ["box two above a password", `<form><input id="e" name="something"><input name="other"><input type="password"></form>`, null],
    ["newsletter in a page-wide form with a login", `<form><footer><input id="e" type="email" name="news"><button type="submit">Subscribe</button></footer><div><input name="user"><input type="password"><button type="submit">Log in</button></div></form>`, null],
    ["card code typed as a password", `<form><input id="e" type="password" name="cvv"></form>`, null],
    ["card autocomplete", `<form><input id="e" type="password" autocomplete="cc-csc"></form>`, null],
    ["card security number", `<form><input id="e" type="password" name="CardSecurityNumber"></form>`, null],
    ["security answer", `<form><input name="user"><input id="e" type="password" name="securityAnswer"></form>`, null],
    ["social security box", `<form><input id="e" type="password" name="SSN_1"></form>`, null],
    ["a real password on a tax site", `<form><input name="u"><input id="e" type="password" placeholder="Your tax account password"></form>`, "login"],
    ["a card portal's password", `<form><input name="u"><input id="e" type="password" name="cardPassword"></form>`, "login"],
    ["authenticator or backup code", `<form><input id="e" name="code" aria-label="Authenticator code or backup code"></form>`, "otp"],
    ["recovery code", `<form><input id="e" name="recoveryCode" aria-label="Enter a recovery code"></form>`, null],
    ["backup code", `<form><input id="e" name="backupCodePin" aria-label="Enter one of your 8-digit backup codes"></form>`, null],
  ])("focus offer: %s", async (_, body, expected) => {
    expect(await withBody(body, () => (globalThis as any).Classifier.classifyFocus(document.getElementById("e")), "/x")).toBe(expected);
  });

  it("isn't swayed by a sign-up link in the query string", async () => {
    const got = await withBody(`<form><input name="u"><input id="e" type="password"><button>Continue</button></form>`, () => (globalThis as any).Classifier.isNewPasswordField(document.getElementById("e")), "/auth?next=/register");
    expect(got).toBe(false);
  });

  it("keeps a login card's password in scope despite its header and a Next button", async () => {
    const got = await withBody(`<form><header>Log in</header><div><input id="u" name="username"><button type="button">Next</button></div><div><input id="p" type="password"></div><footer><a>Help</a></footer></form>`, () => {
      (globalThis as any).Classifier.fillCredentials("alice", "pw", document.getElementById("u"));
      return (document.getElementById("p") as HTMLInputElement).value;
    });
    expect(got).toBe("pw");
  });

  it("won't guess between two filled IDs in a formless page", async () => {
    const got = await withBody(`<input id="a" autocomplete="username" value="a@example.com"><input id="b" type="email" value="b@example.com">`, () => (globalThis as any).Classifier.submittedId(document), "/login");
    expect(got).toBe("");
  });

  it("fills the box above the password whatever it's called", async () => {
    const got = await withBody(`<form><input id="u" name="uwinid"><input id="p" type="password"></form>`, () => {
      const p = document.getElementById("p") as HTMLInputElement;
      (globalThis as any).Classifier.fillCredentials("alice", "pw", p);
      return [(document.getElementById("u") as HTMLInputElement).value, p.value];
    });
    expect(got).toEqual(["alice", "pw"]);
  });

  it.each([
    ["read-only", `<input id="u" name="username" readonly value="x">`],
    ["disabled", `<input id="u" name="username" disabled value="x">`],
    ["covered by another element", `<input id="u" name="username" value="x"><div style="position:fixed;inset:0;background:#fff"></div>`],
  ])("won't write into a field that's %s, unless the user is in it", async (_, field) => {
    const got = await withBody(`<form>${field}<input id="p" type="password"></form>`, () => {
      const c = (globalThis as any).Classifier;
      const u = document.getElementById("u") as HTMLInputElement;
      const p = document.getElementById("p") as HTMLInputElement;
      c.fillCredentials("alice", "pw", p);
      const skipped = u.value;
      c.fillCredentials("alice", "pw", u);
      return [skipped, u.value];
    });
    expect(got).toEqual(["x", "alice"]);
  });

  it.each([
    ["a floating label", `<div style="position:relative"><input id="u" name="username"><label for="u" style="position:absolute;left:4px;top:2px">User</label></div>`],
    ["an icon on top", `<div style="position:relative"><input id="u" name="username" style="width:200px"><span style="position:absolute;right:0;top:0;width:16px;height:16px"></span></div>`],
    ["a mask that lets clicks through", `<div style="position:relative"><input id="u" name="username"><div style="position:absolute;inset:0;pointer-events:none"></div></div>`],
    ["being scrolled out of view", `<div style="height:3000px"></div><input id="u" name="username">`],
  ])("still fills a field with %s", async (_, field) => {
    const got = await withBody(`<form>${field}<input id="p" type="password"></form>`, () => {
      (globalThis as any).Classifier.fillCredentials("alice", "pw", document.getElementById("p"));
      return (document.getElementById("u") as HTMLInputElement).value;
    });
    expect(got).toBe("alice");
  });

  it("won't put a password into a card code box", async () => {
    const got = await withBody(`<form><input name="user"><input id="c" type="password" name="cvv"></form>`, () => {
      (globalThis as any).Classifier.fillCredentials("alice", "pw", document.querySelector("input[name=user]"));
      return (document.getElementById("c") as HTMLInputElement).value;
    });
    expect(got).toBe("");
  });

  it.each([
    ["Google tag", `<div data-profile-identifier>alice@example.com</div><form><input id="e" type="password"></form>`, "alice@example.com"],
    ["short text in the form", `<form><div>Welcome</div><span> alice@example.com </span><input id="e" type="password"></form>`, "alice@example.com"],
    ["an email inside a sentence", `<form><p>Write to help@example.com for support</p><input id="e" type="password"></form>`, undefined],
    ["two different emails", `<form><span>a@example.com</span><span>b@example.com</span><input id="e" type="password"></form>`, undefined],
    ["hidden text", `<form><span style="display:none">a@example.com</span><input id="e" type="password"></form>`, undefined],
    ["nothing shown", `<form><input id="e" type="password"></form>`, undefined],
  ])("account shown on the page: %s", async (_, body, expected) => {
    expect(await withBody(body, () => (globalThis as any).Classifier.shownAccount(document.getElementById("e")) ?? undefined)).toBe(expected);
  });

  it.each([
    ["a sign-in's ID step", `<form><input id="e" name="identifier" autocomplete="username"><button>Next</button></form>`, "/login", "alice@example.com"],
    ["a sign-up's email step", `<form><input id="e" type="email"><button>Continue</button></form>`, "/signup", "alice@example.com"],
    ["a newsletter", `<form><input id="e" type="email" name="news"><button>Subscribe</button></form>`, "/blog", ""],
    ["a form with a password", `<form><input id="e" autocomplete="username"><input type="password"></form>`, "/login", ""],
    ["a sign-up worded newsletter", `<form><input id="e" type="email"><button>Sign up for our newsletter</button></form>`, "/blog", ""],
  ])("ID submitted on its own: %s", async (_, body, path, expected) => {
    const got = await withBody(body, () => {
      const c = (globalThis as any).Classifier;
      const e = document.getElementById("e") as HTMLInputElement;
      e.value = "alice@example.com";
      return c.submittedId(e.form);
    }, path);
    expect(got).toBe(expected);
  });

  it.each([
    ["no maxlength, by position", `<div style="display:flex;gap:4px">${'<input style="width:30px" inputmode="numeric">'.repeat(6)}</div>`, "123456"],
    ["each in its own shadow root", `<div id="row" style="display:flex"></div>`, "123456"],
  ])("spreads a code across boxes: %s", async (name, body, expected) => {
    const got = await withBody(body, () => {
      const row = document.getElementById("row");
      if (row) for (let i = 0; i < 6; i++) row.appendChild(document.createElement("x-box")).attachShadow({ mode: "open" }).innerHTML = '<input maxlength="1" style="width:30px">';
      const boxes = (globalThis as any).Classifier.allInputs() as HTMLInputElement[];
      (globalThis as any).Classifier.fillOneTimeCode(boxes[0], "123456");
      return boxes.map((b) => b.value).join("");
    });
    expect(got).toBe(expected);
  });

  it("trusts Apple's embedded login hosts and not look-alikes", async () => {
    const got = await withBody("", () =>
      ["idmsa.apple.com", "appleid.apple.com", "apple.com", "idmsa.apple.com.example.net"].map((h) =>
        (globalThis as any).Classifier.isAllowlistedLoginHost(h),
      ),
    );
    expect(got).toEqual([true, true, false, false]);
  });

  describe("finding a site's Sign in with Apple control", () => {
    const found = (html: string) => withBody(html, () => (globalThis as any).Classifier.appleSignInControl()?.id ?? null);

    it.each([
      ["a button", '<button id="hit">Sign in with Apple</button>'],
      ["other wording", '<button id="hit">  Continue   with Apple </button>'],
      ["an icon button named by its label", '<button id="hit" aria-label="Log in with Apple"><svg width="20" height="20"></svg></button>'],
      ["a role=button", '<div id="hit" role="button" style="height:30px">Sign up with Apple</div>'],
      ["Apple's own script's element", '<div id="appleid-signin" data-color="black" style="height:30px"></div>'],
      ["a link to Apple's sign-in in any language", '<a id="hit" href="https://appleid.apple.com/auth/authorize?client_id=x">Mit Apple anmelden</a>'],
    ])("finds %s", async (_, html) => {
      expect(await found(html)).not.toBeNull();
    });

    it.each([
      ["another Apple product", "<button>Sign in with Apple Music</button>"],
      ["a mention in a sentence", "<button>Why we sign in with Apple devices</button>"],
      ["plain text", "<p>Sign in with Apple</p>"],
      ["a hidden button", '<button style="display:none">Sign in with Apple</button>'],
      ["a disabled button", "<button disabled>Sign in with Apple</button>"],
      ["another page on Apple's host", '<a href="https://appleid.apple.com/account/manage">Manage your Apple ID</a>'],
      ["a look-alike host", '<a href="https://appleid.apple.com.example.net/auth/authorize">Anmelden</a>'],
    ])("ignores %s", async (_, html) => {
      expect(await found(html)).toBeNull();
    });

    it("finds one inside a shadow root", async () => {
      const got = await withBody('<div id="host"></div>', () => {
        const root = document.getElementById("host")!.attachShadow({ mode: "open" });
        root.innerHTML = '<button id="hit">Continue with Apple</button>';
        return (globalThis as any).Classifier.appleSignInControl()?.id ?? null;
      });
      expect(got).toBe("hit");
    });
  });

  it.each([0, 1, 3])("fills the whole row when the user was on box %i", async (at) => {
    const got = await withBody(`<div data-at="${at}">` + '<input maxlength="1" style="width:48px">'.repeat(4) + "</div>", () => {
      const boxes = Array.from(document.querySelectorAll("input"));
      const start = Number(document.querySelector("div")!.dataset.at);
      (globalThis as any).Classifier.fillOneTimeCode(boxes[start], "4821");
      return boxes.map((b) => b.value);
    });
    expect(got).toEqual(["4", "8", "2", "1"]);
  });

  it("starts at the user's box when the row is longer than the code", async () => {
    const got = await withBody('<div>' + '<input maxlength="1" style="width:48px">'.repeat(6) + "</div>", () => {
      const boxes = Array.from(document.querySelectorAll("input"));
      (globalThis as any).Classifier.fillOneTimeCode(boxes[2], "4821");
      return boxes.map((b) => b.value);
    });
    expect(got).toEqual(["", "", "4", "8", "2", "1"]);
  });

  it("keeps a code in one box when wide boxes share a row", async () => {
    const got = await withBody(`<div style="display:flex">${'<input style="width:200px">'.repeat(4)}</div>`, () => {
      const boxes = Array.from(document.querySelectorAll("input"));
      (globalThis as any).Classifier.fillOneTimeCode(boxes[0], "123456");
      return boxes[0]!.value;
    });
    expect(got).toBe("123456");
  });

  it("sees into closed shadow roots once given a reader", async () => {
    const got = await withBody(`<x-login id="h"></x-login>`, () => {
      const c = (globalThis as any).Classifier;
      const host = document.getElementById("h")!;
      const root = host.attachShadow({ mode: "closed" });
      root.innerHTML = '<input name="username"><input type="password">';
      const before = c.allInputs().length;
      c.readShadowRootsWith((el: Element) => (el === host ? root : null));
      const after = c.allInputs().length;
      root.querySelector("input")!.focus();
      return [before, after, c.deepFocused(host)?.getAttribute("name")];
    });
    expect(got).toEqual([0, 2, "username"]);
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
