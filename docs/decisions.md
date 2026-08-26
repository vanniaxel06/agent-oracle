# Decisions, and what they cost to learn

Why this firmware is the way it is. Most entries exist because something failed
on real hardware first — those are marked **(learned the hard way)**, and they're
the ones worth reading before changing anything.

Written down because a squashed public repo loses the commit history that
explains itself, and a rule without its reason gets "cleaned up" by the next
person.

---

## The device is a dumb renderer

The server sends finished label/value lines, a state word and a colour. The
firmware contains no thresholds, no formatting and no knowledge of what it is
showing.

**Why:** changing what a screen says becomes a server-side edit that every unit
picks up on its next poll. No rebuild, no OTA, no physical access. A screen in
another building can be re-specified in the time it takes to edit a config file.

We changed a line mid-session and it appeared on both units without either being
touched. That property is the entire argument for the architecture, and every
temptation to put "just a little logic" on the device erodes it.

## Staleness is the product

There is deliberately no code path that returns green from an old observation.
Past a per-source window it is red, always.

**Why:** a screen showing a green tick while the thing it watches is dead is
worse than no screen. It converts an unknown into false confidence.

Two consequences that look like details and aren't:

- **Staleness windows are per source.** An always-on process might be 120
  seconds; a four-hourly cron job needs its interval plus grace. A single global
  value makes the cron agent read red permanently, and people learn to ignore red.
- **An unrecognised state word is amber, never green.** Don't invent confidence
  the source didn't report.

## The device decides "offline" for itself

If it cannot complete a poll for two minutes it stops showing the last payload
and displays `OFFLINE`.

**Why:** the server cannot tell you it is unreachable. Everything else is
server-authoritative; this one judgement has to live on the device, because it is
the only party that can observe the silence.

## Identity lives in NVS, never in the firmware image **(learned the hard way)**

The device key was originally a compile-time `#define`.

**What happened:** every unit downloads the same binary over OTA, so the key
travelled with it. A unit updated itself, inherited the key the build happened to
be made with, and silently became a duplicate of another screen. The other agent
simply stopped being polled.

The update *succeeded*. The device rebooted cleanly. The only symptom was a
screen quietly showing the wrong thing — which in someone else's office is a unit
reporting on a system that isn't theirs.

The server host moved to NVS for the same reason: a compile-time host welds a
published binary to whoever built it, so browser-flashing it is pointless.

**Rule: nothing device-specific goes in the image.** One binary, many units,
identity that survives updates.

## OTA only ever moves forward **(learned the hard way)**

The update check originally fired whenever the manifest version *differed* from
the running one.

**What happened:** a unit freshly flashed with a newer build saw a manifest still
advertising the old version and immediately began downgrading itself, undoing the
flash. Publish a stale manifest by mistake and a whole fleet walks backwards.

Now it compares semantic versions and installs only strictly newer ones. A
rollback must be requested explicitly with `"allow_downgrade": true`.

## `min_spiffs.csv`, never `huge_app.csv`

The build overflows the default 1.3MB app partition.

`huge_app.csv` also fits — 3MB — but provides only **one** app partition. The
build succeeds, USB flashing works, and OTA is silently dead forever after. On a
device whose entire premise is not driving out to reflash it, that is the worst
available failure.

`min_spiffs.csv` gives 1.9MB per slot and keeps two.

## On this board, RAM failures impersonate network and driver faults **(learned the hard way)**

Three separate bugs during bring-up. All three were the same root cause — not
enough contiguous RAM — and **every one reported something else**:

| What the log said | What it looked like | What it was |
|---|---|---|
| `Failed to allocate DMA buffer`, then "using direct transfers" | wrong display driver | 38KB LVGL buffer failed; the "fallback" drew nothing at all |
| `SSL - Memory allocation failed` → `connection refused` | the server being down | 64KB display DMA buffer starving the ~45KB TLS handshake |
| `X509 - Allocation of memory failed` → `connection refused` | a broken OTA endpoint | two `WiFiClientSecure` objects alive at once |

**Suspect local memory before believing any network error on a PSRAM-less board.**
Two of the three presented as `connection refused`, pointing squarely at
infrastructure that was working perfectly.

Also misleading: `heap_caps_get_largest_free_block()` reported 110KB free when
the 38KB allocation failed. Free-block size does not predict whether an
allocation with specific capability flags will succeed.

Practical consequences, both in `platformio.ini`:

- LVGL buffer overridden to a tenth of a screen. The board definitions ask for a
  quarter, sized for animation; this UI redraws text twice a minute.
- Display DMA buffer reduced from 64KB to 8KB, handing ~56KB back to TLS.
- Don't add `-U` to silence the redefinition warning. PlatformIO emits it after
  the `-D` and the macro ends up undefined, breaking the library build.

**Only one TLS client alive at a time.** This board cannot afford two.

## Diagnose a display with colour, never with text **(learned the hard way)**

`selftest()` floods the panel red, green, blue for 1.5s each before drawing
anything.

**Why:** a dead flush path, a wrong colour space, a wrong inversion and a plain
layout bug all look identical when the text is scrambled. Telling them apart by
eye cost several flash cycles and one wrong conclusion that turned a working
screen into a broken one.

Solid colours cannot be misread. Use it first, always.

## Don't infer board revision from the hardware **(learned the hard way)**

Our units have two USB ports and are `esp32-2432S028R` — the definition
documented as single-USB. Two other revisions were flashed first on that
assumption.

Flash and look. See [board-revisions.md](board-revisions.md).

## Labels are aligned, never absolutely positioned **(learned the hard way)**

The first layout hard-coded x/y for a 320×240 screen. On the panel the value
column ran off the edge and the screen read as truncated gibberish.

Alignment costs nothing and survives a rotation change, a different panel, or a
longer string.

## Rotation stays

The panel is natively portrait and the UI renders landscape via software
rotation. A photo of the board held portrait shows text running vertically and
looks broken — it isn't. Rotation was removed once on that misreading, which
turned a working screen into a genuinely mangled one.

## One action, no menu

Page navigation was rejected. **A wall unit parked on a green page while another
agent is red is exactly the failure the staleness rule exists to prevent.** A
menu can hide the thing you needed to see; a button with no state cannot.

Touch gestures are separated by hold length: ~0.4s polls immediately, 5s reopens
the setup portal. The long hold exists because there was otherwise no way to
re-key a unit without erasing its flash over USB — a site visit, for a product
whose whole point is not needing one.

5 seconds rather than a tap because wall units get brushed and wiped. The footer
says "keep holding for setup..." from 1.5s, because a silent long hold feels like
a dead screen and gets abandoned.

## Rotation is not a menu

"One action, no menu" rejected page navigation. Cycling several agents on one
unit sounds like the same thing readmitted, and it isn't — the distinction is
who chooses:

- A **menu** parks on whatever page a human last selected. It can hide a red
  screen indefinitely, and nobody knows it is hiding one.
- **Rotation** is automatic, bounded, and **stops on red**. The server sorts
  red screens first and sets `hold`; the device parks on the worst one and
  stays there. Nothing can be hidden by inattention.

The safeguard that makes this true is the dot and the LED carrying the group's
**worst** state rather than the visible screen's. A green light while a red
screen is queued behind it would rebuild the exact failure the menu ban exists
to prevent, from the other direction.

The device counts and nothing else. Which agents, what order, how long each
sits, and whether to rotate at all are server-side, so a unit moves between a
single agent and a group with no reflash.

**Staleness stays per agent inside a group** — this was got wrong first time.
See the server's `buildScreen`: a device row carries one `stale_after_s`, which
is right for one agent and wrong for several, because a five-minute window
applied to a four-hourly agent marks it permanently dead. Permanently dead sets
`hold`, and `hold` stops the rotation, so the feature looked broken while the
agents were fine.

## OTA refuses to flash what it cannot verify

The manifest must carry a `sha256`. No hash, no update — logged loudly, with
the unit still running.

**Why refusing rather than warning:** TLS authenticates the *server*. It says
nothing about whether the bytes at that URL are the build that was tested. A
truncated upload, a half-written file, or the wrong binary at the right path
all pass TLS perfectly.

`httpUpdate.update()` streams straight into flash with no hook to hash on the
way past, so the download loop is hand-rolled to hash and write in the same
pass. This sounds riskier than it is: every byte goes to the **inactive** app
slot, and nothing boots until `Update.end()` flips the boot partition. A
mismatch, a stall or a short read calls `Update.abort()` and the running
firmware is untouched. The failure mode is "the update doesn't happen", never
"the unit is unbootable" — which is also why `min_spiffs.csv` and its two app
slots are load-bearing rather than a build-size workaround.

The stall timeout is not decoration. Without it a dead socket leaves the screen
on "UPDATING - do not unplug" forever, and on a wall unit that is a site visit.

## Every line must be actionable

Five rows is the entire budget. A line that is merely interesting occupies space
a line that changes behaviour could have used.

Cut anything that makes you feel something but do nothing — uptime percentage and
running totals are the usual offenders; they read as rigour and change nothing.

**Prefer a name over a count.** `Errors 2` says something is wrong; `Failing
nightly-sync` says where to look.

## No ambient animation

Technically fine — the panel is LCD, so no burn-in risk. Rejected because **a
screen that is always moving trains you to ignore it.** Motion is the strongest
attention signal available; spend it constantly and it stops carrying
information.

Motion on *state change* is the exception worth building: it fires when something
happened, so it earns the glance.

## TLS is verified, not just encrypted

The device pins ISRG Root X1 rather than calling `setInsecure()`.

**Why:** the risk isn't eavesdropping. The device key travels in the URL, and a
spoofed feed could show a green tick for a dead system — the exact failure this
design exists to prevent. Encryption without authentication would not have
protected the thing that matters.

## Board definitions are vendored, not a submodule

Hardware config should be pinned to what was verified against a physical board. A
`git submodule update` should not be able to change display timings on a unit
already installed somewhere. It also removes the `--recursive` clone footgun.

Refresh them deliberately, and diff before committing.

---

## Browser flashing does not work on this board **(learned the hard way)**

Built and then removed. ESP Web Tools (esptool-js) could not put an
ESP32-2432S028R into download mode over its CH340, so the install stopped at
*"Failed to initialize"* every time.

What was ruled out, in order:

- **Not the board, cable or port.** `esptool.py` connected to the same board on
  the same cable seconds after each failure and read the chip ID.
- **Not a missing BOOT button.** These boards have two buttons — RST on the
  right, BOOT on the left. Holding BOOT and tapping RST demonstrably enters
  download mode: `esptool --before no_reset` connected to a board already sitting
  in the bootloader.
- **Not user error on the hold.** Holding BOOT continuously through the click,
  the port selection and the connect phase failed the same way.

Entering download mode needs RTS to pulse the reset line while DTR holds IO0 low
*across* that reset. The board visibly resets, so RTS works; DTR does not. Since
most CYD boards use a CH340, this is likely broken for most people who would want
it rather than being specific to one machine.

**Use PlatformIO.** `pio run -t upload` works reliably on the same hardware,
because esptool's reset timing succeeds where the browser's does not.

The flasher page and merged image were deleted rather than shipped with a
warning. A page whose main control fails on the hardware the project targets is
worse than no page; the finding is worth more than the button.

## The CYD's RAM workarounds must not leak onto a PSRAM board

`platformio.ini`'s shared `[env]` used to carry the CYD's LVGL/DMA buffer
overrides directly. Adding the ESP32-S3 board (`esp32-4827S043C`, 8MB PSRAM)
as a fourth env under that same `[env]` would have force-fed it the CYD's
tenth-screen buffer and 16KB DMA scratch — both sized to dodge internal-RAM
contention that doesn't exist on a board with PSRAM and no TLS/display
allocation fight. The board's own JSON already sizes a full-frame PSRAM buffer
correctly; the shared override would have silently shrunk it.

Moved the two buffer flags into a `[cyd_buffers]` section, pulled in only by
the three CYD envs via `${cyd_buffers.build_flags}`. The S3 env inherits
nothing extra.

**Rule: a hardware workaround lives with the hardware that needs it, not in
the section every environment inherits from.**

## Rotation reads the panel's own dimensions, not a fixed assumption

`lv_display_set_rotation()` was `LV_DISPLAY_ROTATION_90` unconditionally,
correct only because every board so far was a portrait CYD panel rotated to
landscape. The `esp32-4827S043C` is natively 480x272 landscape; the same call
would have turned a correct screen sideways.

Now it compares the board's own `DISPLAY_WIDTH`/`DISPLAY_HEIGHT` — portrait
(H>W) rotates 90 degrees, landscape (W>H) does not — so a third board shape
doesn't need a third code path, just correct dimensions in its board JSON.

## On an RGB panel the pixel clock IS the refresh rate **(learned the hard way)**

The `esp32-4827S043C` flickered visibly straight out of the box. The board
definition's 8MHz pixel clock, against this panel's blanking porches, is a
50.5Hz refresh:

```
h_total = 480 + 4 + 43 + 8 = 535
v_total = 272 + 4 + 12 + 8 = 296
8000000 / (535 * 296) = 50.5 Hz
```

An RGB parallel panel has no controller memory. Unlike the CYD's SPI ILI9341 —
which holds a frame and only receives changes — this panel is scanned out of
the framebuffer continuously, so the pixel clock is not a speed setting, it is
the refresh rate.

Measured on hardware:

| PCLK | Refresh | Observed |
|---|---|---|
| 8MHz (board default) | 50.5 Hz | obvious flicker, **even across the whole panel** |
| 12MHz | 75.8 Hz | best observed — faint residual only |
| 16MHz | 101 Hz | flicker returns, but **only at the right edge** |

**The 16MHz result is the valuable one.** Going up cured the even flicker and
bought a localised one, which is two different faults, not one fault
improving. Even flicker is refresh rate. Right-edge flicker is the DMA falling
behind toward the end of each scanline — under-run — and raising the clock
makes it worse. Settled at 12MHz, which sits just under the ceiling.

**Why this matters more than it looks:** 50Hz is worst in peripheral vision,
and peripheral vision is the entire delivery mechanism for this product. A
display you have to look at directly to notice is a dashboard, and the reason
this project exists is that dashboards require remembering to check them. A
faint flicker also reads as "cheap" in a client's office in a way a spec sheet
never captures.

Two failure modes, one knob, opposite directions — do not confuse them:

| Symptom | Cause | Fix |
|---|---|---|
| Flicker **even across the panel**, worse in peripheral vision | refresh rate too low | raise `PCLK_HZ` |
| Flicker **at the right edge**, tearing, rolling bands, torn text | DMA under-running PSRAM | lower `PCLK_HZ` |

**Ask where on the screen it is before touching the clock.** Described out
loud both are "it's flickering", and the fixes point in opposite directions —
half an hour was spent turning the knob the wrong way for want of that one
question.

**The residual is not solved, only traded down.** The real fix is bounce
buffers: a small internal-RAM staging buffer the LCD peripheral fills from
PSRAM in chunks, which is what ESP-IDF provides for exactly this problem.
`esp32-smartdisplay` does not expose `bounce_buffer_size_px` — the ST7262
driver sets `fb_in_psram` and nothing else — so using them means patching or
forking the library. That is the correct next step if the residual flicker
ever matters enough, and it is a real fix rather than a trade.

Overridden in `platformio.ini`, not in the vendored board JSON, so the
provenance of the pinned definition stays intact and the reason travels with
the override.

**Unrelated and not fixable in firmware:** faint dark banding along rows of
text, appearing and disappearing with viewing angle, is the TN panel itself.
TN's weakness is vertical viewing angle. Check it against the `selftest()`
colour floods — if it shows on a solid colour with no text, it is the glass.

## Identify a board by asking it, not by recognising it **(learned the hard way)**

The `esp32-4827S043C` flashes over a **CH340**, not native USB — despite being
an ESP32-S3, and despite its own board definition carrying Espressif
native-USB hwids (`0x303A/0x1001`) and `use_1200bps_touch`. Its USB-C port
enumerates as `USB-SERIAL CH340`, VID `1A86:7523`, and `pio run -t upload`
works through it with no button combo at all.

**What happened:** the spec sheet said native USB, so that went into
`platformio.ini` as fact before anyone had plugged a board in. Then the board
arrived, a CH340 port appeared, and it was dismissed from memory as "that's
the *other* boards' chip" — even though the port list had been empty three
commands earlier and this port appeared the instant the new board got power.
That produced an hour of chasing bootloader combos, UART pigtails and a
USB-TTL adapter that was never needed. The user checked the port themselves
and was right.

Both errors were the same error: **recognising instead of checking.** This is
the identical failure already recorded above under "Don't infer board revision
from the hardware", one board family later.

The check costs ten seconds and is not ambiguous:

```bash
python ~/.platformio/packages/tool-esptoolpy/esptool.py --port COM4 chip_id
```

It prints the actual silicon (`Chip is ESP32-S3 (QFN56)`, PSRAM, MAC). A VID,
a chip name and a spec sheet are all guesses about which board is on the other
end of a cable. `chip_id` is an answer.

**Corollary: a serial port that appears when you power a board belongs to that
board.** Read the tool output you already have before reasoning from memory
about what a chip "usually" is.

## Known limitations

Honest list, so nobody discovers these the hard way twice.

- **The device key is a bearer token.** It proves someone holding the key made a
  request, not who. Fine for read-only status. Not an audit trail, and not a
  basis for approvals — this board has no secure element, so a key in NVS is
  extractable by anyone with a USB cable.
- **Firmware doesn't report its version to the server.** Web server logs are the
  only way to tell what a unit is running. Fine for two units, useless for twenty.
- **OTA has no integrity check beyond TLS.** The manifest carries no hash, so the
  device installs whatever the URL serves. Builds are not byte-reproducible — the
  toolchain embeds paths and timestamps — so a version string does not identify a
  binary.
- **Resistive touch is uncalibrated.** The whole screen is one hit target, which
  sidesteps it. Anything finer needs per-unit calibration.
- **`esp32-4827S043C` needs a USB-A-to-C cable, not C-to-C** (learned the
  hard way). A C-to-C cable delivered no power at all — not a download-mode
  problem, the board never came on. USB-A has no CC negotiation and just
  outputs 5V; this board's USB-C receptacle appears not to advertise whatever
  a C-to-C host wants to see before it will source power. Once powered it
  flashes normally over the same port — no BOOT/RST combo needed, see below.
