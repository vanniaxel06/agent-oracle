#!/usr/bin/env bash
# Build a firmware environment and publish it for over-the-air update.
#
#   scripts/release.sh esp32-2432S028Rv3
#
# ORDER MATTERS. The binary is uploaded first and the manifest second, so a
# device that polls mid-release either sees the old version or a manifest whose
# binary already exists — never a manifest pointing at a 404.
#
# The manifest is written to a temp file and moved into place, because mv is
# atomic on the same filesystem and a device must never read a half-written one.
#
# ONE MANIFEST PER BOARD REVISION. The revisions ship different display
# controllers; a shared manifest could hand ST7789 firmware to an ILI9341 unit
# and leave an unreadable screen that only a physical reflash fixes.
#
# The manifest carries a sha256 of the binary. TLS proves you reached the right
# host; it says nothing about whether the bytes on that host are the ones that
# were built. Builds are NOT byte-reproducible - the toolchain embeds paths and
# timestamps - so a version string does not identify a binary, and without a hash
# there is no way to confirm what a deployed unit is actually running.

set -euo pipefail

ENV_NAME="${1:-}"
ALLOW_DOWNGRADE="${2:-}"   # pass --allow-downgrade to publish a deliberate rollback
VPS="${VPS:-}"
REMOTE_DIR="/var/www/agent-firmware"
HOST_URL="${HOST_URL:-}"

if [ -z "$ENV_NAME" ]; then
  echo "usage: scripts/release.sh <env> [--allow-downgrade]" >&2
  echo "  e.g. scripts/release.sh esp32-2432S028R" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

# Deploy target lives OUTSIDE git. Publishing a firmware repo should not publish
# the address of the server that hosts it. Create .release.env (gitignored):
#   VPS=root@your.server
#   HOST_URL=https://your.server
[ -f .release.env ] && . ./.release.env

if [ -z "$VPS" ] || [ -z "$HOST_URL" ]; then
  echo "Set VPS and HOST_URL, either in .release.env or the environment." >&2
  exit 2
fi

VERSION=$(grep -oP "FIRMWARE_VERSION=\"\K[^\"]+" platformio.ini)
if [ -z "$VERSION" ]; then
  echo "could not read FIRMWARE_VERSION from platformio.ini" >&2
  exit 1
fi

BIN_NAME="asd-${ENV_NAME}-${VERSION}.bin"
LOCAL_BIN=".pio/build/${ENV_NAME}/firmware.bin"

echo "→ building ${ENV_NAME} v${VERSION}"
python -m platformio run -e "$ENV_NAME"
[ -f "$LOCAL_BIN" ] || { echo "no binary at $LOCAL_BIN" >&2; exit 1; }

# Refuse to overwrite a published binary. Devices cache binaries as immutable
# (the version is in the filename); silently changing one means two units can
# run different code under the same version string, which is unfalsifiable in
# the field.
if ssh "$VPS" "test -f ${REMOTE_DIR}/${BIN_NAME}"; then
  echo "✗ ${BIN_NAME} already published — bump FIRMWARE_VERSION in platformio.ini" >&2
  exit 1
fi

SHA=$(sha256sum "$LOCAL_BIN" | cut -d" " -f1)
echo "→ sha256 ${SHA}"

echo "→ uploading ${BIN_NAME} ($(du -h "$LOCAL_BIN" | cut -f1))"
ssh "$VPS" "mkdir -p ${REMOTE_DIR}"
scp -q "$LOCAL_BIN" "${VPS}:${REMOTE_DIR}/${BIN_NAME}"

DOWNGRADE_FIELD=""
if [ "$ALLOW_DOWNGRADE" = "--allow-downgrade" ]; then
  DOWNGRADE_FIELD=',"allow_downgrade":true'
  echo "→ publishing manifest-${ENV_NAME}.json  (ROLLBACK: downgrade permitted)"
else
  echo "→ publishing manifest-${ENV_NAME}.json"
fi
ssh "$VPS" "cat > ${REMOTE_DIR}/.manifest-${ENV_NAME}.tmp <<'JSON'
{\"version\":\"${VERSION}\",\"url\":\"${HOST_URL}/firmware/${BIN_NAME}\",\"sha256\":\"${SHA}\"${DOWNGRADE_FIELD}}
JSON
mv ${REMOTE_DIR}/.manifest-${ENV_NAME}.tmp ${REMOTE_DIR}/manifest-${ENV_NAME}.json
chmod 644 ${REMOTE_DIR}/manifest-${ENV_NAME}.json ${REMOTE_DIR}/${BIN_NAME}"

echo
echo "✓ released ${ENV_NAME} v${VERSION}"
echo "  manifest: ${HOST_URL}/firmware/manifest-${ENV_NAME}.json"
echo "  binary:   ${HOST_URL}/firmware/${BIN_NAME}"
echo
echo "  Devices on this revision pick it up within an hour, or at next boot."
