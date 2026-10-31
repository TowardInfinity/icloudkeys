# Contributing to iCloudKeys

Thank you for your interest in contributing! iCloudKeys is an open-source client providing native Apple Passwords (iCloud Keychain) and Hide My Email integration for Chromium browsers on macOS.

## Prerequisites

- **Node.js:** Node >= 26 (managed via `fnm` or `.nvmrc`)
- **Package Manager:** `pnpm` (>= 12)
- **Rust Toolchain:** Stable Rust with `cargo` (via `rustup`)
- **macOS:** Tested on macOS 14+ (macOS 15.4+ enforces browser code signatures)

## Project Layout

- `packages/core/`: SRP-6a protocol, AES-GCM crypto channel, and password generator.
- `packages/classifier/`: Form and input heuristics for identifying login, OTP, and sign-up email fields.
- `packages/hme/`: iCloud+ Hide My Email client and declarativeNetRequest rules.
- `targets/chromium/`: MV3 extension (background service worker, content scripts, popup, settings).
- `native/installer/`: Rust CLI (`icloudkeys-install`) registering Apple's helper with Chromium browsers.

## Development Workflow

1. Install dependencies:
   ```sh
   pnpm install
   npx playwright install --with-deps chromium
   ```

2. Run typechecks and tests:
   ```sh
   pnpm typecheck
   pnpm test
   cd native && cargo test
   ```

3. Build the extension:
   ```sh
   pnpm build
   ```
   The unpacked extension output is generated in `targets/chromium/dist`.

## Guidelines

- **Zero Secrets / Leaks:** Never commit credentials, private keys, or personal session data.
- **Verification First:** Ensure `pnpm typecheck`, `pnpm test`, and `cargo test` pass before submitting a pull request.
- **Attribution & Provenance:** Any derived algorithms or fixtures must be credited in `NOTICE` under their respective licenses.
