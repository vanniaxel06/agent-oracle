#!/usr/bin/env bash
#
# Build the browser-flashable image.
#
# This is NOT your normal build. It compiles with src/config.h.example, so the
# compiled-in fallback host is the placeholder rather than whatever server you
# happen to use. Anyone who flashes this from a web page gets a device that asks
# for its own server in the setup portal — instead of one quietly pointed at
# yours. Since 0.4.0 both host and device key live in NVS, so a single image
# genuinely serves everybody.
#
# Output: flasher/agent-oracle-<version>.bin — bootloader, partition table,
# boot_app0 and firmware merged into one image at offset 0, which is what
# ESP Web Tools expects.
#
#   scripts/build-public.sh [env]

set -euo pipefail
cd "$(dirname "$0")/.."

ENV_NAME="${1:-esp32-2432S028R}"
VERSION=$(grep -oP "FIRMWARE_VERSION=\"\K[^\"]+" platformio.ini)
BUILD=".pio/build/${ENV_NAME}"
OUT="flasher/agent-oracle-${VERSION}.bin"

# Swap in the placeholder config, and put the real one back whatever happens —
# an interrupted build must not leave your own config replaced.
RESTORE=0
if [ -f src/config.h ]; then
  cp src/config.h src/.config.h.bak
  RESTORE=1
fi
cleanup() {
  if [ "$RESTORE" = "1" ]; then mv -f src/.config.h.bak src/config.h; fi
}
trap cleanup EXIT

cp src/config.h.example src/config.h
echo "→ building ${ENV_NAME} v${VERSION} with the placeholder host"
python -m platformio run -e "$ENV_NAME"

grep -q "status.example.com" "$BUILD/firmware.bin" && echo "  ✓ placeholder host present" || {
  echo "  ✗ placeholder host NOT found in the binary — refusing to publish" >&2
  exit 1
}

ESPTOOL=$(find "$HOME/.platformio/packages/tool-esptoolpy" -name esptool.py 2>/dev/null | head -1)
BOOT_APP0=$(find "$HOME/.platformio/packages/framework-arduinoespressif32" -name boot_app0.bin 2>/dev/null | head -1)
[ -n "$ESPTOOL" ] && [ -n "$BOOT_APP0" ] || { echo "esptool or boot_app0 not found" >&2; exit 1; }

mkdir -p flasher
echo "→ merging bootloader + partitions + boot_app0 + firmware"
python "$ESPTOOL" --chip esp32 merge_bin -o "$OUT" \
  --flash_mode dio --flash_freq 40m --flash_size 4MB \
  0x1000  "$BUILD/bootloader.bin" \
  0x8000  "$BUILD/partitions.bin" \
  0xe000  "$BOOT_APP0" \
  0x10000 "$BUILD/firmware.bin"

# The web manifest is ESP Web Tools' format — NOT the OTA manifest the firmware
# polls. Different consumers, different shape, easy to confuse.
cat > flasher/manifest.json <<JSON
{
  "name": "Agent Oracle",
  "version": "${VERSION}",
  "new_install_prompt_erase": true,
  "builds": [
    {
      "chipFamily": "ESP32",
      "parts": [{ "path": "agent-oracle-${VERSION}.bin", "offset": 0 }]
    }
  ]
}
JSON

echo
echo "✓ ${OUT} ($(du -h "$OUT" | cut -f1))"
echo "  flasher/manifest.json updated to ${VERSION}"
echo "  Commit flasher/ and GitHub Pages serves it."
