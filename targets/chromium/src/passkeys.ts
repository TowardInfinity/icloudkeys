// Runs in the page's own world while "Hide Browser Passkey Suggestions" is on. The browser lists
// passkeys under a field only while the page holds a conditional (autofill) credentials request, so
// the page is told passkey autofill is unavailable, and a request made anyway stays pending as if
// the user never chose. Passkey buttons on the page don't ask conditionally and still work.

const credentials = navigator.credentials as CredentialsContainer | undefined;
if (credentials?.get) {
  const get = credentials.get.bind(credentials);
  credentials.get = (options?: CredentialRequestOptions) => {
    if (options?.mediation !== "conditional") return get(options);
    const signal = options.signal;
    return new Promise((_, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
}

const PKC = globalThis.PublicKeyCredential as
  | (typeof PublicKeyCredential & { getClientCapabilities?: () => Promise<Record<string, boolean>> })
  | undefined;
if (PKC?.isConditionalMediationAvailable) PKC.isConditionalMediationAvailable = () => Promise.resolve(false);
if (PKC?.getClientCapabilities) {
  const capabilities = PKC.getClientCapabilities.bind(PKC);
  PKC.getClientCapabilities = async () => ({ ...(await capabilities()), conditionalGet: false });
}
