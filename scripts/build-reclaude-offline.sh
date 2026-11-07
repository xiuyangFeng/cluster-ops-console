#!/usr/bin/env bash
set -euo pipefail

VERSION="${VERSION:-latest}"
OUT_DIR="${OUT_DIR:-$PWD/dist}"
REMOTE_PORT="${REMOTE_PORT:-7891}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$OUT_DIR"

LINUX_ARCH="${LINUX_ARCH:-amd64}"
case "$LINUX_ARCH" in
  amd64|arm64)
    binary_name="reclaude-linux-${LINUX_ARCH}"
    ;;
  *)
    echo "Unsupported Linux architecture: $LINUX_ARCH (expected amd64 or arm64)" >&2
    exit 1
    ;;
esac

if [[ "$VERSION" == "latest" ]]; then
  download_url="https://dl.reclaude.ai/latest/${binary_name}"
  package_version="latest"
else
  download_url="https://dl.reclaude.ai/${VERSION}/${binary_name}"
  package_version="${VERSION#v}"
fi

pkg_dir="$TMP_DIR/reclaude-offline-${package_version}-${LINUX_ARCH}"
mkdir -p "$pkg_dir/bin"

echo "Downloading $download_url"
curl -fL "$download_url" -o "$pkg_dir/bin/reclaude"
chmod +x "$pkg_dir/bin/reclaude"

cat > "$pkg_dir/install_reclaude_offline.sh" <<INSTALL
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="\$(cd -- "\$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
PREFIX="\${PREFIX:-\$HOME/.local}"
BIN_DIR="\${BIN_DIR:-\$PREFIX/bin}"
REMOTE_PORT="\${REMOTE_PORT:-${REMOTE_PORT}}"

mkdir -p "\$BIN_DIR"
install -m 0755 "\$SCRIPT_DIR/bin/reclaude" "\$BIN_DIR/reclaude.real"

cat > "\$BIN_DIR/reclaude" <<'WRAPPER'
#!/usr/bin/env bash
REMOTE_PORT="\${REMOTE_PORT:-__REMOTE_PORT__}"
export HTTP_PROXY="\${HTTP_PROXY:-http://127.0.0.1:\${REMOTE_PORT}}"
export HTTPS_PROXY="\${HTTPS_PROXY:-http://127.0.0.1:\${REMOTE_PORT}}"
export http_proxy="\${http_proxy:-http://127.0.0.1:\${REMOTE_PORT}}"
export https_proxy="\${https_proxy:-http://127.0.0.1:\${REMOTE_PORT}}"
unset ALL_PROXY all_proxy
exec "\$HOME/.local/bin/reclaude.real" "\$@"
WRAPPER

perl -0pi -e "s/__REMOTE_PORT__/\$REMOTE_PORT/g" "\$BIN_DIR/reclaude"
chmod +x "\$BIN_DIR/reclaude"

cat > "\$BIN_DIR/claude-codewing" <<'WRAPPER'
#!/usr/bin/env bash
exec "\$HOME/.local/bin/reclaude" "\$@"
WRAPPER
chmod +x "\$BIN_DIR/claude-codewing"

echo "Installed reclaude wrapper to \$BIN_DIR/reclaude"
echo "Installed Claude CodeWing launcher to \$BIN_DIR/claude-codewing"
echo "Remote proxy endpoint: http://127.0.0.1:\$REMOTE_PORT"
"\$BIN_DIR/reclaude" version || true
INSTALL

chmod +x "$pkg_dir/install_reclaude_offline.sh"

cat > "$pkg_dir/README.md" <<README
# ReClaude Linux Offline Package

Generated on: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
Version selector: ${VERSION}
Linux arch: ${LINUX_ARCH}
Remote proxy endpoint: http://127.0.0.1:${REMOTE_PORT}

Install on the cluster:

\`\`\`bash
tar -xzf reclaude-linux-offline-${package_version}-${LINUX_ARCH}.tar.gz
cd reclaude-offline-${package_version}-${LINUX_ARCH}
bash install_reclaude_offline.sh
export PATH="\$HOME/.local/bin:\$PATH"
reclaude version
reclaude login
reclaude status
\`\`\`

Keep the Codex Operations Console HTTP CONNECT reverse tunnel online before
running \`reclaude login\` or \`reclaude\` on a network-isolated cluster.
README

(cd "$pkg_dir" && shasum -a 256 bin/reclaude install_reclaude_offline.sh > SHA256SUMS.txt)
tarball="$OUT_DIR/reclaude-linux-offline-${package_version}-${LINUX_ARCH}.tar.gz"
tar -C "$TMP_DIR" -czf "$tarball" "$(basename "$pkg_dir")"
shasum -a 256 "$tarball" > "${tarball}.sha256"

echo "Created $tarball"
echo "Created ${tarball}.sha256"
