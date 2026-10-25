// The suggestion list shown under a focused field. It lives in a closed shadow root so the page
// can neither read nor restyle it, and rows act only on trusted input.

export interface Row {
  label: string;
  detail?: string;
  onPick(): void;
}

const CSS = `
:host { all: initial; }
.box {
  position: fixed; z-index: 2147483647; min-width: 220px; max-width: 360px; max-height: 280px;
  overflow-y: auto; color-scheme: light dark; background: Canvas; color: CanvasText;
  border: 1px solid rgba(128,128,128,.35); border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0,0,0,.22), 0 2px 8px rgba(0,0,0,.10);
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
}
.head { padding: 6px 12px; font-size: 11px; font-weight: 600; opacity: .55; border-bottom: 1px solid rgba(128,128,128,.18); }
.row { padding: 7px 12px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row[aria-selected="true"] { background: rgba(10,132,255,.18); }
.detail { display: block; font-size: 11px; opacity: .6; overflow: hidden; text-overflow: ellipsis; }
`;

export class Dropdown {
  private host: HTMLElement | undefined;
  private box: HTMLElement | undefined;
  private anchor: HTMLInputElement | undefined;
  private rows: { el: HTMLElement; row: Row }[] = [];
  private active = -1;
  // a press on a row that the page then sees as a click must not act on whatever was under the box
  private pressedAt = 0;

  constructor(private readonly title: string) {
    document.addEventListener("keydown", (e) => this.onKey(e), true);
    document.addEventListener("click", (e) => this.onPageClick(e), true);
    addEventListener("scroll", () => this.position(), true);
    addEventListener("resize", () => this.position());
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
    this.host = document.createElement("icloudkeys-suggestions");
    const root = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    const box = document.createElement("div");
    box.className = "box";
    box.setAttribute("role", "listbox");
    box.setAttribute("aria-label", `${this.title} suggestions`);
    const head = document.createElement("div");
    head.className = "head";
    head.textContent = this.title;
    box.append(head);
    rows.forEach((row, i) => {
      const el = document.createElement("div");
      el.className = "row";
      el.setAttribute("role", "option");
      el.textContent = row.label;
      if (row.detail) {
        const d = document.createElement("span");
        d.className = "detail";
        d.textContent = row.detail;
        el.append(d);
      }
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
      box.append(el);
      this.rows.push({ el, row });
    });
    root.append(style, box);
    this.box = box;
    document.documentElement.append(this.host);
    this.position();
  }

  close(): void {
    this.host?.remove();
    this.host = undefined;
    this.box = undefined;
    this.anchor = undefined;
    this.rows = [];
    this.active = -1;
  }

  private pick(i: number): void {
    const row = this.rows[i]?.row;
    this.close();
    row?.onPick();
  }

  private select(i: number): void {
    this.active = i;
    this.rows.forEach(({ el }, j) => (j === i ? el.setAttribute("aria-selected", "true") : el.removeAttribute("aria-selected")));
    this.rows[i]?.el.scrollIntoView({ block: "nearest" });
  }

  private position(): void {
    const el = this.box;
    if (!el || !this.anchor) return;
    if (!this.anchor.isConnected) return this.close();
    const r = this.anchor.getBoundingClientRect();
    el.style.left = `${Math.max(4, r.left)}px`;
    el.style.minWidth = `${Math.max(r.width, 220)}px`;
    const h = el.offsetHeight;
    const below = r.bottom + 2 + h <= innerHeight || r.top - 2 - h < 0;
    el.style.top = `${below ? r.bottom + 2 : r.top - h - 2}px`;
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
    else if (e.key === "ArrowUp") this.select((this.active - 1 + n) % n);
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
    if (Date.now() - this.pressedAt < 700) {
      this.pressedAt = 0;
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (!path.includes(this.anchor as EventTarget)) this.close();
  }
}
