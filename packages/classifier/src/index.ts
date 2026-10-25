// Login-field and one-time-code-field detection for the content script. Derived from
// open-passwords src/content.js (Apache-2.0), including its fixes for false offers on
// checkout/address forms, footer newsletter fields next to a login, and bare Continue/Next
// buttons. See NOTICE.
//
// Runs in the page's document, so it reads `document`, `location` and `window` directly.

const OTP_AUTOCOMPLETE = /one-time-code/i;
const OTP_HINT =
  /\b(otp|one[\s-]?time|verification|2fa|mfa|sms[\s-]?code|auth[\s-]?code|security[\s-]?code|passcode)\b/i;

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

export function isOtpField(el: HTMLInputElement): boolean {
  if (OTP_AUTOCOMPLETE.test(attr(el, "autocomplete"))) return true;
  if (el.inputMode === "numeric" && parseInt(el.getAttribute("maxlength") || "0", 10) === 1) return true;
  return OTP_HINT.test(attrBlob(el));
}

export function isPasswordField(el: Element): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.type === "password";
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
  if (field.form) return Array.from(field.form.querySelectorAll('input[type="password"]')).some(isVisible);
  if (Array.from(document.querySelectorAll('input[type="password"]')).some(isVisible)) return true;
  const root = field.getRootNode();
  if (root !== document && root instanceof ShadowRoot) {
    return Array.from(root.querySelectorAll('input[type="password"]')).some(isVisible);
  }
  return false;
}

function hasStrongIdentitySignal(el: HTMLInputElement): boolean {
  const ac = attr(el, "autocomplete");
  // wells fargo and nintendo mark their username box autocomplete=webauthn
  if (ac.includes("username") || ac.includes("email") || ac.includes("webauthn")) return true;
  if ((el.type || "text").toLowerCase() === "email") return true;
  return /\b(e[\s-]?mail|sign[\s-]?in[\s-]?id|log[\s-]?in[\s-]?id|user[\s-]?id|username|passkey)\b/i.test(attrBlob(el));
}

function isAddressAutofillContext(el: HTMLInputElement): boolean {
  const scope = el.form || document;
  return Array.from(scope.querySelectorAll("input, select")).some((i) => i !== el && ADDRESS_AC.test(attr(i, "autocomplete")));
}

/** Gates the two-step case, where no password field exists yet. */
function loginishContext(el: HTMLInputElement): boolean {
  if (isAddressAutofillContext(el)) return false;
  if (LOGINISH.test(location.hostname + location.pathname)) return true;
  const form = el.form;
  if (form && LOGINISH.test(form.getAttribute("action") || "")) return true;
  // only an explicit "sign in"/"log in" button counts: waitlists and onboarding use a bare
  // Continue/Next too. Real two-step logins set autocomplete=username and pass earlier.
  return Array.from((form || document).querySelectorAll("button, input[type=submit]")).some((b) =>
    /\b(sign[\s-]?in|log[\s-]?in)\b/i.test(b.textContent || (b as HTMLInputElement).value || ""),
  );
}

export function isUsernameField(el: Element): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement)) return false;
  if (isOtpField(el) || isSearchOrComboField(el)) return false;
  if (!["text", "email", "tel", ""].includes((el.type || "text").toLowerCase())) return false;
  // "E-mail address" contains "address", which NONLOGIN_HINT would reject
  if (hasStrongIdentitySignal(el)) return true;
  const blob = attrBlob(el);
  if (NONLOGIN_HINT.test(blob)) return false;
  return /\b(user|login|signin|sign[\s-]?in|loginid)\b/i.test(blob);
}

export function isLoginField(el: Element): el is HTMLInputElement {
  if (!isVisible(el)) return false;
  if (isPasswordField(el)) return true;
  if (!isUsernameField(el)) return false;

  // explicit autocomplete=username is intentional even when the password lives in another form
  if (attr(el, "autocomplete").includes("username")) return true;
  const form = el.form;
  // beats autocomplete=off, which some banks set to block autofill
  if (form && Array.from(form.querySelectorAll("input")).some(isPasswordField)) return true;
  if (form && attr(form, "autocomplete") === "off") return false;
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

/** Fills the username and password nearest `anchor`. Returns whether anything was filled. */
export function fillCredentials(username: string, password: string, anchor: HTMLInputElement | null): boolean {
  const pool = new Set(document.querySelectorAll("input"));
  const root = anchor?.getRootNode();
  if (root instanceof ShadowRoot) for (const i of root.querySelectorAll("input")) pool.add(i);
  const inputs = Array.from(pool).filter(isFillable);
  let passwords = inputs.filter(isPasswordField);
  let usernames = inputs.filter(isUsernameField);

  const anchorForm = anchor?.form;
  if (anchorForm) {
    const pwInForm = passwords.filter((p) => p.form === anchorForm);
    const userInForm = usernames.filter((u) => u.form === anchorForm);
    if (pwInForm.length) passwords = pwInForm;
    if (userInForm.length) usernames = userInForm;
  }

  let pw = passwords[0];
  if (anchor && passwords.length > 1) {
    const order = Array.from(document.querySelectorAll("input"));
    const at = order.indexOf(anchor);
    pw = passwords.reduce((best, p) => (Math.abs(order.indexOf(p) - at) < Math.abs(order.indexOf(best) - at) ? p : best));
  }

  let user: HTMLInputElement | undefined;
  if (username) {
    if (anchor && isUsernameField(anchor)) user = anchor;
    else if (usernames.length) {
      user = usernames[0];
      if (pw) {
        const before = usernames.filter((u) => u.compareDocumentPosition(pw!) & Node.DOCUMENT_POSITION_FOLLOWING);
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

/** A password field that wants a new password: sign-up, change, or reset. */
export function isNewPasswordField(el: Element): boolean {
  if (!isPasswordField(el)) return false;
  const ac = attr(el, "autocomplete");
  if (ac.includes("current-password")) return false;
  if (ac.includes("new-password")) return true;
  const scope = el.form ?? document;
  if (Array.from(scope.querySelectorAll('input[type="password"]')).filter(isVisible).length >= 2) return true;
  return Array.from(scope.querySelectorAll("button, input[type=submit], input[type=button]")).some((b) =>
    /\b(sign[\s-]?up|register|create[\s-]?(your[\s-]?)?account)\b/i.test(b.textContent || (b as HTMLInputElement).value || ""),
  );
}

/** An email field where a Hide My Email address makes sense: never a login's username. */
export function isEmailField(el: EventTarget | null): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement) || !isVisible(el) || el.disabled || el.readOnly) return false;
  const ac = attr(el, "autocomplete");
  if (ac.includes("username") || ac.includes("webauthn")) return false;
  if (el.type !== "email" && !ac.split(/\s+/).includes("email")) return false;
  // a sign-in form's email is a username, and a fresh alias would never match an account
  return !pageHasVisiblePassword(el) || Array.from((el.form ?? document).querySelectorAll("input")).some(isNewPasswordField);
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
  if (tag === "button" && (type === "" || type === "button")) return SUBMITY_LABEL.test(el.textContent ?? "") || SUBMITY_ATTR.test(ids);
  if (tag === "input" && type === "button") return SUBMITY_LABEL.test((el as HTMLInputElement).value) || SUBMITY_ATTR.test(ids);
  if (attr(el, "role") === "button" || tag === "a") return SUBMITY_LABEL.test(el.textContent ?? "");
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
  const inputs = Array.from(scope.querySelectorAll("input"));
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

  const before = (el: Element) => (el.compareDocumentPosition(firstPw) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  // toggled reset forms can leave a password value in a text field; it's never the username
  const pwValues = new Set(pws.map((p) => p.value));
  const usable = (i: HTMLInputElement) => !isPasswordish(i) && !!i.value && !pwValues.has(i.value.trim());

  const strict = inputs.filter((i) => isUsernameField(i) && usable(i));
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

/** Puts a generated password into `field` and the empty confirm fields of its form. */
export function fillNewPassword(field: HTMLInputElement, password: string): void {
  const targets = new Set([field]);
  for (const p of Array.from(document.querySelectorAll("input")).filter((i) => isPasswordField(i) && isFillable(i))) {
    if (!p.value && (!field.form || p.form === field.form)) targets.add(p);
  }
  for (const t of targets) {
    setFieldValue(t, password);
    everPassword.add(t);
  }
}

function otpBoxGroup(el: HTMLInputElement): HTMLInputElement[] | null {
  const scope = el.form ?? el.closest("div, section, fieldset") ?? document;
  const inputs = Array.from(scope.querySelectorAll("input")).filter((i) => isVisible(i) && !i.disabled && !i.readOnly);
  const single = inputs.filter((i) => i.getAttribute("maxlength") === "1");
  if (single.includes(el) && single.length >= 4) return single;
  // some sites clamp length in script, but still tag every box one-time-code
  const tagged = inputs.filter((i) => OTP_AUTOCOMPLETE.test(i.getAttribute("autocomplete") ?? ""));
  if (tagged.includes(el) && tagged.length >= 4) return tagged;
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
