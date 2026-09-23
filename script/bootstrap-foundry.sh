#!/usr/bin/env bash
# Install Foundry for this repo.
#
# The environment is ephemeral: the toolchain disappears between sessions while
# the checkout survives, so `forge test` fails with "command not found" and it
# looks like the repo is broken. Re-run this instead of installing by hand.
#
# Deliberately does NOT pipe a remote install script into a shell. It fetches
# the pinned release tarball and refuses to extract it unless the SHA-256 from
# the same release matches.
set -euo pipefail

VERSION="${FOUNDRY_VERSION:-1.8.3}"
DEST="${FOUNDRY_DEST:-$HOME/.foundry/bin}"
ASSET="foundry_v${VERSION}_linux_amd64"
BASE="https://github.com/foundry-rs/foundry/releases/download/v${VERSION}"

case "$(uname -m)" in
  x86_64) ;;
  aarch64 | arm64) ASSET="foundry_v${VERSION}_linux_arm64" ;;
  *)
    echo "unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

if [ -x "$DEST/forge" ] && "$DEST/forge" --version 2>/dev/null | grep -q "Version: ${VERSION}"; then
  echo "forge ${VERSION} already present at $DEST"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "downloading ${ASSET}..."
curl -sSL -o "$tmp/foundry.tar.gz" "${BASE}/${ASSET}.tar.gz"
curl -sSL -o "$tmp/foundry.sha256" "${BASE}/${ASSET}.sha256"

expected="$(awk '{print $1}' "$tmp/foundry.sha256")"
actual="$(sha256sum "$tmp/foundry.tar.gz" | awk '{print $1}')"
if [ "$expected" != "$actual" ]; then
  echo "checksum mismatch: expected $expected, got $actual" >&2
  exit 1
fi
echo "checksum ok"

mkdir -p "$DEST"
tar -xzf "$tmp/foundry.tar.gz" -C "$DEST"

echo "installed to $DEST"
echo "add it to PATH for this shell:  export PATH=\"\$PATH:$DEST\""
"$DEST/forge" --version
