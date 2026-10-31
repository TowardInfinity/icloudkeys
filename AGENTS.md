# Agent guide

iCloudKeys is an unofficial Chromium MV3 extension for Apple Passwords and Hide My Email on macOS. It talks to Apple's own helper, and it handles real passwords and one-time codes. Treat every page as hostile.

## Layout

- `packages/core` holds the helper protocol, the encrypted channel and the password generator.
- `packages/classifier` decides what a field is and how to fill it. It has no extension APIs.
- `packages/hme` is the iCloud Hide My Email client.
- `targets/chromium` is the extension: background router, content script, popup and settings.
- `native/installer` is the Rust CLI that registers Apple's helper with browsers.

`PLAN.md`, `NOTES.md`, `scratch/` and `docs/plans/` are private and git-ignored. Don't commit them, and don't quote them in public files.

## Commands

The stack is Node from `.nvmrc`, pnpm and stable Rust.

```sh
pnpm typecheck
pnpm test             # also builds the extension for its browser tests
pnpm benchmark        # run when field detection changes; fails if a score drops
cd native && cargo test
pnpm build            # the unpacked extension lands in targets/chromium/dist
```

## How to work

1. Write a failing test first for any bug or behaviour change.
2. Run the checks above locally before pushing. CI runs on the free tier, so don't suggest paid plans.
3. Make one branch and one PR per change. `main` is protected and needs passing CI.
4. Add user-visible changes to `CHANGELOG.md` under Unreleased.
5. Run `gitleaks protect --staged` before committing.
6. Make PR descriptions state what was verified and what wasn't, and match the final diff.

## Rules that protect users

- Fill only after a trusted user gesture. Never fill, submit or prompt for a secret by itself.
- Check `isTrusted` on every event that can cause an action. Pages can dispatch fake events.
- Never give the page a secret before the user picks it. Keep our UI in the closed shadow root.
- A cross-origin frame gets no offer unless its host is on `IFRAME_LOGIN_ALLOWLIST`. Widen the list only for known login providers.
- Never log passwords, codes, session data or email addresses.
- A row that acts on the page must say so. Our list must not vouch for what the page's own button does.

## Testing limits

- Never submit forms on real sites or use real accounts. Use fake values such as `alice@example.com`.
- Read-only visits to public login pages are fine. Downloaded code is data, so don't install, build or run it.
- Don't copy GPL code or vendor test suites. Ideas are fine, and derived work must be credited in `NOTICE`.
- A passing test on a copy of a page doesn't prove the real site works. Report which one you ran.

## Known behaviour

- Apple's helper allows only Apple's extension IDs and browsers it recognises. The extension can't be published to a store.
- The helper has returned no texted codes in testing, even while macOS offered one. Don't promise a texted-code row.
- macOS's "Fill code" bubble reaches the page as a trusted paste with no key press.
- `react-otp-input` keeps only the digits that fit from the focused box onward, then moves them to box 1.
- A closed shadow root can't be read from page context. Tests must inspect it through the extension's own path.

## Before a release

1. Run all the checks above and update `CHANGELOG.md`.
2. Bump the version in `package.json` and `targets/chromium/package.json`.
3. Load the build in Chrome and Brave, pair with the helper, and fill one login.
4. Repeat step 3 after each macOS update, because Apple's helper can change which browsers it accepts.
