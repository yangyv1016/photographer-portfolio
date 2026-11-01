#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
cd /opt/yangyu/current
python3 -c 'import getpass,json,sys; print("Administrator username: ",end="",file=sys.stderr,flush=True); username=input(); password=getpass.getpass("Administrator password (12+ characters): "); confirmation=getpass.getpass("Confirm password: "); sys.exit("Passwords differ.") if password != confirmation else None; print(json.dumps({"username":username,"password":password}))' |
  runuser -u yangyu -- env DATA_DIRECTORY=/var/lib/yangyu /opt/yangyu-runtime/node/bin/node app/setup-admin.mjs
