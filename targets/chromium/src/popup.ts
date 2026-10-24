import type { Request, Response } from "./messages.ts";
import { NAME } from "./name.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const message = $("message");
const errorEl = $("error");
const pinForm = $<HTMLFormElement>("pin-form");
const pin = $<HTMLInputElement>("pin");
const pairBtn = $<HTMLButtonElement>("pair");
const list = $<HTMLUListElement>("logins");

$("title").textContent = NAME;
document.title = NAME;

const send = (req: Request) => chrome.runtime.sendMessage<Request, Response>(req);

function showError(text: string | null): void {
  errorEl.hidden = !text;
  errorEl.textContent = text ?? "";
}

async function render(res: Response): Promise<void> {
  if (!res.ok) showError(res.error);
  const { state, hasChallenge } = res.status;
  pinForm.hidden = state !== "needs_pin" || !hasChallenge;
  pairBtn.hidden = state !== "needs_pin" || hasChallenge;
  list.replaceChildren();

  if (state === "no_helper") {
    message.textContent =
      "Can't reach Apple's Passwords helper. Run icloudkeys-install; if it still fails, macOS may not accept this browser.";
  } else if (state === "disconnected") {
    message.textContent = "Not connected to the Passwords helper.";
  } else if (state === "needs_pin") {
    message.textContent = hasChallenge ? "Enter the 6-digit code your Mac is showing." : "Locked.";
    if (hasChallenge) pin.focus();
  } else {
    await renderLogins();
  }
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
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.textContent = login.username || "(no username)";
    btn.addEventListener("click", async () => {
      const r = await send({ type: "fill", username: login.username });
      if (r.ok) window.close();
      else showError(r.error);
    });
    li.append(btn);
    list.append(li);
  }
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

// ask for a code as soon as the popup opens while locked, as Apple's extension does
void (async () => {
  let res = await send({ type: "status" });
  if (res.ok && res.status.state === "needs_pin" && !res.status.hasChallenge) res = await send({ type: "pair" });
  await render(res);
})();
