import { classifyFocus, fillCredentials, isLoginField } from "@icloudkeys/classifier";
import type { FillMessage } from "./messages.ts";

// the login field the user last focused; fills go next to it
let anchor: HTMLInputElement | null = null;

document.addEventListener(
  "focusin",
  (e) => {
    // focus inside a shadow root retargets to the host; composedPath has the real input
    const field = e.composedPath()[0] ?? e.target;
    if (classifyFocus(field) === "login") anchor = field as HTMLInputElement;
  },
  true,
);

chrome.runtime.onMessage.addListener((msg: FillMessage, sender, sendResponse) => {
  if (msg?.type !== "fill") return false;
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ filled: false, error: "forbidden" });
    return false;
  }
  // the background pinned the credential to this host; a navigation in between must not leak it
  if (location.hostname.toLowerCase() !== msg.expectedHost) {
    sendResponse({ filled: false, error: "page changed origin" });
    return false;
  }
  const target = anchor?.isConnected ? anchor : (Array.from(document.querySelectorAll("input")).find(isLoginField) ?? null);
  sendResponse({ filled: fillCredentials(msg.username, msg.password, target) });
  return false;
});
