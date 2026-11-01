#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
apt-get update
apt-get install -y ca-certificates curl xz-utils gnupg python3 debian-keyring debian-archive-keyring apt-transport-https

# Official Node.js archive, checked against the release SHA-256 manifest.
version=v24.22.2
case "$(uname -m)" in
  x86_64) architecture=x64 ;;
  aarch64) architecture=arm64 ;;
  *) echo 'Unsupported CPU architecture.' >&2; exit 1 ;;
esac
archive="node-${version}-linux-${architecture}.tar.xz"
temporary_directory=$(mktemp -d /tmp/yangyu-runtime.XXXXXX)
trap 'rm -rf -- "$temporary_directory"' EXIT
curl -fL --retry 2 --connect-timeout 15 "https://nodejs.org/download/release/${version}/${archive}" -o "$temporary_directory/$archive"
curl -fL --retry 2 --connect-timeout 15 "https://nodejs.org/download/release/${version}/SHASUMS256.txt" -o "$temporary_directory/SHASUMS256.txt"
(cd "$temporary_directory" && grep "  ${archive}$" SHASUMS256.txt | sha256sum --check --strict -)
install -d /opt/yangyu-runtime
tar -xJf "$temporary_directory/$archive" -C /opt/yangyu-runtime --no-same-owner
ln -sfn "/opt/yangyu-runtime/node-${version}-linux-${architecture}" /opt/yangyu-runtime/node

if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o "$temporary_directory/caddy.gpg"
  gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg "$temporary_directory/caddy.gpg"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  chmod 644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
  systemctl stop caddy
fi
/opt/yangyu-runtime/node/bin/node --version
caddy version
