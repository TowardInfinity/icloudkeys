import type { Response, UiRequest } from "./messages.ts";
import { NAME } from "./name.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const message = $("message");
const errorEl = $("error");
const pinForm = $<HTMLFormElement>("pin-form");
const pin = $<HTMLInputElement>("pin");
const pairBtn = $<HTMLButtonElement>("pair");
const list = $<HTMLUListElement>("logins");
const codesSection = $("codes-section");
const codesList = $<HTMLUListElement>("codes");
const actions = $("actions");
const newPasswordBtn = $<HTMLButtonElement>("new-password");
const hmeBtn = $<HTMLButtonElement>("hme");

$("title").textContent = NAME;
document.title = NAME;

const send = (req: UiRequest) => chrome.runtime.sendMessage<UiRequest, Response>(req);

function showError(text: string | null): void {
  errorEl.hidden = !text;
  errorEl.textContent = text ?? "";
}

function showValue(id: "shown-code" | "alias", value: string): void {
  $(id).hidden = false;
  $(id === "alias" ? "alias-value" : "code-value").textContent = value;
}

function button(label: string, onClick: () => void): HTMLLIElement {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  li.append(btn);
  return li;
}

async function render(res: Response): Promise<void> {
  if (!res.ok) showError(res.error);
  const { state, hasChallenge, canOpenNewPassword } = res.status;
  pinForm.hidden = state !== "needs_pin" || !hasChallenge;
  pairBtn.hidden = state !== "needs_pin" || hasChallenge;
  actions.hidden = state === "no_helper" || state === "disconnected";
  newPasswordBtn.hidden = !canOpenNewPassword;
  list.replaceChildren();
  codesList.replaceChildren();
  codesSection.hidden = true;

  if (state === "no_helper") {
    message.textContent =
      "Can't reach Apple's Passwords helper. Run icloudkeys-install; if it still fails, macOS may not accept this browser.";
  } else if (state === "disconnected") {
    message.textContent = "Not connected to the Passwords helper.";
  } else if (state === "needs_pin") {
    message.textContent = hasChallenge ? "Enter the 6-digit code your Mac is showing." : "Locked.";
    if (hasChallenge) pin.focus();
  } else {
    await Promise.all([renderLogins(), renderCodes()]);
  }
  void renderHme();
}

async function renderLogins(): Promise<void> {
  const res = await send({ type: "logins" });
  if (!res.ok) {
    message.textContent = "";
    return showError(res.error);
  }
  const logins = res.logins ?? [];
  message.textContent = logins.length ? `Logins for ${res.host}` : `No saved logins for ${res.host}.`;
  for (const login of logins) {
    list.append(
      button(login.username || "(no username)", async () => {
        const r = await send({ type: "fill", username: login.username });
        if (r.ok) window.close();
        else showError(r.error);
      }),
    );
  }
}

async function renderCodes(): Promise<void> {
  const res = await send({ type: "codes" });
  if (!res.ok || !res.codes?.length) return;
  codesSection.hidden = false;
  for (const c of res.codes) {
    const label = c.source === "totp" ? `Code for ${c.username || c.domain}` : `Code from Messages${c.domain ? ` (${c.domain})` : ""}`;
    codesList.append(
      button(label, async () => {
        const r = await send({ type: "fillCode", id: c.id });
        if (!r.ok) return showError(r.error);
        if (r.code) showValue("shown-code", r.code);
        else window.close();
      }),
    );
  }
}

const HME_REASONS: Record<string, string> = {
  "not-signed-in": "Hide My Email: sign in to icloud.com in this browser.",
  "no-icloud-plus": "Hide My Email needs iCloud+.",
  "rate-limited": "Hide My Email: iCloud is rate-limiting, try again shortly.",
};

async function renderHme(): Promise<void> {
  const res = await send({ type: "hmeStatus" });
  const available = res.ok && res.hme?.available === true;
  hmeBtn.disabled = !available;
  const note = $("hme-note");
  note.hidden = available;
  note.textContent = available ? "" : (HME_REASONS[(res.ok && res.hme?.reason) || ""] ?? "Hide My Email is unavailable.");
}

pairBtn.addEventListener("click", async () => {
  showError(null);
  await render(await send({ type: "pair" }));
});

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

$("open-app").addEventListener("click", () => void send({ type: "launch", mode: "search" }).then(() => window.close()));
newPasswordBtn.addEventListener("click", () => void send({ type: "launch", mode: "new" }).then(() => window.close()));
hmeBtn.addEventListener("click", async () => {
  showError(null);
  const res = await send({ type: "hmeCreate" });
  if (!res.ok || !res.address) return showError(res.ok ? "no address returned" : res.error);
  showValue("alias", res.address);
  await navigator.clipboard.writeText(res.address).catch(() => {});
});

// ask for a code as soon as the popup opens while locked, as Apple's extension does
void (async () => {
  let res = await send({ type: "status" });
  if (res.ok && res.status.state === "needs_pin" && !res.status.hasChallenge) res = await send({ type: "pair" });
  await render(res);
})();
