import { HOST_NAME, PasswordsClient, type HelperPort } from "@icloudkeys/core";
import { HmeClient, dnrRules } from "@icloudkeys/hme";
import type { FillResult, ToContent } from "./messages.ts";
import { NAME } from "./name.ts";
import { createRouter } from "./router.ts";

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

// an open native port keeps the service worker alive, so the session survives between pages
const client = new PasswordsClient({ connect: connectNative });

// session rules are dropped on browser restart, so install them on every worker start
void chrome.declarativeNetRequest
  .updateSessionRules({ removeRuleIds: [1, 2], addRules: dnrRules(chrome.runtime.id) as chrome.declarativeNetRequest.Rule[] })
  .catch((e) => console.warn(`${NAME}: Hide My Email header rules not installed`, e));

const hme = new HmeClient({
  // the iCloud session lives in icloud.com cookies, which only go along with credentials
  fetch: (url, init) => fetch(url, { ...init, credentials: "include" }),
});

const handle = createRouter({
  client,
  hme,
  appName: NAME,
  extensionId: chrome.runtime.id,
  popupUrl: chrome.runtime.getURL("popup.html"),
  async activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  },
  async sendToFrame(tabId: number, frameId: number, msg: ToContent) {
    return chrome.tabs.sendMessage<ToContent, FillResult>(tabId, msg, { frameId });
  },
  async openPopup() {
    await chrome.action.openPopup();
  },
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then((res) => {
    if (res) sendResponse(res);
  });
  return true;
});

// pair once at startup so the first focused login field doesn't wait on the helper
void client.connect().catch(() => {});
