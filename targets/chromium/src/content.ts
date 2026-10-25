import {
  classifyFocus,
  collectSubmitted,
  fillCredentials,
  fillNewPassword,
  fillOneTimeCode,
  frameIsSafe,
  isEmailField,
  isLoginField,
  isNewPasswordField,
  isOtpField,
  isPasswordField,
  isSubmitControl,
  isUsernameField,
  isVisible,
  setFieldValue,
} from "@icloudkeys/classifier";
import { alphanumericPassword, strongPassword } from "@icloudkeys/core";
import { Dropdown, type Row } from "./dropdown.ts";
import type { ContentRequest, FillResult, Response, ToContent } from "./messages.ts";
import { NAME } from "./name.ts";

const dropdown = new Dropdown(NAME);
// the field the user last focused; fills go next to it
let loginAnchor: HTMLInputElement | null = null;
let codeAnchor: HTMLInputElement | null = null;
// what we filled or generated, so a submit of it isn't offered as a new login
let lastFill: { password: string; at: number } | undefined;
let lastGenerated: { password: string; at: number } | undefined;
let lastSave = { key: "", at: 0 };
let offerSeq = 0;

const send = (req: ContentRequest): Promise<Response | undefined> =>
  chrome.runtime.sendMessage<ContentRequest, Response>(req).catch(() => undefined);

function lockedRows(res: Response | undefined): Row[] | null {
  if (res?.status.state !== "needs_pin") return null;
  return [{ label: `Unlock ${NAME}`, detail: `Or click the ${NAME} toolbar icon`, onPick: () => void send({ type: "openPopup" }) }];
}

async function offerLogins(field: HTMLInputElement): Promise<void> {
  const seq = ++offerSeq;
  const res = await send({ type: "inlineLogins" });
  // focus moved on while the background answered
  if (seq !== offerSeq) return;
  // what the field is for comes first: a new password, then a new address, then saved logins
  const rows: Row[] = [];
  if (isNewPasswordField(field)) {
    for (const [label, make] of [
      ["Use strong password", strongPassword],
      ["Use password without special characters", alphanumericPassword],
    ] as const) {
      const password = make();
      rows.push({
        label,
        detail: password,
        onPick: () => {
          fillNewPassword(field, password);
          lastGenerated = { password, at: Date.now() };
        },
      });
    }
  }
  if (isEmailField(field)) rows.push(aliasRow(field));
  rows.push(...(lockedRows(res) ?? []));
  if (res?.ok && res.status.state === "unlocked") {
    for (const login of res.logins ?? []) {
      rows.push({
        label: login.username || "(no username)",
        detail: "Fill login",
        onPick: () => {
          loginAnchor = field;
          void send({ type: "inlineFill", username: login.username }).then((r) => {
            if (r && !r.ok) console.debug(`${NAME}: fill failed:`, r.error);
          });
        },
      });
    }
  }
  dropdown.show(field, rows);
}

async function offerCodes(field: HTMLInputElement): Promise<void> {
  const seq = ++offerSeq;
  const res = await send({ type: "inlineCodes" });
  if (seq !== offerSeq || !res?.status.canFillCodes) return;
  const rows: Row[] = lockedRows(res) ?? [];
  for (const c of res.ok ? (res.codes ?? []) : []) {
    rows.push({
      label: c.source === "totp" ? `Verification code${c.username ? ` for ${c.username}` : ""}` : "Code from Messages",
      detail: c.domain || undefined,
      onPick: () => {
        codeAnchor = field;
        void send({ type: "inlineFillCode", id: c.id });
      },
    });
  }
  dropdown.show(field, rows);
}

function aliasRow(field: HTMLInputElement): Row {
  return {
    label: "Hide My Email",
    detail: "Create a new iCloud address for this site",
    onPick: async () => {
      const res = await send({ type: "hmeCreate" });
      if (!res?.ok || !res.address) {
        dropdown.show(field, [{ label: "Hide My Email unavailable", detail: res && !res.ok ? res.error : undefined, onPick: () => {} }]);
        return;
      }
      if (!field.value) setFieldValue(field, res.address);
    },
  };
}

document.addEventListener(
  "focusin",
  (e) => {
    if (!e.isTrusted) return;
    // focus inside a shadow root retargets to the host; composedPath has the real input
    const field = e.composedPath()[0] ?? e.target;
    if (field === dropdown.field) return;
    const kind = classifyFocus(field);
    if (kind === "otp") {
      codeAnchor = field as HTMLInputElement;
      void offerCodes(codeAnchor);
    } else if (kind === "login" || (frameIsSafe() && isEmailField(field))) {
      if (kind === "login") loginAnchor = field as HTMLInputElement;
      void offerLogins(field as HTMLInputElement);
    } else {
      offerSeq++;
      dropdown.close();
    }
  },
  true,
);

function onFill(msg: ToContent): FillResult {
  // the background pinned the secret to this frame's host; a navigation in between must not leak it
  if (location.hostname.toLowerCase() !== msg.expectedHost) return { filled: false, error: "page changed origin" };
  if (!frameIsSafe()) return { filled: false, error: "refusing to fill a cross-origin frame" };
  if (msg.type === "fill") {
    const target = loginAnchor?.isConnected ? loginAnchor : (Array.from(document.querySelectorAll("input")).find(isLoginField) ?? null);
    const filled = fillCredentials(msg.username, msg.password, target);
    if (filled) lastFill = { password: msg.password, at: Date.now() };
    return { filled };
  }
  const target = codeAnchor?.isConnected
    ? codeAnchor
    : (Array.from(document.querySelectorAll("input")).find((i) => isOtpField(i) && isVisible(i)) ?? null);
  if (!target) return { filled: false, error: "no code field" };
  fillOneTimeCode(target, msg.code);
  return { filled: true };
}

chrome.runtime.onMessage.addListener((msg: ToContent, sender, sendResponse) => {
  if (msg?.type !== "fill" && msg?.type !== "fillCode") return false;
  // only our own background; tabs.sendMessage from it carries no sender.tab
  if (sender.id !== chrome.runtime.id || sender.tab) {
    sendResponse({ filled: false, error: "forbidden" });
    return false;
  }
  sendResponse(onFill(msg));
  return false;
});

const recent = (x: { at: number } | undefined, ms: number) => !!x && Date.now() - x.at < ms;

// fire and forget: awaiting would let a navigating submit kill the save
function maybeOfferSave(scope: ParentNode): void {
  if (!frameIsSafe()) return;
  const sub = collectSubmitted(scope);
  if (!sub) return;
  const generated = recent(lastGenerated, 10 * 60_000) && sub.allPasswords.includes(lastGenerated!.password);
  const password = generated ? lastGenerated!.password : sub.password;
  // a login we just filled, submitted unchanged, is not a save
  if (!generated && recent(lastFill, 5 * 60_000) && lastFill!.password === password) return;
  // one offer per click + submit + Enter burst
  const key = `${sub.username} ${password}`;
  if (key === lastSave.key && Date.now() - lastSave.at < 15_000) return;
  lastSave = { key, at: Date.now() };
  void send({ type: "offerSave", username: sub.username, password, isNew: sub.isNew || generated });
}

document.addEventListener(
  "submit",
  (e) => {
    if (!e.isTrusted || !(e.target instanceof HTMLFormElement)) return;
    dropdown.close();
    maybeOfferSave(e.target);
  },
  true,
);
document.addEventListener(
  "click",
  (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const ctrl = e.target.closest('button, input[type=submit], input[type=button], [role="button"], a');
    if (isSubmitControl(ctrl)) maybeOfferSave((ctrl as HTMLButtonElement).form ?? document);
  },
  true,
);
document.addEventListener(
  "keydown",
  (e) => {
    if (!e.isTrusted || e.key !== "Enter" || dropdown.open) return;
    const t = e.composedPath()[0];
    // formless logins submit from script on Enter, with no submit event
    if (t instanceof HTMLInputElement && (isPasswordField(t) || isUsernameField(t))) maybeOfferSave(t.form ?? document);
  },
  true,
);
