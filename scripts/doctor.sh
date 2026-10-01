#!/usr/bin/env bash
# Checks that this machine can run the full Early Signals build (make reproduce). PASS / WARN / FAIL per check.
# SKIP_MYSQL=1 skips the MySQL checks (make reproduce-no-mysql). Exit code 1 when anything FAILs.
set -uo pipefail
cd "$(dirname "$0")/.."
[[ -f .env ]] && { set -a; source .env; set +a; }
SCALE=${SCALE:-1.0}
SKIP_MYSQL=${SKIP_MYSQL:-0}
fails=0; warns=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n        -> %s\n' "$1" "$2"; warns=$((warns + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n        -> %s\n' "$1" "$2"; fails=$((fails + 1)); }
gb() { awk -v k="$1" 'BEGIN { printf "%.1f", k / 1048576 }'; }

echo "Early Signals doctor (SCALE=${SCALE}, MySQL checks: $([[ $SKIP_MYSQL == 1 ]] && echo off || echo on))"

# --- machine
os=$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -s)
[[ "$os" == *Ubuntu* ]] && pass "OS: $os" || warn "OS: $os" "SETUP.md is written for Ubuntu 22.04/24.04; other Linux distros need equivalent packages"
cpus=$(nproc 2>/dev/null || echo 1)
[[ $cpus -ge 4 ]] && pass "CPU cores: $cpus" || warn "CPU cores: $cpus" "the timings in SETUP.md assume 4 cores; expect proportionally longer runs"
mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
if   (( mem_kb >= 15 * 1048576 )); then pass "RAM: $(gb "$mem_kb") GB"
elif (( mem_kb >= 8 * 1048576 ));  then warn "RAM: $(gb "$mem_kb") GB" "16 GB recommended; set PIPELINE_MEMORY_LIMIT=3GB and innodb_buffer_pool_size=1G (config/mysql/early-signals.cnf)"
else fail "RAM: $(gb "$mem_kb") GB" "at least 8 GB is needed at scale 1.0 (or use: make reproduce SCALE=0.2)"; fi

# --- disk: free space plus the project data a rebuild replaces anyway
free_kb=$(df -Pk . | awk 'NR==2 {print $4}')
reuse_kb=$(du -sk data/bulk data/analytics 2>/dev/null | awk '{s += $1} END {print s + 0}')
mysql_kb=0
if [[ $SKIP_MYSQL != 1 ]]; then
  mysql_kb=$(PYTHONPATH=. uv run --quiet python - 2>/dev/null <<'PY' || echo 0
from generator.loader import connect
try:
    c = connect(None).cursor()
    c.execute("SELECT coalesce(sum(data_length + index_length), 0) / 1024 FROM information_schema.tables WHERE table_schema = 'openmrs'")
    print(int(c.fetchone()[0]))
except Exception:
    print(0)
PY
)
fi
avail_kb=$((free_kb + reuse_kb + mysql_kb))
# measured at scale 1.0: peak ~27 GB with MySQL (data 4 + DuckDB 11 + spill 1.5 + MySQL 12-14), ~15 GB without
need=$([[ $SKIP_MYSQL == 1 ]] && echo 22 || echo 40)
need_min=$([[ $SKIP_MYSQL == 1 ]] && echo 14 || echo 25)
need=$(awk -v n="$need" -v s="$SCALE" 'BEGIN { v = n * s; print (v < 3 ? 3 : v) }')
need_min=$(awk -v n="$need_min" -v s="$SCALE" 'BEGIN { v = n * s; print (v < 2 ? 2 : v) }')
msg="disk for the build: $(gb "$avail_kb") GB (free $(gb "$free_kb") GB + replaced project data $(gb $((reuse_kb + mysql_kb))) GB)"
if awk -v a="$avail_kb" -v n="$need" 'BEGIN { exit !(a >= n * 1048576) }'; then pass "$msg"
elif awk -v a="$avail_kb" -v n="$need_min" 'BEGIN { exit !(a >= n * 1048576) }'; then warn "$msg" "recommended ${need} GB at SCALE=${SCALE}; the live loop also grows MySQL over time"
else fail "$msg" "needs about ${need} GB at SCALE=${SCALE} (generated data ~4 GB, DuckDB ~11 GB, MySQL ~13 GB at scale 1.0)"; fi

# --- toolchain
if command -v uv >/dev/null; then
  pass "uv $(uv --version | awk '{print $2}')"
  py=$(uv run --quiet python -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo "?")
  [[ "$py" == "3.11" ]] && pass "project Python $py (.venv)" || fail "project Python: $py" "run: uv sync --all-extras (uv installs Python 3.11 itself)"
  if uv run --quiet python -c 'import jax, xgboost, duckdb, fastapi, pytest' 2>/dev/null; then pass "Python packages (jax, xgboost, duckdb, fastapi, pytest)"
  else fail "Python packages missing" "run: uv sync --all-extras"; fi
else
  fail "uv not found" "run: curl -LsSf https://astral.sh/uv/install.sh | sh   (or bash scripts/setup_ubuntu.sh)"
fi
node_major=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')
if [[ -n "$node_major" && "$node_major" -ge 22 ]]; then pass "Node $(node -v)"; else fail "Node: $(node -v 2>/dev/null || echo missing)" "install Node 22 (bash scripts/setup_ubuntu.sh)"; fi
[[ -d frontend/node_modules ]] && pass "frontend dependencies installed" || fail "frontend/node_modules missing" "run: cd frontend && npm ci"
[[ -f .env ]] && pass ".env present" || warn ".env missing" "run: cp .env.example .env (defaults are used until then)"
[[ -f frontend/public/models/body.meshopt.glb && -f frontend/public/geo/districts.geojson ]] && pass "3D anatomy + district maps present" \
  || fail "frontend assets missing" "the repository checkout is incomplete; re-clone"

# --- MySQL (live loop)
if [[ $SKIP_MYSQL != 1 ]]; then
  out=$(PYTHONPATH=. uv run --quiet python - 2>&1 <<'PY'
from generator.loader import connect
c = connect(None).cursor()
c.execute("SELECT VERSION(), CURRENT_USER(), @@GLOBAL.local_infile, @@GLOBAL.innodb_fill_factor, @@GLOBAL.innodb_buffer_pool_size DIV 1048576")
print("|".join(str(x) for x in c.fetchone()))
PY
)
  if [[ "$out" == *"|"* ]]; then
    IFS='|' read -r ver usr infile fill pool <<<"$(tail -1 <<<"$out")"
    pass "MySQL $ver reachable as $usr"
    [[ "$ver" == 8.* ]] || warn "MySQL version $ver" "tested with MySQL 8.0"
    [[ "$infile" == 1 ]] && pass "local_infile=ON" || fail "local_infile is OFF" "install config/mysql/early-signals.cnf (bash scripts/setup_ubuntu.sh) and restart MySQL"
    (( pool >= 1024 )) && pass "innodb_buffer_pool_size=${pool} MB" || warn "innodb_buffer_pool_size=${pool} MB" "3G recommended (config/mysql/early-signals.cnf); inserts are much slower otherwise"
    [[ "$fill" -le 90 ]] && pass "innodb_fill_factor=$fill" || warn "innodb_fill_factor=$fill" "the loader sets 80 while building indexes; needs SYSTEM_VARIABLES_ADMIN (setup_ubuntu.sh grants it)"
  else
    fail "MySQL not reachable as ${MYSQL_USER:-root}@${MYSQL_HOST:-127.0.0.1}:${MYSQL_PORT:-3306}" \
         "start MySQL and create the user: bash scripts/setup_ubuntu.sh (error: $(tail -1 <<<"$out" | cut -c1-120))"
  fi
fi

# --- ports
for p in 8000 5173; do
  if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | awk '{print $4}' | grep -qE "[:.]$p$"; then
    warn "port $p is in use" "fine if it is this project's API/dashboard already running; otherwise stop that process before make up"
  else pass "port $p free"; fi
done

echo
if (( fails > 0 )); then echo "doctor: $fails FAIL, $warns WARN - fix the FAIL items first"; exit 1; fi
echo "doctor: ready ($warns WARN)"
