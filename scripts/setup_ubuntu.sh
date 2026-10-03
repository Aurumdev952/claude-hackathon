#!/usr/bin/env bash
# One-time machine setup for Early Signals on Ubuntu 22.04 / 24.04 (see docs/setup.md).
# Safe to re-run. Asks before every sudo step unless -y is given.
#   bash scripts/setup_ubuntu.sh        # interactive
#   bash scripts/setup_ubuntu.sh -y     # assume yes
set -euo pipefail
cd "$(dirname "$0")/.."

YES=0
[[ "${1:-}" == "-y" ]] && YES=1
say()  { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
ask()  { [[ $YES == 1 ]] && return 0; read -r -p "$1 [Y/n] " a; [[ -z "$a" || "$a" =~ ^[Yy] ]]; }
# run a command as root: directly when already root, otherwise through sudo (keeps the environment for NodeSource)
as_root() { if [[ $EUID -eq 0 ]]; then "$@"; else sudo -E "$@"; fi; }

if ! grep -qi ubuntu /etc/os-release 2>/dev/null; then
  warn "This script targets Ubuntu; continuing, but package names may differ."
fi

say "1/6 System packages (MySQL 8 server, build tools, curl, git)"
if ask "Install/upgrade apt packages with sudo?"; then
  as_root apt-get update -y || warn "apt-get update reported errors (often an unrelated third-party repository); continuing"
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y mysql-server build-essential curl git ca-certificates
fi

say "2/6 Node.js >= 22"
node_major=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)
if [[ "${node_major:-0}" -lt 22 ]]; then
  if ask "Node $(node -v 2>/dev/null || echo 'not found') is older than 22. Install Node 22 from NodeSource?"; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | as_root bash -
    as_root apt-get install -y nodejs
  else
    warn "Install Node 22 yourself (https://nodejs.org) before 'npm ci'."
  fi
fi
echo "node $(node -v 2>/dev/null || echo missing)"

say "3/6 uv (Python package manager; it also installs Python 3.11 for the project)"
if ! command -v uv >/dev/null; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi
uv --version

say "4/6 .env"
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "created .env from .env.example (edit MYSQL_ROOT_PASSWORD before going beyond a local demo)"
fi
set -a; source .env; set +a

say "5/6 MySQL: server settings + application user '${MYSQL_USER}'"
if ask "Copy config/mysql/early-signals.cnf to /etc/mysql/mysql.conf.d/ and restart MySQL?"; then
  as_root install -m 644 config/mysql/early-signals.cnf /etc/mysql/mysql.conf.d/early-signals.cnf
  if command -v systemctl >/dev/null && systemctl list-units >/dev/null 2>&1; then
    as_root systemctl enable --now mysql >/dev/null 2>&1 || true
    as_root systemctl restart mysql
  else
    as_root service mysql restart   # WSL / containers without systemd
  fi
fi
if [[ "${MYSQL_USER}" == "root" ]]; then
  warn "MYSQL_USER=root: skipping user creation (Ubuntu's root uses socket auth; prefer the default es_admin)."
elif ask "Create/update MySQL user '${MYSQL_USER}' (all privileges, localhost only) with the password from .env?"; then
  # the loader drops/recreates the openmrs database, creates the read-only ETL user and sets innodb_fill_factor
  # admin connection: socket auth (fresh Ubuntu), else root with the .env password, else ask for the root password
  if as_root mysql -e "SELECT 1" >/dev/null 2>&1; then admin=(as_root mysql)
  elif mysql -u root -p"${MYSQL_ROOT_PASSWORD}" -e "SELECT 1" >/dev/null 2>&1; then admin=(mysql -u root -p"${MYSQL_ROOT_PASSWORD}")
  else echo "MySQL root needs a password:"; admin=(mysql -u root -p); fi
  "${admin[@]}" <<SQL
CREATE USER IF NOT EXISTS '${MYSQL_USER}'@'localhost' IDENTIFIED BY '${MYSQL_ROOT_PASSWORD}';
CREATE USER IF NOT EXISTS '${MYSQL_USER}'@'127.0.0.1' IDENTIFIED BY '${MYSQL_ROOT_PASSWORD}';
ALTER USER '${MYSQL_USER}'@'localhost' IDENTIFIED BY '${MYSQL_ROOT_PASSWORD}';
ALTER USER '${MYSQL_USER}'@'127.0.0.1' IDENTIFIED BY '${MYSQL_ROOT_PASSWORD}';
GRANT ALL PRIVILEGES ON *.* TO '${MYSQL_USER}'@'localhost' WITH GRANT OPTION;
GRANT ALL PRIVILEGES ON *.* TO '${MYSQL_USER}'@'127.0.0.1' WITH GRANT OPTION;
FLUSH PRIVILEGES;
SQL
  mysql -h "${MYSQL_HOST}" -P "${MYSQL_PORT}" -u "${MYSQL_USER}" -p"${MYSQL_ROOT_PASSWORD}" -N \
        -e "SELECT CONCAT('connected as ', CURRENT_USER(), ', local_infile=', @@local_infile, ', fill_factor=', @@innodb_fill_factor)"
fi

say "6/6 Project dependencies (Python + frontend)"
uv sync --all-extras
(cd frontend && npm ci)
if [[ "${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-0}" == "1" ]]; then
  echo "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1: using the preinstalled browser for E2E tests"
elif ask "Install the Chromium browser for the Playwright E2E tests (uses sudo for its system libraries)?"; then
  (cd frontend && npx playwright install --with-deps chromium)
fi

say "Done. Next:"
cat <<'TXT'
  make doctor        # re-check the machine
  make reproduce     # generate 1.5M patients -> analytics -> models -> MySQL -> verify (~1.5 h)
  make up            # live loop + API + dashboard  ->  http://localhost:5173
TXT
