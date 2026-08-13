# Changelog

Reasoning behind these changes is in [docs/decisions.md](docs/decisions.md).

## Unreleased

- Removed the browser flasher. ESP Web Tools could not enter download mode on
  this board via its CH340, even with BOOT held through the reset. See
  docs/decisions.md for what was ruled out.

## 0.4.1

- Display DMA buffer raised from 8KB to 16KB. A row of text was seen once with
  its bottom clipped after a value changed length, which fits narrow flush strips
  leaving part of the old area unredrawn. 16KB halves the number of strips and
  still leaves TLS around 48KB, comfortably above the ~45KB it needs.

## 0.4.0

- Server host moved to NVS and entered in the setup portal. Nothing
  device-specific is left in the firmware image, so one binary serves every unit
  and a published build can be pointed at any server without rebuilding.
- Both portal call sites share one save/validation function. They had already
  drifted apart in formatting, which is how two copies drift in behaviour next.
- Pasted URLs are accepted in the host field and normalised — `https://` and
  trailing slashes are stripped rather than producing `https://https://…`, which
  fails in a way that reads like the server being down.
- MIT licence, server contract document, decisions document.
- Zero-dependency reference server under `server/`.

## 0.3.1

- Long hold (5s) reopens the setup portal, so a unit can be re-keyed without a
  cable. Previously the only way to change a key was erasing flash over USB — a
  site visit, for a product whose point is not needing one.
- The footer says "keep holding for setup..." from 1.5s; a silent long hold feels
  like a dead screen and gets abandoned.
- A hold that stops short of the threshold is treated as a refresh, so the two
  gestures cannot conflict.

## 0.3.0

- **Device key moved to NVS.** It was a compile-time define, so it travelled
  inside every OTA binary: a unit updated itself, inherited the key the build was
  made with, and silently became a duplicate of another screen. The update
  succeeded and the device rebooted cleanly — the only symptom was a screen
  quietly showing the wrong thing.
- Setup AP name now carries a MAC suffix. Two units raising an identically named
  AP after a fleet update is impossible to tell apart from a phone.
- A unit with no key opens the setup portal outright rather than connecting to
  wifi and doing nothing useful.

## 0.2.1

- **OTA only installs strictly newer versions.** It previously updated on any
  version *difference*, so a unit freshly flashed with a newer build immediately
  began downgrading itself to whatever the manifest advertised. Rollback now
  needs `"allow_downgrade": true`.

## 0.2.0

- Long-press to poll immediately instead of waiting out the 30s cycle.
- Footer shows "refreshing..." first — a poll takes seconds over TLS, and a
  button that appears to do nothing gets pressed repeatedly.

## 0.1.3

- Only one TLS client alive at a time. The manifest client was still in scope
  when the download client was created; two TLS contexts do not fit, and the
  failure surfaced as `connection refused`, pointing at a server that was fine.

## 0.1.1

- ASCII-only labels. The bundled Montserrat subsets have no `U+00B7`, so a `·`
  separator rendered as a tofu box.
- Wifi portal timeout raised from 5 to 10 minutes — 5 rebooted the unit while
  someone was still typing their password.

## 0.1.0

First working firmware.

- LVGL buffer reduced to a tenth of a screen. The board definitions request a
  quarter — 38KB contiguous — which fails on a PSRAM-less board carrying TLS, and
  the library's "direct transfer" fallback reaches the panel with nothing. A
  blank screen with healthy-looking logs is indistinguishable from a wrong
  display driver.
- Display DMA buffer reduced from 64KB to 8KB, handing ~56KB back to TLS, which
  was failing its handshake for want of memory.
- `min_spiffs.csv` partitions — two app slots, which is what makes OTA possible.
- Labels aligned rather than absolutely positioned.
- `selftest()` floods the panel red/green/blue on boot. A dead flush path, a
  wrong colour space, a wrong inversion and a layout bug all look identical when
  the text is scrambled.
