# Board revisions — which environment to flash

The ESP32-2432S028R ships in at least three revisions that are **not**
interchangeable. Sellers list them all as "ESP32-2432S028R" and the AliExpress
listing text is frequently wrong about which one is in the box. This is a known
trap, not bad luck — the boards ordered on 2 Aug 2026 were listed as ILI9341 but
the product photo showed dual USB, which usually means a later revision.

## The three

| PlatformIO env | USB | Controller | Notes |
|---|---|---|---|
| `esp32-2432S028R` | listed single micro-USB — **but our dual-USB units are this one** | ILI9341 | no inversion; BGR colour space |
| `esp32-2432S028Rv2` | dual (Type-C + micro) | ILI9341 | custom init sending `0x21` (INVON) |
| `esp32-2432S028Rv3` | dual (Type-C + micro) | ST7789 | SPI mode 3, RGB colour space |

Verified by reading the upstream board definitions directly, not from the
listing:
`gh api repos/rzeldent/platformio-espressif32-sunton/contents/<board>.json`

## What we actually received (7 Aug 2026)

Two USB ports, resistive touch, stylus included — and it is **`esp32-2432S028R`**,
the definition documented as single-USB. Port count does not identify the
revision. We flashed Rv3 and Rv2 first on that assumption and lost time.

Flash `esp32-2432S028R` first. It is now `default_envs`.

## Diagnosing by looking at it

- **Photo-negative / inverted colours** — wrong revision. Green reads magenta,
  black reads white. Try the next environment.
- **White or black screen, backlight on, no content** — wrong controller
  entirely; almost certainly ILI9341 firmware on an ST7789 panel or vice versa.
- **Colours swapped but not inverted** (red↔blue) — colour space mismatch,
  meaning you're on an env with the wrong `COLOR_SPACE` flag.
- **Correct** — start here: `esp32-2432S028R`, confirmed on our hardware.

**Do not diagnose the panel by reading text on it.** A dead flush path, a wrong
colour space, a wrong inversion and a plain layout bug all look like "mangled
text" in a photo, and telling them apart by eye cost several flash cycles. The
firmware boots with a `selftest()` that floods the screen RED, GREEN, BLUE for
1.5s each: solid colours are unambiguous. Use that first, always.

Reflashing between environments is free and safe. Nothing is damaged by trying
the wrong one.

## Once you know

Set it as `default_envs` in `platformio.ini` and write the revision on the back
of the unit in pencil before it goes in a case. Case STLs are revision-specific
too — the USB cutouts differ.

## Refreshing the pinned definitions

`boards/*.json` are vendored copies, not a submodule, so the hardware config is
pinned to what was verified. To update:

```bash
gh api repos/rzeldent/platformio-espressif32-sunton/contents/esp32-2432S028Rv3.json --jq '.content' | base64 -d > boards/esp32-2432S028Rv3.json
```

Diff before committing — a silent upstream pin change on working hardware is
exactly the kind of thing that turns into a mystery field failure.
