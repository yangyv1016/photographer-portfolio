#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
package_directory=$(cd "$(dirname "$0")/.." && pwd)
[[ -x /opt/yangyu-runtime/node/bin/node ]] || { echo 'Run ubuntu/bootstrap.sh first.' >&2; exit 1; }
[[ -f "$package_directory/app/server.mjs" && -d "$package_directory/node_modules/sharp" ]] || { echo 'Use the built production release package.' >&2; exit 1; }
[[ -f /etc/yangyu.env ]] || { echo 'Create /etc/yangyu.env from .env.example first (mode 600, owned by root).' >&2; exit 1; }
chmod 600 /etc/yangyu.env
chown root:root /etc/yangyu.env
if ! id yangyu >/dev/null 2>&1; then useradd --system --home-dir /var/lib/yangyu --shell /usr/sbin/nologin yangyu; fi
install -d -m 750 -o yangyu -g yangyu /var/lib/yangyu
install -d /opt/yangyu/releases
release_directory="/opt/yangyu/releases/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 755 "$release_directory"
cp -a "$package_directory/app" "$package_directory/node_modules" "$package_directory/package.json" "$release_directory/"
chown -R root:root "$release_directory"
chmod -R u=rwX,go=rX "$release_directory"
if [[ -L /opt/yangyu/current ]]; then readlink /opt/yangyu/current > /opt/yangyu/previous-release; fi
ln -sfn "$release_directory" /opt/yangyu/current
install -m 644 "$package_directory/ubuntu/yangyu.service" /etc/systemd/system/yangyu.service
install -m 644 "$package_directory/ubuntu/yangyu-backup.service" /etc/systemd/system/yangyu-backup.service
install -m 644 "$package_directory/ubuntu/yangyu-backup.timer" /etc/systemd/system/yangyu-backup.timer
systemctl daemon-reload
systemctl enable --now yangyu.service yangyu-backup.timer
systemctl restart yangyu.service
echo 'Application installed on loopback. Configure the administrator before enabling the public proxy.'
