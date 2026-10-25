// Options shared by the settings page and the content script, kept in chrome.storage.local.

export interface Settings {
  /** Offer the list when a login, sign-up or code field is focused. */
  inPageAutoFill: boolean;
  /** Draw the key button inside login fields. */
  keyButton: boolean;
  /** We turned the browser's own password and form AutoFill off, and own those settings. */
  browserAutoFillOff: boolean;
}

export const DEFAULTS: Settings = { inPageAutoFill: true, keyButton: true, browserAutoFillOff: false };

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS)).catch(() => ({}));
  return { ...DEFAULTS, ...pick(stored) };
}

export function saveSettings(patch: Partial<Settings>): Promise<void> {
  return chrome.storage.local.set(patch);
}

/** Calls `fn` with the full settings whenever any of them change. */
export function onSettingsChange(fn: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.keys(changes).some((k) => k in DEFAULTS)) void loadSettings().then(fn);
  });
}

// storage is writable by any of our pages; keep only known keys with the right type
function pick(stored: Record<string, unknown>): Partial<Settings> {
  const out: Partial<Settings> = {};
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    if (typeof stored[key] === "boolean") out[key] = stored[key];
  }
  return out;
}

// the browser's own savers and fillers that compete with our list
const BROWSER_AUTOFILL = ["passwordSavingEnabled", "autofillAddressEnabled", "autofillCreditCardEnabled"] as const;

/** Turns the browser's AutoFill off, or hands those settings back. Needs the optional `privacy` permission. */
export async function setBrowserAutoFill(off: boolean): Promise<void> {
  const services = chrome.privacy.services as unknown as Record<string, chrome.types.ChromeSetting<boolean> | undefined>;
  for (const name of BROWSER_AUTOFILL) {
    const setting = services[name];
    // some Chromium forks leave a service out
    if (!setting) continue;
    if (off) await setting.set({ value: false });
    else await setting.clear({});
  }
}
