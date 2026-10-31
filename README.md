# iCloudKeys

Apple Passwords (iCloud Keychain) and Hide My Email for Chromium browsers on macOS. Not affiliated with Apple.

## Features

- **Apple Passwords AutoFill:** Native SRP-6a + AES-GCM integration with macOS PasswordManager helper.
- **One-Time Verification Codes:** In-page and popup autofill for both TOTP and Messages-sourced codes.
- **Hide My Email:** Generate, reserve, list, and fill iCloud+ burner addresses directly in sign-up forms.
- **Smart Password Generation:** Honors site-specific `passwordrules` attributes and supports complex passwords.
- **Native Safari Experience:** Floating dropdown in top layer, in-field key button, immediate username prefill, and delayed save prompts (only on successful sign-in).
- **Multi-Browser Support:** Sideload onto Brave, Google Chrome, Microsoft Edge, Arc, and Vivaldi.

## Use

```sh
pnpm install && pnpm build
cd native && cargo run --release -- install   # registers Apple's helper with Brave, Edge, Arc…
```

Load `targets/chromium/dist` as an unpacked extension after removing Apple's iCloud
Passwords extension; they share an ID, and merely disabling Apple's leaves its manifest in place. Click the toolbar icon and enter the code your Mac shows.

Hide My Email needs iCloud+ and a sign-in to icloud.com in the same browser.

## Develop

```sh
pnpm test                          # core, classifier (headless Chromium), extension
cd native && cargo test
```

Licensed under Apache-2.0; see NOTICE for derived code.

