import { HOST_NAME, PasswordsClient, ProtocolError, type HelperPort } from "@icloudkeys/core";
import type { FillMessage, Request, Response, Status } from "./messages.ts";

function connectNative(): HelperPort {
  const port = chrome.runtime.connectNative(HOST_NAME);
  return {
    postMessage: (m) => port.postMessage(m),
    onMessage: (fn) => port.onMessage.addListener(fn),
    onDisconnect: (fn) =>
      port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError?.message ?? "";
        fn(/not found|forbidden|host/i.test(err) ? "no_helper" : "closed");
      }),
    disconnect: () => port.disconnect(),
  };
}

// an open native port keeps the service worker alive, so the session survives between popups
const client = new PasswordsClient({ connect: connectNative });

const status = (): Status => ({ state: client.state, hasChallenge: client.hasChallenge });

/** The hostname of the active tab's top frame, read from the browser, never from a page. */
async function activeTab(): Promise<{ id: number; host: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || !tab.url) throw new Error("no active tab");
  const url = new URL(tab.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("not a web page");
  return { id: tab.id, host: url.hostname.toLowerCase() };
}

async function handle(req: Request): Promise<Response> {
  await client.connect();
  switch (req.type) {
    case "status":
      return { ok: true, status: status() };
    case "pair":
      await client.requestChallenge({ ifNeeded: true });
      return { ok: true, status: status() };
    case "verify":
      await client.verifyPin(req.pin);
      return { ok: true, status: status() };
    case "logins": {
      const tab = await activeTab();
      return { ok: true, status: status(), host: tab.host, logins: await client.getLoginNames(tab.id, tab.host) };
    }
    case "fill": {
      // the tab may have navigated since the list was shown; query and pin to where it is now
      const tab = await activeTab();
      const cred = await client.getPassword(tab.id, tab.host, req.username);
      if (!cred) throw new Error("login not found for this site");
      const msg: FillMessage = { type: "fill", expectedHost: tab.host, username: cred.username, password: cred.password };
      const res = await chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 });
      if (!res?.filled) throw new Error(res?.error ?? "no login fields to fill on this page");
      return { ok: true, status: status() };
    }
  }
}

chrome.runtime.onMessage.addListener((req: Request, sender, sendResponse) => {
  // only our own popup talks to the background
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return false;
  handle(req)
    .then(sendResponse)
    .catch((e: unknown) =>
      sendResponse({
        ok: false,
        status: status(),
        error: e instanceof Error ? e.message : String(e),
        code: e instanceof ProtocolError ? e.code : undefined,
      } satisfies Response),
    );
  return true;
});
