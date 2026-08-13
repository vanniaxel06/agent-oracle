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
