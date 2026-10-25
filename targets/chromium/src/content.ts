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
import { alphanumericPasswordFor, strongPasswordFor, type Login } from "@icloudkeys/core";
import { Dropdown, type Row } from "./dropdown.ts";
import { KeyButton } from "./keybutton.ts";
import type { ContentRequest, FillResult, Response, ToContent } from "./messages.ts";
import { NAME } from "./name.ts";
import { DEFAULTS, loadSettings, onSettingsChange } from "./settings.ts";

const dropdown = new Dropdown(NAME);
const keyButton = new KeyButton(NAME);
// the defaults hold until storage answers, so a field focused at load still gets its list
let settings = DEFAULTS;
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
  return [
    {
      label: "Enable Password AutoFill",
      detail: `Click here to allow ${NAME} to AutoFill your passwords.`,
      icon: "lock",
      onPick: () => void send({ type: "openPopup" }),
    },
  ];
}

/** What the focused field was offered, kept so typing can re-filter without asking again. */
interface Offer {
  field: HTMLInputElement;
  isLogin: boolean;
  res: Response | undefined;
  generated: Row[];
}
let offer: Offer | undefined;

async function offerLogins(field: HTMLInputElement, isLogin: boolean): Promise<void> {
  const seq = ++offerSeq;
  const res = await send({ type: isLogin ? "inlineLogins" : "inlineStatus" });
  // focus moved on while the background answered
  if (seq !== offerSeq) return;
  offer = { field, isLogin, res, generated: generatedRows(field, res) };
  render();
}

function render(): void {
  if (!offer) return;
  const rows = rowsFor(offer);
  if (rows.length) dropdown.show(offer.field, rows);
  else dropdown.close();
}

function generatedRows(field: HTMLInputElement, res: Response | undefined): Row[] {
  // while locked a save would be dropped, leaving the account with a password nothing stored
  if (!(res?.ok && res.status.state === "unlocked" && isNewPasswordField(field))) return [];
  const rules = { passwordrules: field.getAttribute("passwordrules"), minLength: field.minLength, maxLength: field.maxLength };
  const rows: Row[] = [];
  for (const [label, make] of [
    ["Use Strong Password", strongPasswordFor],
    ["Use Password Without Special Characters", alphanumericPasswordFor],
  ] as const) {
    let password: string | null;
    try {
      password = make(rules);
    } catch {
      // rules no password can meet; the user types their own
      password = null;
    }
    if (!password) continue;
    rows.push({
      label,
      detail: password,
      icon: "lock",
      onPick: () => {
        highlight(fillNewPassword(field, password), password);
        lastGenerated = { password, at: Date.now() };
      },
    });
  }
  return rows;
}

// Safari's strong-password yellow, until the user edits the password
const HIGHLIGHT = { "background-color": "#fff8c4", color: "#1d1d1f" };

function highlight(fields: HTMLInputElement[], password: string): void {
  for (const f of fields) {
    const saved = Object.keys(HIGHLIGHT).map((k) => [k, f.style.getPropertyValue(k), f.style.getPropertyPriority(k)] as const);
    for (const [k, v] of Object.entries(HIGHLIGHT)) f.style.setProperty(k, v, "important");
    const restore = (e: Event) => {
      if (!e.isTrusted || f.value === password) return;
      for (const [k, v, prio] of saved) v ? f.style.setProperty(k, v, prio) : f.style.removeProperty(k);
      f.removeEventListener("input", restore, true);
    };
    f.addEventListener("input", restore, true);
  }
}

// a typed "ali" finds alice@example.com, and so does "alice@"
function matches(username: string, typed: string): boolean {
  const u = username.toLowerCase();
  return u.startsWith(typed) || u.split("@")[0]!.startsWith(typed);
}

const siteOf = (login: Login) => (login.sites[0] ?? location.hostname).replace(/^(www|m)\./, "");

function rowsFor({ field, isLogin, res, generated }: Offer): Row[] {
  const typed = field.value.trim().toLowerCase();
  // what the field is for comes first: a new password, then a new address, then saved logins
  const rows: Row[] = [...generated];
  if (!typed && isEmailField(field)) {
    if (res?.status.canHideEmail) rows.push(aliasRow(field));
    // otherwise the feature is invisible and nothing says why
    else if (res?.status.hmeNeedsSignIn) rows.push(signInRow);
  }
  // an email field that isn't a login's (checkout, newsletter) never gets login rows
  if (!isLogin) return rows;
  const locked = lockedRows(res);
  if (locked) return [...rows, ...locked];
  if (!(res?.ok && res.status.state === "unlocked")) return rows;
  const logins = (res.logins ?? []).filter((l) => !typed || matches(l.username, typed));
  // typing past every saved login closes the list, as in Safari
  if (typed && !logins.length && !rows.length) return [];
  for (const login of logins) {
    rows.push({
      label: login.username || "no user name",
      detail: siteOf(login),
      icon: "key",
      onPick: () => {
        loginAnchor = field;
        void send({ type: "inlineFill", username: login.username }).then((r) => {
          if (r && !r.ok) console.debug(`${NAME}: fill failed:`, r.error);
        });
      },
    });
  }
  rows.push({
    label: "Open Passwords App",
    detail: res.logins?.length ? undefined : "Look up and create passwords.",
    icon: "app",
    footer: true,
    onPick: () => void send({ type: "inlineLaunch" }),
  });
  return rows;
}

async function offerCodes(field: HTMLInputElement): Promise<void> {
  const seq = ++offerSeq;
  const res = await send({ type: "inlineCodes" });
  if (seq !== offerSeq || !res?.status.canFillCodes) return;
  offer = undefined;
  const rows: Row[] = lockedRows(res) ?? [];
  for (const c of res.ok ? (res.codes ?? []) : []) {
    rows.push({
      icon: "code",
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

const signInRow: Row = {
  label: "Hide My Email",
  icon: "mail",
  detail: "Sign in to iCloud.com in this browser to use it",
  onPick: () => void window.open("https://www.icloud.com/", "_blank", "noopener"),
};

function aliasRow(field: HTMLInputElement): Row {
  return {
    label: "Hide My Email",
    detail: "Create a new iCloud address for this site",
    icon: "mail",
    onPick: () => void offerAlias(field),
  };
}

// as in Safari: show the address with Use and Refresh, and create nothing until Use
async function offerAlias(field: HTMLInputElement): Promise<void> {
  const res = await send({ type: "hmeGenerate" });
  if (!res?.ok || !res.address) return aliasFailed(field, res);
  const address = res.address;
  dropdown.show(field, [
    {
      label: address,
      detail: "Use this address, forwarded to your inbox",
      icon: "mail",
      onPick: async () => {
        const used = await send({ type: "hmeReserve" });
        if (!used?.ok || !used.address) return aliasFailed(field, used);
        if (!field.value) setFieldValue(field, used.address);
      },
    },
    { label: "Refresh", detail: "Show a different address", icon: "refresh", footer: true, onPick: () => void offerAlias(field) },
  ]);
}

function aliasFailed(field: HTMLInputElement, res: Response | undefined): void {
  dropdown.show(field, [
    { label: "Hide My Email unavailable", detail: res && !res.ok ? res.error : undefined, icon: "mail", onPick: () => {} },
  ]);
}

function consider(field: EventTarget | null): void {
  const kind = classifyFocus(field);
  if (!settings.inPageAutoFill) {
    // the toolbar popup still fills next to the field the user picked
    if (kind === "login") loginAnchor = field as HTMLInputElement;
    if (kind === "otp") codeAnchor = field as HTMLInputElement;
    return;
  }
  if (kind === "login" && settings.keyButton) keyButton.show(field as HTMLInputElement, () => pressKey(field as HTMLInputElement));
  else keyButton.hide();
  if (kind === "otp") {
    codeAnchor = field as HTMLInputElement;
    void offerCodes(codeAnchor);
  } else if (kind === "login" || (frameIsSafe() && isEmailField(field))) {
    if (kind === "login") loginAnchor = field as HTMLInputElement;
    void offerLogins(field as HTMLInputElement, kind === "login");
  } else {
    offerSeq++;
    offer = undefined;
    dropdown.close();
  }
}

document.addEventListener(
  "focusin",
  (e) => {
    if (!e.isTrusted) return;
    // focus inside a shadow root retargets to the host; composedPath has the real input
    const field = e.composedPath()[0] ?? e.target;
    if (field === dropdown.field) return;
    consider(field);
  },
  true,
);
// a click on the focused field brings back a list closed with Escape or a click elsewhere
document.addEventListener(
  "mousedown",
  (e) => {
    const field = e.composedPath()[0];
    if (e.isTrusted && !dropdown.open && field instanceof HTMLInputElement && field === deepActive()) consider(field);
  },
  true,
);

function pressKey(field: HTMLInputElement): void {
  if (dropdown.open && dropdown.field === field) dropdown.close();
  else if (offer?.field === field) render();
  else consider(field);
}

document.addEventListener(
  "focusout",
  (e) => {
    if (e.isTrusted && e.composedPath()[0] === keyButton.field) keyButton.hide();
  },
  true,
);

function deepActive(): Element | null {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

void loadSettings().then(applySettings);
onSettingsChange(applySettings);

function applySettings(next: typeof settings): void {
  settings = next;
  if (!settings.inPageAutoFill) {
    offerSeq++;
    offer = undefined;
    dropdown.close();
  }
  if (!settings.inPageAutoFill || !settings.keyButton) keyButton.hide();
}

// a field focused before we loaded (autofocus, a dialog's first input) gets no focusin
if (document.hasFocus()) consider(deepActive());

document.addEventListener(
  "input",
  (e) => {
    if (!e.isTrusted || !offer || e.composedPath()[0] !== offer.field) return;
    // the list covers what's being typed into a password or code field
    if (isPasswordField(offer.field) || isOtpField(offer.field)) return dropdown.close();
    render();
  },
  true,
);
document.addEventListener(
  "keydown",
  (e) => {
    // ArrowDown brings back a list closed with Escape
    if (!e.isTrusted || e.key !== "ArrowDown" || dropdown.open || !offer || e.composedPath()[0] !== offer.field) return;
    render();
    if (dropdown.open) e.preventDefault();
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
    // Enter on a picked row is the row's, not a submit
    if (!e.isTrusted || e.key !== "Enter" || dropdown.selecting) return;
    const t = e.composedPath()[0];
    // formless logins submit from script on Enter, with no submit event
    if (t instanceof HTMLInputElement && (isPasswordField(t) || isUsernameField(t))) maybeOfferSave(t.form ?? document);
  },
  true,
);
