# Changelog

Reasoning behind these changes is in [docs/decisions.md](docs/decisions.md).

## 0.5.0

- **One key can show several agents.** A device whose `agent` column names more
  than one ("crons,motoko") gets `{ screens: [...] }` and the firmware cycles
  them. The device still decides nothing: order, dwell time, whether to hold and
  the group colour are all resolved server-side, so a unit can be moved between
  a single agent and a group with no reflash. The footer shows `1/2` so a screen
  that changes on its own reads as a rotation rather than a fault.
- **A red screen stops the rotation.** The server sorts red first and sets
  `hold`; the device parks there. Cycling past the thing that needs attention is
  the failure page navigation was rejected for.
- **The dot and the LED show the group's worst state, not the visible screen.**
  A green light over a hidden red screen is the same lie as a stale green tick.
  The state word still describes the screen you are actually looking at.
- **OTA verifies sha256 before flashing, and refuses without one.** The download
  loop is now hand-rolled because `httpUpdate.update()` offers no hook to hash
  the bytes on the way past. Everything is written to the inactive app slot, so
  a mismatch, a truncated download or a stall discards the staged image and the
  unit carries on running what it has. A manifest with no hash means OTA stops
  for that board, loudly, rather than flashing something unverified.
- Rotation stops when the device goes OFFLINE. Cycling through screens we can no
  longer vouch for looks more alive than a frozen one, not less.
- `poll_s` from the server is now honoured (clamped 10-600s). It was already
  being sent and ignored, so changing a fleet's poll rate meant reflashing it.

## Unreleased

- Added the `esp32-4827S043C` environment (ESP32-S3, 4.3" 480x272, GT911
  capacitive touch, 8MB PSRAM). Two things fixed while wiring it in, not just
  new config: rotation was hardcoded to 90 degrees for the CYD's portrait
  panel and now reads the board's own width/height instead, since this panel
  is natively landscape; and the CYD's RAM-workaround buffer sizes were in the
  shared `[env]` block and would have silently overridden this board's own
  PSRAM-sized buffers, so they moved into a CYD-only `[cyd_buffers]` section.
  Both verified on hardware: the unit reports `480x272 after rotation` and a
  full-frame 130560px buffer with 264KB heap free.
- Pixel clock on `esp32-4827S043C` raised from the board definition's 8MHz to
  12MHz. On an RGB panel the pixel clock IS the refresh rate, and 8MHz works
  out to 50.5Hz — visibly flickering. 12MHz gives 75.8Hz. 16MHz was tried and
  reverted: it removed the even flicker but introduced right-edge flicker,
  which is PSRAM DMA under-run, so 12MHz sits just under the ceiling. A faint
  residual remains; the real fix is bounce buffers, which the display library
  does not expose. See docs/decisions.md.
- Corrected: this board flashes over a **CH340**, not native USB, despite its
  board definition's Espressif hwids. Documented from a spec sheet before a
  board existed to check, which cost an hour of chasing a flashing problem
  that was never there. See docs/decisions.md.
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
