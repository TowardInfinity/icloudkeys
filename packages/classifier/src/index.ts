// Login-field and one-time-code-field detection for the content script. Derived from
// open-passwords src/content.js (Apache-2.0), including its fixes for false offers on
// checkout/address forms, footer newsletter fields next to a login, and bare Continue/Next
// buttons. See NOTICE.
//
// Runs in the page's document, so it reads `document`, `location` and `window` directly.

const OTP_AUTOCOMPLETE = /one-time-code/i;
const OTP_HINT =
  /\b(otp|totp|one[\s-]?time|verification|2fa|mfa|sms[\s-]?code|auth[\s-]?code|security[\s-]?code|login[\s-]?code|magic[\s-]?code|passcode|authenticator|two[\s-]?factor|enter (the )?code)\b/i;
// matched against names split into words: totpPin, otpCode, app_otp, verification_pin, otc
const OTP_NAME = /\b(otp|totp|otc|2fa|mfa|(verification|auth|sms) (code|pin))\b/i;
const CARD_FIELD = /\b(cvv|cvc|csc|card)\b/i;
// these codes are saved nowhere a helper could read, so a list of TOTPs would only mislead
const RECOVERY_CODE = /\b(backup|recovery|scratch)\b/i;
// a masked box that isn't a site password: filling one would hand the password to the wrong field
const NOT_A_PASSWORD = /\b(cvv|cvc|csc|card|ssn\d*|tin\d*|tax|social security|(security|secret) (answer|question)|answer|digit \d+ of)\b/i;
const CURRENT_PASSWORD = /\b(current|old|existing)\b/i;
const NEW_PASSWORD = /\b(new|create|choose|set|register|registration|reg|signup|sign up|neues|nuevo|nueva|nouveau|nuovo)\b/i;
const REPEATED_PASSWORD = /\b(confirm|confirmation|repeat|retype|re enter|reenter|again|verify)\b/i;
const USER_WORD = /\b(user|usr|uid|login|logon|signin|sign in|loginid|account|member|identifier|identity|uname|netid)\b/i;
const PERSON_NAME = /\b(first|last|full|given|family|middle) ?name\b/i;
const NOT_AN_ID = /captcha|\b(surname|nick ?name|birth|dob|age)\b/i;
const WIDE_ID = /benutzer|usuario|utilisateur|identifiant|utente|gebruiker|anv[aä]ndar|логин|пользовател|ユーザー|ログイン|用户|用戶|账号|帳號|아이디|사용자|उपयोगकर्ता|ব্যবহারকারী/i;

// the page's own words for each. \b only knows ASCII, so other scripts match anywhere.
const SIGN_IN = /\b(sign[\s_-]?in|log[\s_-]?in|logon)\b|anmelden|einloggen|iniciar sesi[oó]n|connexion|se connecter|accedi|inloggen|logga in|войти|вход|ログイン|登录|登入|로그인|लॉग इन|साइन इन|लॉगिन|লগ ইন|সাইন ইন/i;
const SIGN_UP = /\b(sign[\s_-]?up|register|registration|join|create[\s_-]?(an[\s_-]?|your[\s_-]?)?account|get[\s_-]?started)\b|registrieren|konto erstellen|registrarse|crear (una )?cuenta|inscription|s'inscrire|cr[eé]er un compte|registrati|registreren|skapa konto|зарегистр|регистрация|新規登録|会員登録|注册|註冊|회원가입|साइन अप|रजिस्टर|পঞ্জীকরণ|নিবন্ধন|সাইন আপ/i;

const NONLOGIN_HINT =
  /\b(search|find|filter|query|lookup|tag|tags|mention|comment|reply|message|chat|post|caption|note|subject|topic|recipient|address|street|city|state|zip|postal|country|first[\s-]?name|last[\s-]?name|full[\s-]?name|company|title|url|website|coupon|promo|voucher|gift[\s-]?card|amount|quantity|qty|price|card[\s-]?number|cvv|cvc|expiry|account[\s-]?(?:number|no|holder)|routing|iban|invoice|order|tracking|keyword)\b/i;

const LOGINISH = /log[\s_-]?in|sign[\s_-]?in|auth|session|sso|oauth|account|idp|passport/i;

// checkout/shipping forms belong to address autofill: an email field plus a Continue button
// there is not the first page of a two-step login
const ADDRESS_AC =
  /\b(address-line[12]|street-address|postal-code|address-level[1234]|country(-name)?|(given|family|additional)-name|shipping|billing|cc-)/i;

// login widgets commonly embedded cross-origin; any other cross-origin frame is never offered
const IFRAME_LOGIN_ALLOWLIST = [
  "accounts.google.com", "adyen.com", "affirm.com", "afterpay.com", "amazon.com", "amazoncognito.com",
  "appleid.apple.com", "atlassian.com", "auth0.com", "authkit.app", "awsapps.com", "b2clogin.com",
  "beyondidentity.com", "cash.app", "ciamlogin.com", "clearpay.co.uk", "clerk.accounts.dev", "clerk.com",
  "corbado.io", "cyberark.cloud", "delinea.app", "descope.com", "descope.io", "discord.com",
  "dropbox.com", "duosecurity.com", "dynamicauth.com", "facebook.com", "finicity.com", "force.com",
  "forgeblocks.com", "forgerock.com", "forgerock.io", "frontegg.com", "fusionauth.io", "github.com",
  "gitlab.com", "hanko.io", "idaptive.app", "jumpcloud.com", "kakao.com", "kinde.com", "klarna.com",
  "line.me", "link.com", "linkedin.com", "live.com", "loginradius.com", "magic.link",
  "microsoftonline.com", "mojoauth.com", "moneydesktop.com", "naver.com", "okta-emea.com", "okta.com",
  "oktapreview.com", "onelogin.com", "openlogin.com", "ory.sh", "oryapis.com", "paypal.com",
  "phasetwo.io", "ping-eng.com", "pingidentity.com", "pingone.com", "plaid.com", "privy.io",
  "propelauth.com", "propelauthtest.com", "razorpay.com", "reddit.com", "sailpoint.com", "salesforce.com",
  "secureauth.com", "securid.com", "shop.app", "shopify.com", "slack.com", "spotify.com", "stripe.com",
  "stytch.com", "supertokens.com", "tink.com", "transmitsecurity.io", "truelayer.com", "twitch.tv",
  "twitter.com", "userfront.com", "venmo.com", "verify.ibm.com", "vk.com", "web3auth.io", "workos.com",
  "x.com", "xecurify.com", "yahoo.com", "yandex.com", "yandex.ru", "zitadel.cloud",
];

// a show-password toggle flips type to text, which would otherwise hide the field
const everPassword = new WeakSet<HTMLInputElement>();

const attr = (el: Element, name: string) => (el.getAttribute(name) || "").toLowerCase();

function attrBlob(el: HTMLInputElement): string {
  // some logins (snapchat) leave the input bare and label it via <label> or aria-labelledby
  let labelText = "";
  try {
    if (el.labels?.length) labelText = Array.from(el.labels, (l) => l.textContent).join(" ");
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      labelText +=
        " " + lb.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent || "").join(" ");
    }
  } catch {}
  return [el.name, el.id, el.getAttribute("aria-label"), el.placeholder, el.getAttribute("autocomplete"), labelText]
    .filter(Boolean)
    .join(" ");
}

const splitWords = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");

function hasCardNearby(el: HTMLInputElement): boolean {
  return allInputs(formAround(el) ?? document).some((i) => /\bcc-/.test(attr(i, "autocomplete")) || /\bcard\b/i.test(splitWords(attrBlob(i))));
}

export function isOtpField(el: HTMLInputElement): boolean {
  const ac = attr(el, "autocomplete");
  if (OTP_AUTOCOMPLETE.test(ac)) return true;
  if (/\bcc-/.test(ac)) return false;
  const named = splitWords(attrBlob(el));
  if (RECOVERY_CODE.test(named) && !/\bauthenticator\b/i.test(named)) return false;
  // a masked "passcode" labelled Password is the site's password, but a bank's OTP may say one-time password
  if (el.type === "password" && /\bpass ?word\b/i.test(named) && !/one[\s-]?time|\botp\b/i.test(named)) return false;
  if (el.inputMode === "numeric" && parseInt(el.getAttribute("maxlength") || "0", 10) === 1) return true;
  const blob = attrBlob(el);
  const words = splitWords(blob);
  // a card's "security code" is not a sign-in code
  if (CARD_FIELD.test(words) || (/security[\s-]?code/i.test(words) && hasCardNearby(el))) return false;
  return OTP_HINT.test(blob) || OTP_NAME.test(words);
}

export function isPasswordField(el: Element): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.type === "password";
}

function isLoginPassword(el: Element): el is HTMLInputElement {
  if (!isPasswordField(el) || /\bcc-/.test(attr(el, "autocomplete"))) return false;
  const words = splitWords(attrBlob(el));
  return /\bpass ?word\b/i.test(words) || !NOT_A_PASSWORD.test(words);
}

export function isPasswordish(el: Element): boolean {
  if (!(el instanceof HTMLInputElement)) return false;
  if (el.type === "password" || everPassword.has(el)) return true;
  if (!["text", ""].includes((el.type || "text").toLowerCase())) return false;
  if (attr(el, "autocomplete").includes("password")) return true;
  return /passw|pwd/i.test(attrBlob(el));
}

function isSearchOrComboField(el: HTMLInputElement): boolean {
  const role = attr(el, "role");
  if (role === "searchbox" || role === "combobox") return true;
  if ((el.type || "").toLowerCase() === "search") return true;
  if (attr(el, "enterkeyhint") === "search") return true;
  return ["list", "both", "inline"].includes(attr(el, "aria-autocomplete"));
}

export function isVisible(el: Element): boolean {
  if (!el.isConnected) return false;
  const s = getComputedStyle(el);
  if ((el as HTMLElement).offsetParent === null && s.position !== "fixed") return false;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  return s.visibility !== "hidden" && s.display !== "none" && parseFloat(s.opacity) >= 0.1;
}

/**
 * Whether a fill may write into `el`. Hidden fields are fine (sites keep a hidden username
 * for password managers); the clickjacking shapes are not: tiny, transparent, or far offscreen.
 */
export function isFillable(el: Element): boolean {
  if (!el.isConnected) return false;
  const s = getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return true;
  if ((el as HTMLElement).offsetParent === null && s.position !== "fixed") return true;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  if (parseFloat(s.opacity) < 0.1) return false;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) {
    // below the fold is legitimate; only far-offscreen coordinates are hostile
    if (r.left < -1000 || r.top < -1000 || r.left > vw + 5000) return false;
  }
  return true;
}

function pageHasVisiblePassword(field: HTMLInputElement): boolean {
  // a field in a <form> must not borrow a password from an unrelated form elsewhere on the
  // page; formless SPA logins still look page-wide
  return allInputs(formScope(field) ?? document).some((i) => i.type === "password" && isVisible(i));
}

function hasStrongIdentitySignal(el: HTMLInputElement): boolean {
  const ac = attr(el, "autocomplete");
  // wells fargo and nintendo mark their username box autocomplete=webauthn
  if (ac.includes("username") || ac.includes("email") || ac.includes("webauthn")) return true;
  if ((el.type || "text").toLowerCase() === "email") return true;
  const blob = attrBlob(el);
  return WIDE_ID.test(blob) || /\b((e[\s-]?)?mail|sign[\s-]?in[\s-]?id|log[\s-]?in[\s-]?id|user[\s-]?id|user ?name|passkey)\b/i.test(splitWords(blob));
}

function isAddressAutofillContext(el: HTMLInputElement): boolean {
  const scope = el.form || document;
  return Array.from(scope.querySelectorAll("input, select")).some((i) => i !== el && ADDRESS_AC.test(attr(i, "autocomplete")));
}

/** Gates the two-step case, where no password field exists yet. */
function loginishContext(el: HTMLInputElement): boolean {
  if (isAddressAutofillContext(el)) return false;
  if (LOGINISH.test(location.hostname + location.pathname)) return true;
  if (el.form && LOGINISH.test(el.form.getAttribute("action") || "")) return true;
  // only an explicit "sign in"/"log in" button counts: waitlists and onboarding use a bare
  // Continue/Next too. Real two-step logins set autocomplete=username and pass earlier.
  return Array.from((formScope(el) ?? document).querySelectorAll("button, input[type=submit]")).some((b) => SIGN_IN.test(b.textContent || (b as HTMLInputElement).value || ""));
}

const isTextBox = (i: HTMLInputElement) => ["text", "email", "tel", ""].includes((i.type || "text").toLowerCase());

/** "named" says it's an ID; "unnamed" could be one, if it sits right above a sign-in's password. */
function idEvidence(el: Element): "named" | "unnamed" | null {
  if (!(el instanceof HTMLInputElement)) return null;
  if (isOtpField(el)) return null;
  // att and directv mark their username box type=search
  if (attr(el, "autocomplete").includes("username")) return "named";
  if (isSearchOrComboField(el)) return null;
  if (!isTextBox(el)) return null;
  const words = splitWords(attrBlob(el));
  if (PERSON_NAME.test(words)) return null;
  // "E-mail address" contains "address", which NONLOGIN_HINT would reject
  if (hasStrongIdentitySignal(el)) return "named";
  if (NONLOGIN_HINT.test(words) || NOT_AN_ID.test(words)) return null;
  return USER_WORD.test(words) ? "named" : "unnamed";
}

export function isUsernameField(el: Element): el is HTMLInputElement {
  const evidence = idEvidence(el);
  return evidence === "named" || (evidence === "unnamed" && isBoxAbovePassword(el as HTMLInputElement));
}

/** The box directly above a sign-in's password is its ID, whatever the site calls it. */
function isBoxAbovePassword(el: HTMLInputElement): boolean {
  if (!isVisible(el)) return false;
  const boxes = allInputs(fieldScope(el)).filter((i) => isVisible(i) && (i.type === "password" || isTextBox(i)));
  const next = boxes[boxes.indexOf(el) + 1];
  return !!next && isLoginPassword(next) && !isNewPasswordField(next);
}

export function isLoginField(el: Element): el is HTMLInputElement {
  if (!isVisible(el)) return false;
  if (isPasswordField(el)) return isLoginPassword(el);
  if (!isUsernameField(el)) return false;

  // explicit autocomplete=username is intentional even when the password lives in another form
  if (attr(el, "autocomplete").includes("username")) return true;
  const form = formScope(el);
  // beats autocomplete=off, which some banks set to block autofill
  if (form && allInputs(form).some(isLoginPassword)) return true;
  if (el.form && attr(el.form, "autocomplete") === "off") return false;
  if (pageHasVisiblePassword(el)) return true;
  return hasStrongIdentitySignal(el) && loginishContext(el);
}

function isAllowlistedLoginHost(host: string): boolean {
  host = host.toLowerCase();
  return IFRAME_LOGIN_ALLOWLIST.some((d) => host === d || host.endsWith("." + d));
}

/** Top frames, same-origin frames, and known embedded login providers. */
export function frameIsSafe(): boolean {
  if (window === window.top) return true;
  if (isAllowlistedLoginHost(location.hostname)) return true;
  try {
    return location.origin === window.top!.location.origin;
  } catch {
    return false;
  }
}

export type FieldKind = "otp" | "login";

/**
 * What to offer when `el` gains focus, or `null` for nothing. One-time-code fields are
 * checked first so a password-typed OTP box never gets a login offer.
 */
export function classifyFocus(el: EventTarget | null): FieldKind | null {
  if (!(el instanceof HTMLInputElement)) return null;
  if (el.type === "password") everPassword.add(el);
  if (isOtpField(el)) return isVisible(el) && frameIsSafe() ? "otp" : null;
  if (!isLoginField(el)) return null;
  return frameIsSafe() ? "login" : null;
}

/** Sets a value so React/Vue-controlled inputs see it, via the native setter plus events. */
export function setFieldValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Every input in page order, through open shadow roots: reddit gives each field its own root. */
export function allInputs(root: ParentNode = document): HTMLInputElement[] {
  const inputs: HTMLInputElement[] = [];
  for (const el of root.querySelectorAll("*")) {
    if (el instanceof HTMLInputElement) inputs.push(el);
    const inner = shadowOf(el);
    if (inner) inputs.push(...allInputs(inner));
  }
  return inputs;
}

let readClosedRoot: (el: Element) => ShadowRoot | null = () => null;

/** Only an extension API can open a closed root, so the content script hands one in. */
export function readShadowRootsWith(read: (el: Element) => ShadowRoot | null): void {
  readClosedRoot = read;
}

// only custom elements are asked, so the extension API isn't called for every node on a page
const shadowOf = (el: Element) => el.shadowRoot ?? (el.localName.includes("-") ? readClosedRoot(el) : null);

/** The field really focused: focus inside a closed root reports only the outermost host. */
export function deepFocused(target: EventTarget | null): EventTarget | null {
  let el = target;
  while (el instanceof Element) {
    const inner = shadowOf(el)?.activeElement;
    if (!inner) break;
    el = inner;
  }
  return el;
}

/** The form around a field or button; `.form` can't see past the element's own shadow root. */
export function formAround(el: Element): HTMLFormElement | null {
  const own = (el as HTMLInputElement).form;
  if (own) return own;
  let root = el.getRootNode();
  while (root instanceof ShadowRoot) {
    const form = root.host.closest("form");
    if (form) return form;
    root = root.host.getRootNode();
  }
  return null;
}

/** The smallest block around a field that holds a submit control, for forms that don't bound it. */
function submitGroup(el: Element): ParentNode | null {
  for (let at = composedParent(el); at && at !== document.body && at !== document.documentElement; at = composedParent(at)) {
    const controls = at.querySelectorAll("button, input[type=submit], input[type=image], [role=button]");
    if (Array.from(controls).some((c) => isVisible(c) && isSubmitControl(c))) return at;
  }
  return null;
}

const composedParent = (el: Element): Element | null => {
  const root = el.getRootNode();
  return el.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
};

/** Some sites (ASP.NET above all) wrap the whole page in one form, which says nothing. */
function isPageWrapper(form: HTMLFormElement): boolean {
  // a login card has its own header and footer, but with no fields in them
  return !!form.querySelector("nav, main, aside, :scope header input, :scope footer input");
}

/** The form a field belongs to, narrowed when that form is the whole page. */
function formScope(el: Element): ParentNode | null {
  const form = formAround(el);
  return form && isPageWrapper(form) ? (submitGroup(el) ?? form) : form;
}

const fieldScope = (el: Element): ParentNode => formScope(el) ?? submitGroup(el) ?? document;

function hitAt(x: number, y: number): Element | null {
  let hit = document.elementFromPoint(x, y);
  for (let root = hit && shadowOf(hit); root; root = hit && shadowOf(hit)) {
    const inner = root.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return hit;
}

/** The element a click really landed on: a click inside a closed root reports only its host. */
export function clickedElement(e: MouseEvent): EventTarget | null {
  const target = e.composedPath()[0] ?? null;
  return target instanceof Element && !target.shadowRoot && shadowOf(target) ? hitAt(e.clientX, e.clientY) : target;
}

export function holds(outer: Element, el: Element): boolean {
  for (let at: Element | null = el; at; at = composedParent(at)) if (at === outer) return true;
  return false;
}

/** Hidden under another element, at the middle and all four corners: not just a label or an icon. */
function isCovered(el: HTMLInputElement): boolean {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const [dx, dy] = [r.width / 10, r.height / 10];
  const points = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + dx, r.top + dy], [r.right - dx, r.top + dy], [r.left + dx, r.bottom - dy], [r.right - dx, r.bottom - dy]] as const;
  return points.every(([x, y]) => {
    const hit = hitAt(x, y);
    // null is outside the viewport, where nothing can be told
    return !!hit && !holds(hit, el) && !holds(el, hit) && !(hit instanceof HTMLLabelElement && hit.control === el);
  });
}

function loginTargets(anchor: HTMLInputElement | null) {
  const order = allInputs();
  const inputs = order.filter(isFillable);
  // the user's own field is exempt: some sites unlock a field on focus
  const writable = (i: HTMLInputElement) => i === anchor || !(i.readOnly || i.disabled || isCovered(i));
  let passwords = inputs.filter(isLoginPassword).filter(writable);
  // only a box already right above a password gets the costly check, not every box on the page
  const boxes = order.filter((i) => isVisible(i) && (i.type === "password" || isTextBox(i)));
  const abovePassword = new Set(boxes.filter((_, n) => boxes[n + 1]?.type === "password"));
  let usernames = inputs
    .filter((i) => {
      const evidence = idEvidence(i);
      return evidence === "named" || (evidence === "unnamed" && abovePassword.has(i) && isBoxAbovePassword(i));
    })
    .filter(writable);

  const scope = anchor && formScope(anchor);
  if (scope) {
    const inside = new Set(allInputs(scope));
    const pwInForm = passwords.filter((p) => inside.has(p));
    const userInForm = usernames.filter((u) => inside.has(u));
    // never reach into another form: a two-step login's first page has no password to fill,
    // and the sign-up form beside it must not get one; only fields outside any form may join
    passwords = pwInForm.length ? pwInForm : passwords.filter((p) => !formAround(p));
    usernames = userInForm.length ? userInForm : usernames.filter((u) => !formAround(u));
  }
  return { order, passwords, usernames };
}

/** Whether a fill at `anchor` has a field to put a password in. */
export function hasPasswordTarget(anchor: HTMLInputElement): boolean {
  return loginTargets(anchor).passwords.length > 0;
}

/** Fills the username and password nearest `anchor`. Returns whether anything was filled. */
export function fillCredentials(username: string, password: string, anchor: HTMLInputElement | null): boolean {
  const { order, passwords, usernames } = loginTargets(anchor);

  let pw = passwords[0];
  if (anchor && passwords.length > 1) {
    const at = order.indexOf(anchor);
    pw = passwords.reduce((best, p) => (Math.abs(order.indexOf(p) - at) < Math.abs(order.indexOf(best) - at) ? p : best));
  }

  let user: HTMLInputElement | undefined;
  if (username) {
    if (anchor && isUsernameField(anchor)) user = anchor;
    else if (usernames.length) {
      user = usernames[0];
      if (pw) {
        // compareDocumentPosition has no real order across shadow roots
        const before = usernames.filter((u) => order.indexOf(u) < order.indexOf(pw!));
        if (before.length) user = before[before.length - 1];
      }
    }
  }

  let filled = false;
  if (user) {
    setFieldValue(user, username);
    filled = true;
  }
  if (password && pw) {
    setFieldValue(pw, password);
    everPassword.add(pw);
    filled = true;
  }
  return filled;
}

/** How strongly a form's own words say it's a sign-up: above zero yes, below zero a sign-in. */
function signupScore(scope: ParentNode): number {
  const said = (text: string, weight: number) => (SIGN_UP.test(text) ? weight : 0) - (SIGN_IN.test(text) ? weight : 0);
  const textOf = (b: Element) => b.textContent || (b as HTMLInputElement).value || "";
  const controls = Array.from(scope.querySelectorAll("button, input[type=submit], input[type=button], [role=button]")).filter(isVisible);
  // a login's Create account button is a way out of the form; its submit is what it does
  const main = controls.find((b) => attr(b, "type") === "submit") ?? controls.find((b) => b.localName === "button" && !b.hasAttribute("type"));
  let score = main ? said(textOf(main), 4) : 0;
  for (const b of controls) if (b !== main) score += said(textOf(b), 1);

  // innerText skips hidden text and scripts; a shadow root has only textContent
  const text = (scope as HTMLElement).innerText ?? (scope as Element).textContent ?? "";
  if (/forgot|lost your|remember me|trouble (signing|logging)/i.test(text)) score -= 3;
  if (/(don.?t|do not|need an|no) (have an? )?account|new (here|to|user)/i.test(text)) score -= 2;
  if (/already (have|registered|a member)|have an account/i.test(text)) score += 3;
  const words = allInputs(scope).map((i) => splitWords(attrBlob(i))).join(" ");
  if (/\b(first name|last name|full name|birth|confirm email)\b/i.test(words)) score += 2;

  for (const h of scope.querySelectorAll("h1, h2, h3, legend")) score += said(h.textContent ?? "", 2);
  const heading = document.querySelector("h1");
  if (heading && !(scope as Element).contains?.(heading)) score += said(heading.textContent ?? "", 1);
  // a value that's itself a link says where the page goes next, not what it is: /auth?next=/register
  const path = location.pathname + location.search.replace(/=(https?|%2f|\/)[^&]*/gi, "=");
  score += said(path, 3) - (/\bauth\b/i.test(path) ? 1 : 0);
  return score + said(document.title, 1);
}

/** A password field that wants a new password: sign-up, change, or reset. */
export function isNewPasswordField(el: Element): boolean {
  if (!isLoginPassword(el)) return false;
  const ac = attr(el, "autocomplete");
  // the autocomplete tag is left out: sites set new-password on logins to stop browsers filling them
  const named = (i: HTMLInputElement) => splitWords(attrBlob(i).replace(/(new|current)-password/gi, ""));
  if (CURRENT_PASSWORD.test(named(el))) return false;
  // twitch marks "Create a secure password" current-password, so the words go first
  if (NEW_PASSWORD.test(named(el))) return true;
  if (ac.includes("current-password")) return false;
  const scope = fieldScope(el);
  const others = allInputs(scope).filter((i) => i !== el && isLoginPassword(i) && isVisible(i));
  // current, new, confirm: only the first holds the password the site already knows
  if (others.length >= 2) return allInputs(scope).find((i) => isLoginPassword(i) && isVisible(i)) !== el;
  if (others.length === 1) {
    const other = others[0]!;
    if (ac.includes("new-password") || REPEATED_PASSWORD.test(named(el))) return true;
    return !(NEW_PASSWORD.test(named(other)) || attr(other, "autocomplete").includes("new-password"));
  }
  return signupScore(scope) + (ac.includes("new-password") ? 3 : 0) > 0;
}

export function isEmailish(el: HTMLInputElement): boolean {
  if (el.type === "email" || attr(el, "autocomplete").split(/\s+/).includes("email")) return true;
  return (el.type === "text" || el.type === "") && /e-?mail/i.test(attrBlob(el));
}

export type EmailPurpose = "signup" | "unclear";

/**
 * Why a new Hide My Email address could make sense in a field: a sign-up, or a form that doesn't
 * say what it is (newsletter, checkout, a two-step login's first page). `null` for a sign-in,
 * where a fresh alias matches no account. Sites often mark a sign-up email autocomplete=username,
 * so that alone doesn't rule one out.
 */
export function emailPurpose(el: EventTarget | null): EmailPurpose | null {
  if (!(el instanceof HTMLInputElement) || !isVisible(el) || el.disabled || el.readOnly || !isEmailish(el)) return null;
  const scope = fieldScope(el);
  // google keeps a hidden password field for managers beside a "Create account" button
  const newPassword = (i: HTMLInputElement) => isNewPasswordField(i) && (isVisible(i) || attr(i, "autocomplete").includes("new-password"));
  if (allInputs(scope).some(newPassword)) return "signup";
  const score = signupScore(scope);
  if (score !== 0) return score > 0 ? "signup" : null;
  return pageHasVisiblePassword(el) ? null : "unclear";
}

export function isEmailField(el: EventTarget | null): el is HTMLInputElement {
  return emailPurpose(el) !== null;
}

const SUBMITY_LABEL =
  /\b(sign[\s-]?in|sign[\s-]?up|log[\s-]?in|register|create[\s-]?account|save|update|reset|confirm|done|set|apply|activate|enroll|finish|proceed|verify|join|change[\s-]?password|continue|next|submit)\b/i;
// ids and names have no word boundaries ("findpwd", "loginBtn"), so these match bare substrings
const SUBMITY_ATTR = /pwd|passw|reset|submit|login|signin|confirm|continue|next|done|save|set|apply/i;

/** A control whose click likely submits the form around it, including script-driven buttons. */
export function isSubmitControl(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  const type = attr(el, "type");
  if ((tag === "button" || tag === "input") && type === "submit") return true;
  const ids = `${el.getAttribute("name") ?? ""} ${el.id}`;
  const says = (text: string) => SUBMITY_LABEL.test(text) || SIGN_IN.test(text) || SIGN_UP.test(text);
  if (tag === "button" && (type === "" || type === "button")) return says(el.textContent ?? "") || SUBMITY_ATTR.test(ids);
  if (tag === "input" && type === "button") return says((el as HTMLInputElement).value) || SUBMITY_ATTR.test(ids);
  if (attr(el, "role") === "button" || tag === "a") return says(el.textContent ?? "");
  return false;
}

export interface Submitted {
  username: string;
  password: string;
  allPasswords: string[];
  /** Two password fields or a new-password hint: a sign-up or a change, not a sign-in. */
  isNew: boolean;
}

/** The login a form is submitting, or null when there's no password in it. */
export function collectSubmitted(scope: ParentNode = document): Submitted | null {
  const inputs = allInputs(scope);
  // a show-password toggle leaves the field type=text at submit
  const pws = inputs.filter((i) => isPasswordish(i) && i.value);
  const firstPw = pws[0];
  if (!firstPw) return null;
  // with current, new and confirm fields, the repeated value is the new password
  const counts = new Map<string, number>();
  for (const p of pws) counts.set(p.value, (counts.get(p.value) ?? 0) + 1);
  const repeated = [...counts].find(([, n]) => n >= 2)?.[0];
  const marked = pws.find((p) => attr(p, "autocomplete").includes("new-password"))?.value;
  const password = repeated ?? marked ?? pws[pws.length - 1]!.value;

  const before = (el: HTMLInputElement) => inputs.indexOf(el) < inputs.indexOf(firstPw);
  // toggled reset forms can leave a password value in a text field; it's never the username
  const pwValues = new Set(pws.map((p) => p.value));
  const usable = (i: HTMLInputElement) => !isPasswordish(i) && !!i.value && !pwValues.has(i.value.trim());

  const strict = inputs.filter((i) => idEvidence(i) === "named" && usable(i));
  let user = strict.filter(before).at(-1) ?? strict[0];
  if (!user) {
    // reject junk so a reset form doesn't save "9" as the name
    user = inputs
      .filter((i) => {
        const v = i.value.trim();
        if (!usable(i) || isOtpField(i) || isSearchOrComboField(i) || NONLOGIN_HINT.test(attrBlob(i))) return false;
        if (!["text", "email", "tel", ""].includes(i.type)) return false;
        if (v.length < 3 || (/^\d+$/.test(v) && v.length < 6)) return false;
        return before(i);
      })
      .at(-1);
  }
  const isNew = pws.length >= 2 || inputs.some((p) => isPasswordish(p) && attr(p, "autocomplete").includes("new-password"));
  return { username: user?.value.trim() ?? "", password, allPasswords: pws.map((p) => p.value), isNew };
}

/** The ID in a step that submits one without a password: the first page of a two-step login. */
export function submittedId(scope: ParentNode = document): string {
  const inputs = allInputs(scope);
  if (inputs.some((i) => isPasswordish(i) && isVisible(i))) return "";
  const ids = inputs.filter((i) => i.value.trim() && (isLoginField(i) || emailPurpose(i) === "signup"));
  // the next page's save will trust this, so anything less than certain counts as nothing
  if (ids.length !== 1) return "";
  const context = `${splitWords(attrBlob(ids[0]!))} ${(fieldScope(ids[0]!) as HTMLElement).innerText ?? ""}`;
  return NEWSLETTER.test(context) ? "" : ids[0]!.value.trim();
}

const NEWSLETTER = /news ?letter|subscri|mailing list/i;
const EMAIL_ONLY = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The account a password or code step names on the page, or nothing if unclear. Use it only to
 * narrow a list: the page wrote this, so nothing is ever filled from it.
 */
export function shownAccount(field: Element): string | undefined {
  const tagged = document.querySelector("[data-profile-identifier]")?.textContent?.trim();
  if (tagged) return tagged;
  const scope = fieldScope(field);
  if (scope === document) return undefined;
  const found = new Set<string>();
  const walker = document.createTreeWalker(scope as Node, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent?.trim() ?? "";
    if (EMAIL_ONLY.test(text) && isVisible(walker.currentNode.parentElement!)) found.add(text.toLowerCase());
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/** Fills `password` into the field and its empty confirm fields, and returns every field filled. */
export function fillNewPassword(field: HTMLInputElement, password: string): HTMLInputElement[] {
  const targets = new Set([field]);
  const form = formAround(field);
  for (const p of allInputs(form ?? document).filter((i) => isPasswordField(i) && isFillable(i))) {
    if (!p.value) targets.add(p);
  }
  for (const t of targets) {
    setFieldValue(t, password);
    everPassword.add(t);
  }
  return [...targets];
}

export function otpBoxGroup(el: HTMLInputElement): HTMLInputElement[] | null {
  const inputs = allInputs(formAround(el) ?? document).filter((i) => isVisible(i) && !i.disabled && !i.readOnly);
  const single = inputs.filter((i) => i.getAttribute("maxlength") === "1");
  // some sites clamp length in script, but still tag every box one-time-code
  const tagged = inputs.filter((i) => OTP_AUTOCOMPLETE.test(i.getAttribute("autocomplete") ?? ""));
  const at = el.getBoundingClientRect();
  // others just draw the boxes: narrow, the same size, side by side
  const row = inputs
    .filter((i) => {
      const r = i.getBoundingClientRect();
      return r.width <= 80 && Math.abs(r.width - at.width) <= 4 && Math.abs(r.top - at.top) <= at.height / 2;
    })
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  for (const group of [single, tagged, row]) if (group.includes(el) && group.length >= 4) return group;
  return null;
}

/** Fills a code into one field, or across a row of single-character boxes starting at `field`. */
export function fillOneTimeCode(field: HTMLInputElement, code: string): void {
  const chars = code.replace(/[^A-Za-z0-9]/g, "").split("");
  const boxes = otpBoxGroup(field);
  if (!boxes) {
    setFieldValue(field, chars.join(""));
    return;
  }
  const start = Math.max(0, boxes.indexOf(field));
  chars.forEach((c, i) => {
    const box = boxes[start + i];
    if (!box) return;
    box.focus();
    setFieldValue(box, c);
    // some widgets advance focus on key events rather than input
    box.dispatchEvent(new KeyboardEvent("keydown", { key: c, bubbles: true }));
    box.dispatchEvent(new KeyboardEvent("keyup", { key: c, bubbles: true }));
  });
}
