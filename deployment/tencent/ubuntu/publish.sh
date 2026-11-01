#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
package_directory=$(cd "$(dirname "$0")/.." && pwd)
case "${1:-}" in
  '') proxy_config=Caddyfile ;;
  --ip) proxy_config=Caddyfile.ip ;;
  *) echo 'Usage: publish.sh [--ip]' >&2; exit 1 ;;
esac
cp "$package_directory/ubuntu/$proxy_config" /etc/caddy/Caddyfile.yangyu
caddy validate --config /etc/caddy/Caddyfile.yangyu --adapter caddyfile
if [[ -f /etc/caddy/Caddyfile ]]; then cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.before-yangyu-$(date -u +%Y%m%dT%H%M%SZ)"; fi
install -m 644 /etc/caddy/Caddyfile.yangyu /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy
echo "HTTPS proxy enabled using $proxy_config."
