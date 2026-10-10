#!/usr/bin/env bash
# Ubuntu 22.04+ / Debian 12+, x86_64 or arm64. Run from the extracted project directory.
# Usage: sudo bash deploy.sh game.example.com [admin@example.com]
set -Eeuo pipefail
umask 027
export DEBIAN_FRONTEND=noninteractive

DOMAIN="${1:-}"
EMAIL="${2:-}"
BASE=/opt/state-io
STATE=/var/lib/state-io
SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
WORK=""
trap 'if [[ -n "$WORK" && "$WORK" == /tmp/state-io.* && -d "$WORK" ]]; then rm -rf -- "$WORK"; fi' EXIT
trap 'echo "Installation failed at line $LINENO. Inspect: journalctl -u state-io -n 80" >&2' ERR

[[ $EUID -eq 0 ]] || { echo 'Run this script with sudo.' >&2; exit 1; }
[[ "$DOMAIN" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ && ${#DOMAIN} -le 253 ]] || { echo 'Usage: sudo bash deploy.sh game.example.com admin@example.com' >&2; exit 1; }
if [[ -n "$EMAIL" ]]; then
  [[ "$EMAIL" =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]] || { echo 'Provide a valid email for HTTPS certificate renewal.' >&2; exit 1; }
  CERTBOT_ACCOUNT=(--email "$EMAIL")
else
  CERTBOT_ACCOUNT=(--register-unsafely-without-email)
fi
[[ -f "$SOURCE/server.mjs" && -d "$SOURCE/public" ]] || { echo 'Keep deploy.sh beside server.mjs and public/.' >&2; exit 1; }
[[ "$SOURCE" != "$BASE/current" && "$SOURCE" != "$BASE/releases/"* ]] || { echo 'Run from a separate extracted source directory.' >&2; exit 1; }
[[ -f /etc/os-release ]] || { echo 'Ubuntu/Debian required.' >&2; exit 1; }
. /etc/os-release
[[ "$ID" == ubuntu || "$ID" == debian ]] || { echo 'This installer supports Ubuntu and Debian.' >&2; exit 1; }
case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo 'Unsupported CPU architecture.' >&2; exit 1 ;; esac
DOMAIN="${DOMAIN,,}"

echo '[1/7] Installing system packages…'
apt-get update
apt-get install -y ca-certificates curl xz-utils rsync nginx certbot python3-certbot-nginx sqlite3

echo '[2/7] Installing the latest Node.js 24 LTS release…'
WORK="$(mktemp -d /tmp/state-io.XXXXXXXX)"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$WORK/SHASUMS256.txt"
NODE_ARCHIVE="$(awk -v arch="$ARCH" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {print $2}' "$WORK/SHASUMS256.txt")"
[[ "$NODE_ARCHIVE" =~ ^node-v24\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]] || { echo 'Unable to determine official Node.js archive.' >&2; exit 1; }
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "https://nodejs.org/dist/latest-v24.x/$NODE_ARCHIVE" -o "$WORK/$NODE_ARCHIVE"
(cd "$WORK" && awk -v name="$NODE_ARCHIVE" '$2 == name' SHASUMS256.txt | sha256sum --check --status)
install -d -m 755 "$BASE" "$BASE/runtime" "$BASE/releases"
NODE_DIR="${NODE_ARCHIVE%.tar.xz}"
if [[ ! -x "$BASE/runtime/$NODE_DIR/bin/node" ]]; then tar -xJf "$WORK/$NODE_ARCHIVE" -C "$BASE/runtime"; fi
chmod -R a+rX "$BASE/runtime/$NODE_DIR"
ln -sfn -- "$BASE/runtime/$NODE_DIR" "$BASE/node"
"$BASE/node/bin/node" --version

echo '[3/7] Preparing user, persistent data and application release…'
if ! id stateio >/dev/null 2>&1; then useradd --system --user-group --home-dir "$STATE" --shell /usr/sbin/nologin stateio; fi
install -d -m 750 -o stateio -g stateio "$STATE" "$STATE/backups"
install -d -m 750 -o root -g stateio /etc/state-io
RELEASE="$BASE/releases/$(date -u +%Y%m%dT%H%M%SZ)-$$"
install -d -m 755 "$RELEASE"
rsync -a --exclude='.git/' --exclude='data/' --exclude='.env' --exclude='node_modules/' --exclude='artifacts/' --exclude='*.sqlite*' "$SOURCE/" "$RELEASE/"
chown -R root:root "$RELEASE"
chmod -R a+rX "$RELEASE"
"$BASE/node/bin/node" --check "$RELEASE/server.mjs"
"$BASE/node/bin/node" --check "$RELEASE/public/app.js"
"$BASE/node/bin/node" --test "$RELEASE"/tests/*.test.mjs
cat > /etc/state-io/app.env <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
APP_ORIGIN=https://$DOMAIN
DB_PATH=$STATE/game.sqlite
EOF
chown root:stateio /etc/state-io/app.env
chmod 640 /etc/state-io/app.env
if [[ -f "$STATE/game.sqlite" ]]; then
  sqlite3 "$STATE/game.sqlite" ".backup '$STATE/backups/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ).sqlite'"
  chown stateio:stateio "$STATE"/backups/*.sqlite
fi

echo '[4/7] Installing the systemd service…'
cat > /etc/systemd/system/state-io.service <<'EOF'
[Unit]
Description=State.io game and account server
After=network.target

[Service]
Type=simple
User=stateio
Group=stateio
WorkingDirectory=/opt/state-io/current
EnvironmentFile=/etc/state-io/app.env
ExecStart=/opt/state-io/node/bin/node /opt/state-io/current/server.mjs
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/state-io
UMask=0077
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
EOF
PREVIOUS="$(readlink -f "$BASE/current" 2>/dev/null || true)"
ln -s -- "$RELEASE" "$BASE/current.next"
mv -Tf -- "$BASE/current.next" "$BASE/current"
systemctl daemon-reload
systemctl enable state-io
systemctl restart state-io
READY=0
for attempt in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:3000/api/health >/dev/null; then READY=1; break; fi
  sleep 1
done
if [[ "$READY" != 1 ]]; then
  if [[ -n "$PREVIOUS" && "$PREVIOUS" == "$BASE/releases/"* && -d "$PREVIOUS" ]]; then
    ln -s -- "$PREVIOUS" "$BASE/current.rollback"
    mv -Tf -- "$BASE/current.rollback" "$BASE/current"
    systemctl restart state-io
  fi
  echo 'Application failed its health check. Previous release restored if available.' >&2
  exit 1
fi

echo '[5/7] Configuring Nginx…'
NGINX_CONFIG=/etc/nginx/sites-available/state-io.conf
if [[ -f "$NGINX_CONFIG" ]]; then cp -a "$NGINX_CONFIG" "$WORK/nginx.previous"; fi
cat > "$NGINX_CONFIG" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 100k;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_read_timeout 30s;
        proxy_connect_timeout 5s;
    }
}
EOF
ln -sfn -- "$NGINX_CONFIG" /etc/nginx/sites-enabled/state-io.conf
if ! nginx -t; then
  if [[ -f "$WORK/nginx.previous" ]]; then cp -a "$WORK/nginx.previous" "$NGINX_CONFIG"; fi
  echo 'Nginx configuration check failed; existing config restored if available.' >&2
  exit 1
fi
systemctl enable nginx
systemctl reload-or-restart nginx

echo '[6/7] Obtaining HTTPS certificate…'
echo 'The domain must already point to this server; TCP ports 80 and 443 must be open.'
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then ufw allow 'Nginx Full'; fi
certbot --nginx --non-interactive --agree-tos "${CERTBOT_ACCOUNT[@]}" -d "$DOMAIN" --redirect --keep-until-expiring
systemctl enable --now certbot.timer

echo '[7/7] Installing daily online SQLite backups…'
cat > /usr/local/sbin/state-io-backup <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
BACKUP_DIR=/var/lib/state-io/backups
sqlite3 /var/lib/state-io/game.sqlite ".backup '$BACKUP_DIR/daily-$(date -u +%Y%m%dT%H%M%SZ).sqlite'"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'daily-*.sqlite' -mtime +14 -delete
EOF
chmod 755 /usr/local/sbin/state-io-backup
cat > /etc/systemd/system/state-io-backup.service <<'EOF'
[Unit]
Description=Online backup of State.io SQLite database

[Service]
Type=oneshot
User=stateio
Group=stateio
ExecStart=/usr/local/sbin/state-io-backup
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/state-io
EOF
cat > /etc/systemd/system/state-io-backup.timer <<'EOF'
[Unit]
Description=Daily backup of State.io accounts and saves

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=1800

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now state-io-backup.timer
systemctl start state-io-backup.service
curl --fail --silent --show-error "https://$DOMAIN/api/health"
echo
echo "Ready: https://$DOMAIN"
echo 'Logs: sudo journalctl -u state-io -f'
echo 'Backups: /var/lib/state-io/backups (copy these to another machine regularly).'
echo "Previous release: ${PREVIOUS:-none}. Releases are preserved under /opt/state-io/releases."
