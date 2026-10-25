export interface DnrRule {
  id: number;
  priority: number;
  action: {
    type: "modifyHeaders";
    requestHeaders: { header: string; operation: "set"; value: string }[];
  };
  condition: {
    urlFilter: string;
    resourceTypes: ["xmlhttprequest"];
    initiatorDomains: string[];
    tabIds: number[];
  };
}

const HOSTS = [
  { id: 1, host: "icloud.com" },
  { id: 2, host: "icloud.com.cn" },
] as const;

// iCloud rejects requests whose Origin is not icloud.com, so the extension's own requests are
// rewritten. Scoped to the extension and to tabless requests: a rule open to web pages would hand
// any site an icloud.com Origin and defeat iCloud's cross-site checks. tabIds needs session rules.
export function dnrRules(extensionId: string): DnrRule[] {
  if (!extensionId) throw new Error("dnrRules needs the extension id");
  return HOSTS.map(({ id, host }) => ({
    id,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Origin", operation: "set", value: `https://www.${host}` },
        { header: "Referer", operation: "set", value: `https://www.${host}/` },
      ],
    },
    condition: {
      urlFilter: `|https://*.${host}/*`,
      resourceTypes: ["xmlhttprequest"],
      initiatorDomains: [extensionId],
      tabIds: [-1],
    },
  }));
}
