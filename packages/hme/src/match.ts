import type { HmeEmail } from "./client.ts";

const MAX_ADDRESSES = 3;

function siteOf(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return undefined;
  }
  // "bank.com@evil.com" reads as one site and parses as the other
  if (url.username || url.password) return undefined;
  const host = url.hostname.replace(/\.$/, "").replace(/^(www|m)\./, "");
  // labels are free text; "Netflix" names no host, and URL rewrites "1.1" into an IP
  return host.includes(".") && !/\d$/.test(host) ? host : undefined;
}

/**
 * The active addresses made for exactly this host, newest first. Exact only, because without a
 * public suffix list a parent match would hand a label of github.io to evil.github.io.
 */
export function addressesForSite(emails: readonly HmeEmail[], host: string): string[] {
  const site = siteOf(host);
  if (!site) return [];
  return emails
    .filter((e) => e?.isActive === true && typeof e.hme === "string" && (siteOf(e.label) === site || siteOf(e.domain) === site))
    .sort((a, b) => (b.createTimestamp || 0) - (a.createTimestamp || 0))
    .slice(0, MAX_ADDRESSES)
    .map((e) => e.hme);
}
