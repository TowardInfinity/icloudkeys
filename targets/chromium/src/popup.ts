import { svg, type Icon } from "./icons.ts";
import type { Response, UiRequest } from "./messages.ts";
import { NAME } from "./name.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const message = $("message");
const site = $("site");
const errorEl = $("error");
const pinForm = $<HTMLFormElement>("pin-form");
const pin = $<HTMLInputElement>("pin");
const pairBtn = $<HTMLButtonElement>("pair");
const loginsSection = $("logins-section");
const list = $<HTMLUListElement>("logins");
const codesSection = $("codes-section");
const codesList = $<HTMLUListElement>("codes");
const actions = $<HTMLUListElement>("actions");

$("title").textContent = NAME;
document.title = NAME;
// set here rather than in the HTML so the bundler leaves the copied icon alone
$<HTMLImageElement>("logo").src = "icons/icon-32.png";
$("settings").innerHTML = svg("gear");
$("pin-icon").innerHTML = svg("lock");

const send = (req: UiRequest) => chrome.runtime.sendMessage<UiRequest, Response>(req);

function showError(text: string | null): void {
  errorEl.hidden = !text;
  errorEl.textContent = text ?? "";
}

function showValue(id: "shown-code" | "alias", value: string): void {
  $(id).hidden = false;
  $(id === "alias" ? "alias-value" : "code-value").textContent = value;
}

function row(icon: Icon, label: string, detail: string, onClick: () => void): { li: HTMLLIElement; btn: HTMLButtonElement } {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.className = "row";
  btn.innerHTML = `${svg(icon)}<span class="text"><span class="label"></span><span class="detail"></span></span>`;
  btn.querySelector(".label")!.textContent = label;
  btn.querySelector(".detail")!.textContent = detail;
  btn.addEventListener("click", onClick);
  li.append(btn);
  return { li, btn };
}

async function render(res: Response): Promise<void> {
  if (!res.ok) showError(res.error);
  const { state, hasChallenge, canOpenNewPassword } = res.status;
  pinForm.hidden = state !== "needs_pin" || !hasChallenge;
  pairBtn.hidden = state !== "needs_pin" || hasChallenge;
  list.replaceChildren();
  codesList.replaceChildren();
  actions.replaceChildren();
  loginsSection.hidden = true;
  codesSection.hidden = true;
  actions.hidden = state !== "unlocked";

  if (state === "no_helper") {
    site.textContent = "Not connected";
    message.textContent =
      "Can't reach Apple's Passwords helper. Run icloudkeys-install; if it still fails, macOS may not accept this browser.";
  } else if (state === "disconnected") {
    site.textContent = "Not connected";
    message.textContent = "Not connected to the Passwords helper.";
  } else if (state === "needs_pin") {
    site.textContent = "Locked";
    message.textContent = hasChallenge ? "" : "Locked.";
    if (hasChallenge) pin.focus();
  } else {
    message.textContent = "";
    renderActions(canOpenNewPassword);
    await Promise.all([renderLogins(), renderCodes()]);
  }
}

// the code prompt's own line, under the lock
const pinPrompt = document.createElement("span");
pinPrompt.textContent = "Enter the verification code shown on your Mac.";
pinPrompt.className = "sub";
$("pin-icon").after(pinPrompt);

async function renderLogins(): Promise<void> {
  const res = await send({ type: "logins" });
  if (!res.ok) return showError(res.error);
  if (res.host) site.textContent = res.host;
  const logins = res.logins ?? [];
  loginsSection.hidden = false;
  if (!logins.length) {
    list.append(row("key", "No saved passwords", "for this website", () => {}).li);
    list.querySelector("button")!.disabled = true;
    return;
  }
  for (const login of logins) {
    const where = (login.sites[0] ?? res.host ?? "").replace(/^(www|m)\./, "");
    list.append(
      row("key", login.username || "No user name", where, async () => {
        const r = await send({ type: "fill", username: login.username });
        if (r.ok) window.close();
        else showError(r.error);
      }).li,
    );
  }
}

async function renderCodes(): Promise<void> {
  const res = await send({ type: "codes" });
  if (!res.ok || !res.codes?.length) return;
  codesSection.hidden = false;
  for (const c of res.codes) {
    const label = c.source === "totp" ? c.username || c.domain : "From Messages";
    const detail = c.source === "totp" ? c.domain : c.domain || "";
    codesList.append(
      row("code", label, detail, async () => {
        const r = await send({ type: "fillCode", id: c.id });
        if (!r.ok) return showError(r.error);
        if (r.code) showValue("shown-code", r.code);
        else window.close();
      }).li,
    );
  }
}

const HME_REASONS: Record<string, string> = {
  "not-signed-in": "Sign in to icloud.com in this browser to use it",
  "no-icloud-plus": "Needs iCloud+",
  "rate-limited": "iCloud is rate-limiting, try again shortly",
};

function renderActions(canOpenNewPassword: boolean): void {
  actions.append(row("app", "Open Passwords", "", () => void send({ type: "launch", mode: "search" }).then(() => window.close())).li);
  if (canOpenNewPassword) {
    actions.append(row("plus", "New Password…", "", () => void send({ type: "launch", mode: "new" }).then(() => window.close())).li);
  }
  const hme = row("mail", "Hide My Email", "", async () => {
    showError(null);
    const res = await send({ type: "hmeCreate" });
    if (!res.ok || !res.address) return showError(res.ok ? "no address returned" : res.error);
    showValue("alias", res.address);
    await navigator.clipboard.writeText(res.address).catch(() => {});
  });
  actions.append(hme.li);
  void renderHme(hme.btn);
}

async function renderHme(btn: HTMLButtonElement): Promise<void> {
  const res = await send({ type: "hmeStatus" });
  const available = res.ok && res.hme?.available === true;
  btn.disabled = !available;
  btn.querySelector(".detail")!.textContent = available
    ? "Create a new address"
    : (HME_REASONS[(res.ok && res.hme?.reason) || ""] ?? "Unavailable");
}

async function pair(): Promise<void> {
  showError(null);
  await render(await send({ type: "pair" }));
}
pairBtn.addEventListener("click", pair);

pinForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError(null);
  const res = await send({ type: "verify", pin: pin.value.trim() });
  pin.value = "";
  await render(res);
});
// the sixth digit submits, as Apple's own extension does
pin.addEventListener("input", () => {
  if (/^\d{6}$/.test(pin.value.trim())) pinForm.requestSubmit();
});

$("settings").addEventListener("click", () => void chrome.runtime.openOptionsPage());

// ask for a code as soon as the popup opens while locked, as Apple's extension does
void (async () => {
  let res = await send({ type: "status" });
  if (res.ok && res.status.state === "needs_pin" && !res.status.hasChallenge) res = await send({ type: "pair" });
  await render(res);
})();
