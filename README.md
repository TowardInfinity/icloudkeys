# iCloudKeys

Apple Passwords (iCloud Keychain) for Chromium browsers on macOS. Not affiliated with Apple.

## Use

```sh
pnpm install && pnpm build
cd native && cargo run --release -- install   # registers Apple's helper with Brave, Edge, Arc…
```

Load `targets/chromium/dist` as an unpacked extension after removing Apple's iCloud
Passwords extension; they share an ID, and merely disabling Apple's leaves its manifest in place. Click the toolbar icon and enter the code your Mac shows.

## Develop

```sh
pnpm test                          # core, classifier (headless Chromium), extension
cd native && cargo test
```

Licensed under Apache-2.0; see NOTICE for derived code.
