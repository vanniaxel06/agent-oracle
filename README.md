# Agent Oracle — firmware

ESP32 wall displays that show whether an AI agent is actually alive. Firmware for
the ESP32-2432S028R ("Cheap Yellow Display"), 2.8" 240×320.

This repo is the **renderer**. It polls a URL and draws whatever comes back, so
it needs a server that speaks the contract in
[docs/server-contract.md](docs/server-contract.md). A zero-dependency reference
server is included in [server/](server/) so the firmware does something the
moment you flash it — swap it for your own once you know what you want on screen.

## The design rule everything follows

**The device is dumb.** It polls `GET /status/{key}` and draws exactly what comes
back: a title, a state word, a colour, and up to five label/value lines. There is
no formatting logic, no thresholds and no agent-specific knowledge in this
firmware. Changing what a screen says is a one-file edit on the server — no OTA,
no site visit.

**Except one thing.** The server cannot tell you it is unreachable. If this device
can't complete a poll for `OFFLINE_AFTER_MS` (2 minutes), it stops showing the
last payload and declares OFFLINE. A screen quietly displaying two-hour-old "all
good" is the exact failure this product exists to prevent, so that rule is
device-side and must never be relaxed into "keep showing the last known state".

## First build

```bash
pip install platformio
```

```bash
cp src/config.h.example src/config.h
```

Nothing device-specific goes in that file. Both the **server host** and the
**device key** are entered in the setup portal on first boot and stored in NVS,
so one binary serves every unit and an update never overwrites which agent a
screen shows. Register a device with:

```bash
cd server && node add-device.js "Desk — Vega" vega
```

See [server/README.md](server/README.md) for the reference server. It is a
zero-dependency stand-in so this firmware does something the moment you flash it;
swap it for your own once you know what you want on the screen.

Then flash. **Pick the environment that matches your board revision** — see
[docs/board-revisions.md](docs/board-revisions.md). If you don't know yet, start
with `esp32-2432S028Rv3` and look at the screen:

```bash
pio run -e esp32-2432S028Rv3 -t upload
```

A photo-negative screen means the wrong environment. Nothing is damaged; try
`esp32-2432S028Rv2`, then `esp32-2432S028R`.

On first boot with no saved WiFi the device raises an open AP called
`AgentStatus-Setup` and serves a captive portal. That's also how a client
re-provisions it after changing their router password.

## What's in here

| Path | |
|---|---|
| `src/main.cpp` | poll loop, rendering, offline rule, OTA client |
| `src/config.h.example` | per-unit settings; copy to `config.h` (gitignored — the key is a credential) |
| `include/lv_conf.h` | LVGL config, vendored from esp32-smartdisplay-demo, Montserrat 20/28 enabled |
| `include/root_ca.h` | pinned ISRG Root X1 so TLS is verified, not just encrypted |
| `boards/` | pinned board definitions — see `boards/README.md` |
| `enclosure/` | walnut case notes and STL fallbacks |

## OTA — server side is not built yet

The client is implemented and runs on boot then hourly. It expects a manifest:

```json
{ "version": "0.2.0", "url": "https://your-server.example.com/firmware/asd-0.2.0.bin" }
```

at `https://your-server.example.com/firmware/manifest.json`. **That endpoint does
not exist yet.** It needs one nginx location on the VPS, mirroring the existing
`/previews/` block — static files, `auth_basic off`, no backend code:

```nginx
location /firmware/ {
    auth_basic off;
    alias /var/www/agent-firmware/;
    autoindex off;
}
```

Until it exists the device logs a failed manifest fetch and carries on polling —
OTA failure is never allowed to stop the display from working.

Release process once it's up: bump `FIRMWARE_VERSION` in `platformio.ini`, `pio
run -e <env>`, copy `.pio/build/<env>/firmware.bin` to `/var/www/agent-firmware/`
and update `manifest.json`. The device won't re-flash an equal version string.

## Not verified yet

This has **not been compiled** — PlatformIO isn't installed on the dev machine
and the boards hadn't arrived when it was written (ordered 2 Aug 2026, ETA 9–17
Aug). Board definitions, the LVGL config and the display driver flags were taken
from upstream rather than guessed, but expect the first `pio run` to surface
something.

## Why it's built this way

[docs/decisions.md](docs/decisions.md) records the decisions and what each one
cost to learn — most exist because something failed on real hardware first. Read
it before changing the staleness rules, the partition table or the memory
overrides. [CHANGELOG.md](CHANGELOG.md) has the version history.

## Licence

MIT — see [LICENSE](LICENSE).
