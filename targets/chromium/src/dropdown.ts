// The suggestion list shown under a focused field. It lives in a closed shadow root so the page
// can neither read nor restyle it, sits in the top layer so page dialogs can't cover it, and rows
// act only on trusted input.

import { svg, type Icon } from "./icons.ts";

export { svg, type Icon };

export interface Row {
  label: string;
  detail?: string;
  icon?: Icon;
  /** A quieter action row, such as "Open Passwords App". */
  footer?: boolean;
  onPick(): void;
}

const CSS = `
.box {
  --fg: #1d1d1f; --dim: rgba(0,0,0,.55); --band: rgba(100,100,100,.1); --rule: rgba(100,100,100,.14);
  box-sizing: border-box; min-width: 200px; max-width: 380px; overflow-y: auto; overscroll-behavior: contain;
  color: var(--fg); background: rgba(246,246,246,.86);
  -webkit-backdrop-filter: blur(20px) saturate(180%); backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid rgba(0,0,0,.16); border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0,0,0,.15), 0 8px 15px 6px rgba(0,0,0,.18);
  font: 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  text-align: left; direction: ltr; user-select: none;
}
@media (prefers-color-scheme: dark) {
  .box { --fg: #f5f5f7; --dim: rgba(255,255,255,.55); --band: rgba(0,0,0,.2); --rule: rgba(255,255,255,.08);
    background: rgba(38,38,40,.86); border-color: rgba(0,0,0,.6); }
}
.head { position: sticky; top: 0; display: flex; align-items: center; gap: 6px; padding: 5px 12px;
  font-size: 12px; font-weight: 500; color: var(--dim); background: var(--band); }
.head .icon { width: 13px; height: 13px; }
.row { display: flex; align-items: center; gap: 10px; box-sizing: border-box; min-height: 44px; padding: 2px 12px;
  border-top: 1px solid var(--rule); cursor: default; }
.head + .row { border-top: 0; }
.row.footer { min-height: 34px; }
.icon { flex: none; width: 16px; height: 16px; color: var(--dim); }
.text { display: flex; flex-direction: column; min-width: 0; }
.label, .detail { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.label { font-size: 14px; line-height: 20px; }
.detail { font-size: 12px; line-height: 16px; color: var(--dim); }
.row[aria-selected="true"] { background: #0a84ff; color: #fff; }
.row[aria-selected="true"] .detail, .row[aria-selected="true"] .icon { color: rgba(255,255,255,.85); }
`;

// set inline with !important: a popover host otherwise takes UA popover styles, and the page can target the tag
export const HOST_STYLE: Record<string, string> = {
  position: "fixed", inset: "auto", margin: "0", padding: "0", border: "0", background: "transparent",
  overflow: "visible", "z-index": "2147483647", display: "block", opacity: "1", visibility: "visible",
  width: "auto", height: "auto", "max-width": "none", "max-height": "none", transform: "none", filter: "none",
  "clip-path": "none", "pointer-events": "auto", "color-scheme": "light dark", contain: "none",
};

// header plus four and a half rows, the half row hinting that it scrolls
const MAX_HEIGHT = 26 + 4.5 * 45;
// a field still settling into place after focus (an animated dialog) is followed this long
const TRACK_MS = 5_000;

/** Where the list is drawn: the topmost same-origin document, so an iframe doesn't clip it. */
function drawingSurface(anchor: HTMLInputElement): { doc: Document; offset: () => { x: number; y: number } } {
  const frames: Element[] = [];
  let win: Window | null = anchor.ownerDocument.defaultView;
  try {
    // frameElement is null across origins, so a cross-origin parent never draws our list
    while (win?.frameElement) {
      frames.push(win.frameElement);
      win = win.parent;
    }
  } catch {
    frames.length = 0;
  }
  const doc = frames.length ? frames[frames.length - 1]!.ownerDocument : anchor.ownerDocument;
  return {
    doc,
    offset() {
      let x = 0;
      let y = 0;
      for (const f of frames) {
        const r = f.getBoundingClientRect();
        const cs = f.ownerDocument.defaultView!.getComputedStyle(f);
        x += r.left + f.clientLeft + parseFloat(cs.paddingLeft);
        y += r.top + f.clientTop + parseFloat(cs.paddingTop);
      }
      return { x, y };
    },
  };
}

export class Dropdown {
  private host: HTMLElement | undefined;
  private box: HTMLElement | undefined;
  private anchor: HTMLInputElement | undefined;
  private surface: ReturnType<typeof drawingSurface> | undefined;
  private rows: { el: HTMLElement; row: Row }[] = [];
  private active = -1;
  private tracker: ReturnType<typeof setInterval> | undefined;
  private shownAt = 0;
  // a press on a row that the page then sees as a click must not act on whatever was under the box
  private pressedAt = 0;
  private readonly onToggle = (e: Event) => this.repop(e);
  private readonly onSurfaceClick = (e: MouseEvent) => this.onPageClick(e);
  private readonly onMove = () => this.position();

  constructor(private readonly title: string) {
    document.addEventListener("keydown", (e) => this.onKey(e), true);
    document.addEventListener("click", (e) => this.onPageClick(e), true);
    addEventListener("scroll", this.onMove, true);
    addEventListener("resize", this.onMove);
  }

  get open(): boolean {
    return this.host !== undefined;
  }

  /** A row is highlighted, so Enter picks it. */
  get selecting(): boolean {
    return this.active >= 0;
  }

  get field(): HTMLInputElement | undefined {
    return this.anchor;
  }

  show(anchor: HTMLInputElement, rows: Row[]): void {
    this.close();
    if (!rows.length) return;
    this.anchor = anchor;
    this.surface = drawingSurface(anchor);
    const doc = this.surface.doc;
    const host = doc.createElement("icloudkeys-suggestions");
    for (const [k, v] of Object.entries(HOST_STYLE)) host.style.setProperty(k, v, "important");
    const root = host.attachShadow({ mode: "closed" });
    const style = doc.createElement("style");
    style.textContent = CSS;
    const box = doc.createElement("div");
    box.className = "box";
    box.setAttribute("role", "listbox");
    box.setAttribute("aria-label", `${this.title} suggestions`);
    const head = doc.createElement("div");
    head.className = "head";
    head.innerHTML = svg("key");
    head.append(this.title);
    box.append(head);
    rows.forEach((row, i) => box.append(this.rowElement(doc, row, i)));
    root.append(style, box);
    this.host = host;
    this.box = box;
    mount(host, anchor);
    if (doc !== document) {
      doc.addEventListener("click", this.onSurfaceClick, true);
      doc.defaultView?.addEventListener("scroll", this.onMove, true);
    }
    doc.addEventListener("toggle", this.onToggle, true);
    this.position();
    this.shownAt = Date.now();
    this.tracker = setInterval(() => {
      if (!this.intact()) return this.close();
      if (Date.now() - this.shownAt < TRACK_MS) this.position();
    }, 100);
  }

  close(): void {
    clearInterval(this.tracker);
    const doc = this.surface?.doc;
    if (doc) {
      doc.removeEventListener("toggle", this.onToggle, true);
      if (doc !== document) {
        doc.removeEventListener("click", this.onSurfaceClick, true);
        doc.defaultView?.removeEventListener("scroll", this.onMove, true);
      }
    }
    this.host?.remove();
    this.host = undefined;
    this.box = undefined;
    this.anchor = undefined;
    this.surface = undefined;
    this.rows = [];
    this.active = -1;
  }

  private rowElement(doc: Document, row: Row, i: number): HTMLElement {
    const el = doc.createElement("div");
    el.className = row.footer ? "row footer" : "row";
    el.setAttribute("role", "option");
    if (row.icon) el.innerHTML = svg(row.icon);
    const text = doc.createElement("div");
    text.className = "text";
    const label = doc.createElement("span");
    label.className = "label";
    label.textContent = row.label;
    text.append(label);
    if (row.detail) {
      const d = doc.createElement("span");
      d.className = "detail";
      d.textContent = row.detail;
      text.append(d);
    }
    el.append(text);
    el.addEventListener("mouseenter", () => this.select(i));
    el.addEventListener("mousedown", (e) => {
      if (!e.isTrusted) return;
      // keep focus in the field
      e.preventDefault();
      this.pressedAt = Date.now();
    });
    el.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();
      this.pick(i);
    });
    this.rows.push({ el, row });
    return el;
  }

  /** The list is shown as drawn: a page that hid or faded it could steer a click onto a row. */
  private intact(): boolean {
    const host = this.host;
    if (!host?.isConnected) return false;
    if (host.popover && !host.matches(":popover-open")) return false;
    const view = host.ownerDocument.defaultView!;
    for (let el: Element | null = host; el; el = el.parentElement) {
      const cs = view.getComputedStyle(el);
      if (cs.opacity !== "1" || cs.visibility === "hidden" || cs.display === "none") return false;
    }
    return true;
  }

  private repop(e: Event): void {
    const host = this.host;
    // another dialog or popover went into the top layer above us; go back on top
    if (!host || e.target === host || (e as ToggleEvent).newState !== "open" || !host.matches(":popover-open")) return;
    host.hidePopover();
    host.showPopover();
  }

  private pick(i: number): void {
    const row = this.rows[i]?.row;
    const ok = this.intact();
    this.close();
    if (ok) row?.onPick();
  }

  private select(i: number): void {
    this.active = i;
    this.rows.forEach(({ el }, j) => (j === i ? el.setAttribute("aria-selected", "true") : el.removeAttribute("aria-selected")));
    this.rows[i]?.el.scrollIntoView({ block: "nearest" });
  }

  private position(): void {
    const host = this.host;
    const box = this.box;
    if (!host || !box || !this.anchor || !this.surface) return;
    if (!this.anchor.isConnected) return this.close();
    const view = this.surface.doc.defaultView!;
    const { x, y } = this.surface.offset();
    const f = this.anchor.getBoundingClientRect();
    const r = { left: f.left + x, top: f.top + y, bottom: f.bottom + y };
    box.style.maxHeight = "";
    const natural = Math.min(box.scrollHeight + 2, MAX_HEIGHT);
    const below = view.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    // below the field like Apple's, unless only above has room for it
    const down = below >= natural || below >= above;
    box.style.maxHeight = `${Math.max(60, Math.min(MAX_HEIGHT, down ? below : above))}px`;
    const left = Math.min(Math.max(4, r.left), view.innerWidth - box.offsetWidth - 4);
    host.style.setProperty("left", `${Math.round(Math.max(4, left))}px`, "important");
    host.style.setProperty("top", `${Math.round(down ? r.bottom + 2 : r.top - box.offsetHeight - 2)}px`, "important");
  }

  private onKey(e: KeyboardEvent): void {
    if (!e.isTrusted || !this.open) return;
    if (e.key === "Escape") {
      this.close();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.composedPath()[0] !== this.anchor) return;
    const n = this.rows.length;
    if (e.key === "ArrowDown") this.select((this.active + 1) % n);
    // from nothing selected, up goes to the last row
    else if (e.key === "ArrowUp") this.select(this.active < 0 ? n - 1 : (this.active - 1 + n) % n);
    else if (e.key === "Enter" && this.active >= 0) {
      e.stopPropagation();
      this.pick(this.active);
    } else return;
    e.preventDefault();
  }

  private onPageClick(e: MouseEvent): void {
    if (!e.isTrusted) return;
    const path = e.composedPath();
    if (this.host && path.includes(this.host)) return;
    // the key button in the field opens and closes the list itself
    if (path.some((n) => n instanceof Element && n.localName === "icloudkeys-key")) return;
    if (Date.now() - this.pressedAt < 700) {
      this.pressedAt = 0;
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (!path.includes(this.anchor as EventTarget)) this.close();
  }
}

/** Puts a host in the top layer, inside the field's modal dialog if it has one. */
export function mount(host: HTMLElement, anchor: HTMLInputElement): void {
  // inside an open modal dialog, anything outside it is inert and can't be clicked
  const modal = anchor.closest("dialog");
  (modal?.open && modal.ownerDocument === host.ownerDocument ? modal : host.ownerDocument.documentElement).append(host);
  if ("showPopover" in host) {
    host.popover = "manual";
    host.showPopover();
  }
}
