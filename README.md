# iCloudKeys

Apple Passwords (iCloud Keychain) and Hide My Email for Chromium browsers on macOS. Not affiliated with Apple.

## Features

- **Apple Passwords AutoFill:** Native SRP-6a + AES-GCM integration with macOS PasswordManager helper.
- **One-Time Verification Codes:** In-page and popup autofill for codes saved in Apple Passwords. Texted codes come from macOS's own Fill code bubble, and iCloudKeys spreads a pasted code across split boxes.
- **Hide My Email:** Generate, reserve, and fill iCloud+ burner addresses directly in sign-up forms. An address you already made for the site is offered on its email fields, so you don't make a second one.
- **Continue with Apple:** When a site has its own Sign in with Apple button, an empty sign-in field offers a row that clicks it. It never clicks by itself.
- **Smart Password Generation:** Honors site-specific `passwordrules` attributes and supports complex passwords.
- **Native Safari Experience:** Floating dropdown in top layer, in-field key button, immediate username prefill, and delayed save prompts (only on successful sign-in).
- **Login Flows:** ID and password on one page or two, sign-up, password change and reset forms, split code boxes, open and closed shadow roots, and sign-in words in major languages.
- **Multi-Browser Support:** Sideload onto Google Chrome and Brave (tested). Microsoft Edge and Arc are reported to work but untested; Apple's helper may refuse Vivaldi and other Chromium browsers.

## Use

```sh
pnpm install && pnpm build
cd native && cargo run --release -- install   # registers Apple's helper with Brave, Edge, Arc…
```

Load `targets/chromium/dist` as an unpacked extension after removing Apple's iCloud
Passwords extension; they share an ID, and merely disabling Apple's leaves its manifest in place. Click the toolbar icon and enter the code your Mac shows.

Hide My Email needs iCloud+ and a sign-in to icloud.com in the same browser.

## Why Sideload / Unpacked?

Apple's macOS native helper (`com.apple.passwordmanager`) enforces strict allowlists:
1. **Extension ID Allowlist:** The native helper only responds to Apple's official extension IDs (`pejdijmoenmkgeppbflobdenhhabjlaj` for Chrome, `mfbcdcnpokpoajjciilocoachedjkima` for Edge). iCloudKeys ships Apple's public key in its manifest to derive this exact ID.
2. **Browser Code Signature:** macOS 15.4+ checks the calling browser's signature against Apple's allowlist. Chrome and Brave are tested; Edge and Arc are reported to pass; others, including Vivaldi, are unknown.

Because the extension ID belongs to Apple's official extensions, this project cannot be published to the Chrome Web Store or Edge Add-ons. It is loaded unpacked as an open-source client.

## Develop

```sh
pnpm test                          # core, classifier (headless Chromium), extension
pnpm benchmark                     # score field detection on DuckDuckGo's labelled real-site forms
cd native && cargo test
```

Licensed under Apache-2.0; see NOTICE for derived code.

