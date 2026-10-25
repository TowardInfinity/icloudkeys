// Safari's AutoFill key: a small button at the right edge of a focused login field that opens
// the suggestion list. Like the list, it lives in a closed shadow root and acts only on trusted input.

import { HOST_STYLE, mount, svg } from "./dropdown.ts";

const SIZE = 22;
const CSS = `
button { all: unset; box-sizing: border-box; display: grid; place-items: center; width: ${SIZE}px; height: ${SIZE}px;
  border-radius: 5px; color: #6e6e73; cursor: default; }
button:hover { background: rgba(0,0,0,.08); color: #0a84ff; }
.icon { width: 15px; height: 15px; }
`;

export class KeyButton {
  private host: HTMLElement | undefined;
  private anchor: HTMLInputElement | undefined;
  private readonly onMove = () => this.position();

  constructor(private readonly title: string) {
    addEventListener("scroll", this.onMove, true);
    addEventListener("resize", this.onMove);
  }

  show(anchor: HTMLInputElement, onPress: () => void): void {
    this.hide();
    // too narrow to share with the text
    if (anchor.getBoundingClientRect().width < 100) return;
    const host = document.createElement("icloudkeys-key");
    for (const [k, v] of Object.entries(HOST_STYLE)) host.style.setProperty(k, v, "important");
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    const button = document.createElement("button");
    button.setAttribute("aria-label", `${this.title} AutoFill`);
    button.title = this.title;
    button.innerHTML = svg("key");
    button.addEventListener("mousedown", (e) => {
      if (!e.isTrusted) return;
      // keep focus in the field
      e.preventDefault();
      onPress();
    });
    root.append(style, button);
    this.host = host;
    this.anchor = anchor;
    mount(host, anchor);
    this.position();
  }

  get field(): HTMLInputElement | undefined {
    return this.anchor;
  }

  hide(): void {
    this.host?.remove();
    this.host = undefined;
    this.anchor = undefined;
  }

  private position(): void {
    if (!this.host || !this.anchor) return;
    if (!this.anchor.isConnected) return this.hide();
    const r = this.anchor.getBoundingClientRect();
    this.host.style.setProperty("left", `${Math.round(r.right - SIZE - 6)}px`, "important");
    this.host.style.setProperty("top", `${Math.round(r.top + (r.height - SIZE) / 2)}px`, "important");
  }
}
