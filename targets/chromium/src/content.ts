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
import { alphanumericPasswordFor, complexPasswordFor, strongPasswordFor, type Login } from "@icloudkeys/core";
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
    ["Use Complex Password", complexPasswordFor],
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

// per highlighted field: its own style from before the first highlight, and the current listener
const highlighted = new WeakMap<HTMLInputElement, { saved: (readonly [string, string, string])[]; restore: (e: Event) => void }>();

function highlight(fields: HTMLInputElement[], password: string): void {
  for (const f of fields) {
    const prev = highlighted.get(f);
    // a second pick must not save our own yellow as the field's style
    if (prev) f.removeEventListener("input", prev.restore, true);
    const saved = prev?.saved ?? Object.keys(HIGHLIGHT).map((k) => [k, f.style.getPropertyValue(k), f.style.getPropertyPriority(k)] as const);
    for (const [k, v] of Object.entries(HIGHLIGHT)) f.style.setProperty(k, v, "important");
    const restore = (e: Event) => {
      if (!e.isTrusted || f.value === password) return;
      for (const [k, v, prio] of saved) v ? f.style.setProperty(k, v, prio) : f.style.removeProperty(k);
      f.removeEventListener("input", restore, true);
      highlighted.delete(f);
    };
    highlighted.set(f, { saved, restore });
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
  // only a user name narrows the list; a password field holds a secret, not a prefix
  const value = field.value;
  const typed = isPasswordField(field) ? "" : value.trim().toLowerCase();
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
        // the helper can take seconds to hand over the password; the user name is already on
        // screen, so it goes in now and the password follows
        if (login.username && isUsernameField(field)) setFieldValue(field, login.username);
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
  if (seq !== offerSeq) return;
  offer = undefined;
  // the last field's list must not stay up over this one
  if (!res?.status.canFillCodes) return dropdown.close();
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
async function offerAlias(field: HTMLInputElement, shown?: Row[]): Promise<void> {
  const seq = ++offerSeq;
  const res = await send({ type: "hmeGenerate" });
  // focus moved on, or in-page AutoFill was turned off, while iCloud answered
  if (seq !== offerSeq || !settings.inPageAutoFill) return;
  if (!res?.ok || !res.address) {
    // a Refresh too soon after the last keeps the address already on screen
    return shown ? dropdown.show(field, shown) : aliasFailed(field, res);
  }
  const rows: Row[] = [
    {
      label: res.address,
      detail: "Use this address, forwarded to your inbox",
      icon: "mail",
      onPick: async () => {
        const used = await send({ type: "hmeReserve" });
        if (!used?.ok || !used.address) return aliasFailed(field, used);
        // the address now exists in iCloud; it goes in even over what was typed meanwhile
        setFieldValue(field, used.address);
      },
    },
    { label: "Refresh", detail: "Show a different address", icon: "refresh", footer: true, onPick: () => void offerAlias(field, rows) },
  ];
  dropdown.show(field, rows);
}

function aliasFailed(field: HTMLInputElement, res: Response | undefined): void {
  dropdown.show(field, [
    { label: "Hide My Email unavailable", detail: res && !res.ok ? res.error : undefined, icon: "mail", onPick: () => {} },
  ]);
}

/** `onFocus`: the field just gained focus, rather than the user asking for the list. */
function consider(field: EventTarget | null, onFocus = false): void {
  const kind = classifyFocus(field);
  if (!settings.inPageAutoFill) {
    // the toolbar popup still fills next to the field the user picked
    if (kind === "login") loginAnchor = field as HTMLInputElement;
    if (kind === "otp") codeAnchor = field as HTMLInputElement;
    return;
  }
  if (kind === "login" && settings.keyButton) keyButton.show(field as HTMLInputElement, () => pressKey(field as HTMLInputElement));
  else keyButton.hide();
  // a filled field (by us, or by the user) doesn't need the list in the way; a click, ArrowDown
  // or the key button still brings it up
  if (onFocus && (kind === "login" || kind === "otp") && (field as HTMLInputElement).value !== "") {
    if (kind === "login") loginAnchor = field as HTMLInputElement;
    else codeAnchor = field as HTMLInputElement;
    offerSeq++;
    offer = undefined;
    dropdown.close();
    return;
  }
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
    consider(field, true);
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
if (document.hasFocus()) consider(deepActive(), true);

document.addEventListener(
  "input",
  (e) => {
    if (!e.isTrusted) return;
    const field = e.composedPath()[0];
    // emptying a filled field brings back the list it skipped on focus
    if (!offer && field instanceof HTMLInputElement && field.value === "" && field === deepActive()) return consider(field);
    if (!offer || field !== offer.field) return;
    // the list covers what's being typed into a password or code field
    if (isPasswordField(offer.field) || isOtpField(offer.field)) return dropdown.close();
    render();
  },
  true,
);
document.addEventListener(
  "keydown",
  (e) => {
    // ArrowDown brings back a list closed with Escape, or one skipped because the field was filled
    if (!e.isTrusted || e.key !== "ArrowDown" || dropdown.open) return;
    const field = e.composedPath()[0];
    if (offer && field === offer.field) {
      render();
      if (dropdown.open) e.preventDefault();
    } else if (settings.inPageAutoFill && field instanceof HTMLInputElement && field === deepActive() && classifyFocus(field)) {
      e.preventDefault();
      consider(field);
    }
  },
  true,
);

function onFill(msg: Exclude<ToContent, { type: "signInCheck" }>): FillResult {
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
  if (msg?.type !== "fill" && msg?.type !== "fillCode" && msg?.type !== "signInCheck") return false;
  // only our own background; tabs.sendMessage from it carries no sender.tab
  if (sender.id !== chrome.runtime.id || sender.tab) {
    sendResponse({ filled: false, error: "forbidden" });
    return false;
  }
  if (msg.type === "signInCheck") {
    // a page that draws its form from script gets a moment to put it back up
    setTimeout(() => sendResponse({ filled: false, loginShown: loginShown(document) }), SIGN_IN_SETTLE_MS);
    return true;
  }
  sendResponse(onFill(msg));
  return false;
});

// A typed password is offered only once the sign-in worked, as browsers do: the login form goes
// away, on this page or by navigating (the background then asks the next page). A form still
// up after the wait, or a password typed again, is a failed attempt and nothing is offered.
const SIGN_IN_WAIT_MS = 8_000;
const SIGN_IN_SETTLE_MS = 1_000;
let stopWatching: (() => void) | undefined;

function loginShown(root: Document | ShadowRoot): boolean {
  const shown = (r: ParentNode) => Array.from(r.querySelectorAll('input[type="password"]')).some(isVisible);
  return shown(document) || (root !== document && shown(root));
}

function watchSignIn(root: Document | ShadowRoot): void {
  stopWatching?.();
  const started = Date.now();
  const settle = (ok: boolean) => {
    stop();
    void send({ type: "signInOutcome", ok });
  };
  const retyped = (e: Event) => {
    if (e.isTrusted && e.composedPath()[0] instanceof Element && isPasswordField(e.composedPath()[0] as Element)) settle(false);
  };
  const timer = setInterval(() => {
    if (!loginShown(root)) settle(true);
    else if (Date.now() - started > SIGN_IN_WAIT_MS) settle(false);
  }, 250);
  // a navigation under way: the next page answers for it, however long the server takes
  const stop = () => {
    clearInterval(timer);
    removeEventListener("input", retyped, true);
    removeEventListener("beforeunload", stop);
    stopWatching = undefined;
  };
  addEventListener("input", retyped, true);
  addEventListener("beforeunload", stop);
  stopWatching = stop;
}

const recent = (x: { at: number } | undefined, ms: number) => !!x && Date.now() - x.at < ms;

// fire and forget: awaiting would let a navigating submit kill the save
function maybeOfferSave(scope: ParentNode, from: Node): void {
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
  // a generated password is offered at once: losing it would lock the user out of the new account
  void send({ type: "offerSave", username: sub.username, password, isNew: sub.isNew || generated, afterSignIn: !generated });
  if (!generated) {
    const root = from.getRootNode();
    watchSignIn(root instanceof ShadowRoot ? root : document);
  }
}

document.addEventListener(
  "submit",
  (e) => {
    if (!e.isTrusted || !(e.target instanceof HTMLFormElement)) return;
    dropdown.close();
    maybeOfferSave(e.target, e.target);
  },
  true,
);
document.addEventListener(
  "click",
  (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const ctrl = e.target.closest('button, input[type=submit], input[type=button], [role="button"], a');
    if (isSubmitControl(ctrl)) maybeOfferSave((ctrl as HTMLButtonElement).form ?? document, ctrl!);
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
    if (t instanceof HTMLInputElement && (isPasswordField(t) || isUsernameField(t))) maybeOfferSave(t.form ?? document, t);
  },
  true,
);
