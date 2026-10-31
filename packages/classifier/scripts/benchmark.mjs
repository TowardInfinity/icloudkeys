// Scores the classifier against DuckDuckGo's labelled real-site forms. Local only: the forms are
// third-party markup, so they're downloaded to .cache at run time and never committed.
//   pnpm benchmark            compare with benchmark-baseline.json, fail if any score drops
//   pnpm benchmark --update   accept the current scores
//   FORM_CORPUS=<dir>         use a test-forms folder already on disk

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const CACHE = join(ROOT, ".cache/form-benchmark");
const BASELINE = join(HERE, "../benchmark-baseline.json");
const REPO = "https://github.com/duckduckgo/duckduckgo-autofill";
const PIN = "a9babaec0979181be8a5e942edc64b8535d1d4d6";

function corpus() {
  if (process.env.FORM_CORPUS) return process.env.FORM_CORPUS;
  const dir = join(CACHE, "ddg");
  if (!existsSync(join(dir, "test-forms/index.json"))) {
    mkdirSync(dir, { recursive: true });
    const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("remote", "add", "origin", REPO);
    git("sparse-checkout", "set", "test-forms");
    git("fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", PIN);
    git("checkout", "-q", "FETCH_HEAD");
  }
  return join(dir, "test-forms");
}

const NON_CREDENTIAL = /^(firstName|middleName|lastName|fullName|address|card|expiration|birthday)/;
const isPassword = (l) => l === "password" || l.startsWith("password.");
const isIdentity = (l) => l === "username" || l === "emailAddress" || l === "username OR emailAddress";
// "username OR emailAddress" on a sign-up is often a screen name, where no alias makes sense
const isEmail = (l) => l === "emailAddress";
const isLoginEmail = (l) => l === "emailAddress" || l === "username OR emailAddress";

// each score: which fields it's about, and what counts as right
const SCORES = {
  "login: password field is offered": { on: (f, l) => f === "login" && isPassword(l), ok: (r) => r.kind === "login" },
  "any: a current password is not taken for a new one": { on: (f, l) => l === "password.current", ok: (r) => !r.isNew },
  "login: id field is offered": { on: (f, l) => f === "login" && isIdentity(l), ok: (r) => r.kind === "login" },
  "login: password is not taken for a new one": { on: (f, l) => f === "login" && isPassword(l), ok: (r) => !r.isNew },
  "login: email gets no Hide My Email": { on: (f, l) => f === "login" && isLoginEmail(l), ok: (r) => r.purpose === null },
  "signup: new password is recognised": { on: (f, l) => f === "signup" && isPassword(l) && l !== "password.current", ok: (r) => r.isNew },
  "signup: email gets Hide My Email": { on: (f, l) => f === "signup" && isEmail(l), ok: (r) => r.purpose === "signup" },
  "any: name, address, card get no login offer": { on: (f, l) => NON_CREDENTIAL.test(l), ok: (r) => r.kind !== "login" },
  "any: name, address, card aren't taken for a code": { on: (f, l) => NON_CREDENTIAL.test(l), ok: (r) => !r.isOtp },
  "any: unlabelled inputs get no login offer": { on: (f, l) => l === "unknown", ok: (r) => r.kind !== "login" },
};

const dir = corpus();
const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
const bundle = (
  await build({
    entryPoints: [join(HERE, "../src/index.ts")],
    bundle: true,
    format: "iife",
    globalName: "Classifier",
    write: false,
    footer: { js: "globalThis.Classifier = Classifier;" },
  })
).outputFiles[0].text;

// the forms run with no scripts and no network: they're untrusted markup
const server = createServer((req, res) => {
  const entry = index[Number(new URL(req.url, "http://x").searchParams.get("i"))];
  res.setHeader("content-type", "text/html");
  res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
  res.end(`<!doctype html><title>${entry?.title ?? ""}</title><body>${entry ? readFileSync(join(dir, entry.html), "utf8") : ""}`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/form`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.route("**/*", (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));

const FILL_SCORE = "login: a fill lands in the right fields";
const tally = Object.fromEntries([FILL_SCORE, ...Object.keys(SCORES)].map((k) => [k, { right: 0, total: 0 }]));
const misses = [];
let hidden = 0;
for (let i = 0; i < index.length; i++) {
  const { html } = index[i];
  const family = /_signup/i.test(html) ? "signup" : /_login/i.test(html) ? "login" : "other";
  await page.goto(`${base}?i=${i}`, { waitUntil: "domcontentloaded" });
  await page.evaluate(bundle);
  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll("input[data-manual-scoring]")).map((el) => {
      const C = globalThis.Classifier;
      return {
        label: el.getAttribute("data-manual-scoring"),
        visible: C.isVisible(el),
        kind: C.classifyFocus(el),
        isNew: C.isNewPasswordField(el),
        purpose: C.emailPurpose(el),
        isOtp: C.isOtpField(el),
        attrs: `${el.type}|${el.name}|${el.id}|${el.autocomplete}|${el.placeholder}|${el.getAttribute("aria-label") ?? ""}`,
      };
    }),
  );
  if (family === "login") {
    // the outcome that matters: a pick from the password field lands in the right fields
    const fill = await page.evaluate(() => {
      const C = globalThis.Classifier;
      const labelled = (test) => Array.from(document.querySelectorAll("input[data-manual-scoring]")).filter((e) => C.isVisible(e) && test(e.getAttribute("data-manual-scoring")));
      const pw = labelled((l) => l === "password" || l === "password.current")[0];
      const ids = labelled((l) => l === "username" || l === "emailAddress" || l === "username OR emailAddress");
      if (!pw || !ids.length) return null;
      C.fillCredentials("U-VALUE", "P-VALUE", pw);
      const wrong = Array.from(document.querySelectorAll("input")).filter((e) => (e.value === "U-VALUE" && !ids.includes(e) && e.type !== "hidden" && C.isVisible(e)) || (e.value === "P-VALUE" && e.type !== "password"));
      return { ok: pw.value === "P-VALUE" && ids.some((e) => e.value === "U-VALUE") && !wrong.length, attrs: ids.map((e) => e.name || e.id).join(","), wrong: wrong.map((e) => e.name || e.id).join(",") };
    });
    if (fill) {
      tally[FILL_SCORE].total++;
      if (fill.ok) tally[FILL_SCORE].right++;
      else misses.push({ score: FILL_SCORE, html, label: "form", kind: null, isNew: false, purpose: null, attrs: `ids=${fill.attrs} wrong=${fill.wrong}` });
    }
  }
  for (const r of rows) {
    if (!r.visible) {
      hidden++;
      continue;
    }
    for (const [name, score] of Object.entries(SCORES)) {
      if (!score.on(family, r.label)) continue;
      tally[name].total++;
      if (score.ok(r)) tally[name].right++;
      else misses.push({ score: name, html, ...r });
    }
  }
}
await browser.close();
server.close();

mkdirSync(CACHE, { recursive: true });
writeFileSync(join(CACHE, "misses.json"), JSON.stringify(misses, null, 1));

const result = Object.fromEntries(Object.entries(tally).map(([k, v]) => [k, Number(((100 * v.right) / (v.total || 1)).toFixed(1))]));
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
let dropped = 0;
for (const [k, v] of Object.entries(tally)) {
  const was = baseline[k];
  const flag = was !== undefined && result[k] < was ? "  DROPPED" : "";
  if (flag) dropped++;
  console.log(`${String(result[k]).padStart(5)}%  ${v.right}/${v.total}  ${k}${was !== undefined ? `  (was ${was})` : ""}${flag}`);
}
console.log(`${index.length} forms, ${hidden} labelled fields not visible and skipped. Misses: ${join(CACHE, "misses.json")}`);
if (process.argv.includes("--update")) writeFileSync(BASELINE, JSON.stringify(result, null, 2) + "\n");
else if (dropped) process.exit(1);
