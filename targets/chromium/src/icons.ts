// Line icons drawn for this project, shared by the in-page list and the popup.

export type Icon = "key" | "lock" | "mail" | "code" | "app" | "refresh" | "gear" | "plus";

const ICONS: Record<Icon, string> = {
  key: '<circle cx="5" cy="8" r="3"/><path d="M8 8h7M12.5 8v3M14.5 8v2"/>',
  lock: '<rect x="3" y="7" width="10" height="7.5" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/>',
  mail: '<rect x="1.5" y="3.5" width="13" height="9" rx="1.5"/><path d="m2 4.5 6 4.5 6-4.5"/>',
  code: '<path d="M4.5 2.5h7a3 3 0 0 1 3 3v3a3 3 0 0 1-3 3H8l-3.5 2.5v-2.5a3 3 0 0 1-3-3v-3a3 3 0 0 1 3-3Z"/>',
  refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/>',
  app: '<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5"/>',
  gear: '<path d="M12.39 6.63L14.30 6.88L14.30 9.12L12.39 9.37L12.07 10.14L13.25 11.66L11.66 13.25L10.14 12.07L9.37 12.39L9.12 14.30L6.88 14.30L6.63 12.39L5.86 12.07L4.34 13.25L2.75 11.66L3.93 10.14L3.61 9.37L1.70 9.12L1.70 6.88L3.61 6.63L3.93 5.86L2.75 4.34L4.34 2.75L5.86 3.93L6.63 3.61L6.88 1.70L9.12 1.70L9.37 3.61L10.14 3.93L11.66 2.75L13.25 4.34L12.07 5.86Z"/><circle cx="8" cy="8" r="2"/>',
  plus: '<circle cx="8" cy="8" r="6.5"/><path d="M8 5v6M5 8h6"/>',
};

export const svg = (icon: Icon) =>
  `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[icon]}</svg>`;
