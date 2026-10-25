# iCloudKeys

Apple Passwords (iCloud Keychain) for Chromium browsers on macOS. Not affiliated with Apple.

## Use

```sh
pnpm install && pnpm build
cd native && cargo run --release -- install   # registers Apple's helper with Brave, Edge, Arc…
```

Load `targets/chromium/dist` as an unpacked extension, with Apple's iCloud Passwords
extension disabled (they share an ID). Click the toolbar icon and enter the code your Mac shows.

## Develop

```sh
pnpm test                          # core, classifier (headless Chromium), extension
cd native && cargo test
```

Licensed under Apache-2.0; see NOTICE for derived code.
