# TASKS: SpiceClient

## Current Status

Last verified: `swift test` passed with 20 tests on 2026-05-13.

SpiceClient is a SwiftUI macOS launcher for SPICE `.vv` files. It uses the user-installed Homebrew `spice-gtk` backend (`spicy`) and does not bundle SPICE/GTK binaries.

## Done

- [x] Created `spice/` Swift Package workspace.
- [x] Added SwiftUI `SpiceClient` app.
- [x] Added reusable `SpiceCore` library.
- [x] Added `.vv` parser and tests.
- [x] Added `spice://` parser and tests.
- [x] Added backend launcher for Homebrew `spicy`.
- [x] Added simple welcome screen with `Choose .vv File`.
- [x] Added explicit `Launch Spice GTK` button.
- [x] Disabled launch button while `spicy` is running.
- [x] Re-enabled launch button when the SPICE main channel closes or the backend exits.
- [x] Disabled audio and USB redirection by default.
- [x] Verified Isard `.vv` launch with Homebrew `spice-gtk`.
- [x] Verified clipboard copy/paste with the provided Isard `.vv`.
- [x] Added `spice/run.sh` to build and launch a release `.app`.
- [x] Added a custom Dock icon to the generated app.
- [x] Collapsed setup, compatibility, and licensing notes into the README.

## Remaining

- [ ] Improve actionable error reporting when `spicy` fails after launch.
- [ ] Validate behavior when the backend is missing.
- [ ] Validate behavior when the guest has no `spice-vdagent`.
- [ ] Validate behavior when the SPICE server disables clipboard sharing.
- [ ] Test on a clean macOS machine from a fresh source checkout.

## Run

```bash
cd spice
./run.sh
```

## Dependency

```bash
brew install spice-gtk
```
