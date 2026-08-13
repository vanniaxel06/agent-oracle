# Enclosure

Walnut offcut cases, made in-house. This is the differentiator against every
other ESP32 status gadget, which arrives in printed PLA.

## Constraints that came out of the design work

- **Wood doesn't shield WiFi** — no antenna concerns, unlike a metal case.
- **It does trap heat.** The ESP32 runs warm on a 24/7 static screen; a sealed
  hardwood box needs venting. Slots on the underside, out of sight.
- **Rebate the screen from behind** for a flush bezel. A panel sitting proud of
  the face reads as a prototype.
- **Oil finish, not poly.** Poly yellows over a warm component and looks like
  plastic anyway.
- **M3 brass inserts**, not screws straight into end grain.
- Measure the actual board before cutting — case geometry is revision-specific,
  the dual-USB boards have different port cutouts to the single-USB one.

## Printed fallbacks

If a case is needed before there's shop time, these are known-good STLs for this
board. All revision-specific — check which one you have first
([../docs/board-revisions.md](../docs/board-revisions.md)):

- **jonnybergdahl** (Printables) — CYD2USB variant, Fusion 360 source included,
  so it can be adapted rather than reprinted blind.
- **khpa** (MakerWorld) — slim profile.
- **DE_Markus** (Thingiverse) — includes a desk stand.

## Power

PSUs are sourced locally — RCM-marked, AU plug. Do **not** put AliExpress plug
packs into a client site. The board has a 4-pin JST 1.25 power base, which is a
cleaner entry than a USB cable hanging out of a wooden box.
