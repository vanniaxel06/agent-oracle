# Vendored board definitions

These are copies of the PlatformIO board JSONs from
[rzeldent/platformio-espressif32-sunton](https://github.com/rzeldent/platformio-espressif32-sunton),
which upstream ships as a git submodule of `esp32-smartdisplay`.

Vendored rather than submoduled deliberately: hardware config should be pinned to
exactly what was verified against a physical board, and a submodule means a
`git submodule update` can silently change display timings on units already
sitting in someone's office. It also removes the `--recursive` clone footgun.

`platformio.ini` points here via `boards_dir = boards`.

Fetched 2 Aug 2026. See [../docs/board-revisions.md](../docs/board-revisions.md)
for how to refresh one and why you should diff it first.
