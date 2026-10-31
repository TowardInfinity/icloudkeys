# Changelog

User-visible changes to iCloudKeys. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-10-31

### Added

- Offer a Hide My Email address you already made for the site on its email fields.
- Open the iCloud sign-in from the popup's Hide My Email row.
- Show the key beside split code boxes.
- Handle more login flows: ID and password on separate pages, and more sign-in wording.
- Offer "Continue with Apple" on an empty sign-in field when the site has that button. Picking it clicks the site's button.
- Treat Apple's `idmsa.apple.com` sign-in frame as a known embedded login.

### Changed

- The "No verification code" row now points to the macOS Fill code bubble for texted codes.

### Fixed

- A code filled or pasted into a later box now fills the whole row instead of one digit.
- Fills go only into the right fields on more forms.

## [0.1.0] - 2026-10-31

First release: Apple Passwords AutoFill, one-time codes saved in Passwords, Hide My Email, password generation and the Rust installer for Chromium browsers on macOS.

[Unreleased]: https://github.com/TowardInfinity/icloudkeys/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/TowardInfinity/icloudkeys/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/TowardInfinity/icloudkeys/releases/tag/v0.1.0
