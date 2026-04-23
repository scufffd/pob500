#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# golive.sh — rotate POB500 to a new token mint and ship it to pob500.com
#
# What it does (in order):
#   1. Sanity-check args and required env
#   2. Update the LOCAL frontend .env.local with the new stake mint
#   3. Update the SERVER worker .env (POB_STAKE_MINT) over ssh
#   4. Initialize (or confirm) the new staking pool on-chain
#   5. Rebuild the frontend locally (`npm run build`) — server is too small
#   6. rsync dist/ + worker source to the server
#   7. `pm2 reload pob500-worker --update-env` + tail logs for one cycle
#
# Usage:
#   ./scripts/golive.sh <NEW_STAKE_MINT>
#
# Env required on the caller (i.e. your laptop):
#   SSH_KEY   default /Users/tom/solana-snp/fund/memefund/first-key-private.pem
#   SSH_HOST  default root@45.55.89.205
#   SRV_ROOT  default /var/www/pob500.com
#
# The caller must already have .env files set up locally with treasury +
# admin private keys — those are never re-synced by this script (they live
# on the server already and rotate only when you explicitly replace them).
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <NEW_STAKE_MINT>" >&2
  exit 2
fi

NEW_MINT="$1"

# Cheap base58-ish length check. Solana mints are exactly 32 bytes → 43–44
# base58 chars. This rejects obvious typos before we ssh anywhere.
if [[ ! "$NEW_MINT" =~ ^[1-9A-HJ-NP-Za-km-z]{43,44}$ ]]; then
  echo "error: '$NEW_MINT' does not look like a Solana mint address" >&2
  exit 2
fi

SSH_KEY="${SSH_KEY:-/Users/tom/solana-snp/fund/memefund/first-key-private.pem}"
SSH_HOST="${SSH_HOST:-root@45.55.89.205}"
SRV_ROOT="${SRV_ROOT:-/var/www/pob500.com}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\n\033[1;36m[golive]\033[0m %s\n' "$*"; }

# ── 1. Update local frontend .env.local ───────────────────────────────────────
log "1/7 updating local .env.local (VITE_POB_STAKE_MINT=$NEW_MINT)"
if [[ ! -f .env.local ]]; then
  echo "error: .env.local not found at $REPO_ROOT" >&2
  exit 1
fi
# Preserve everything else in .env.local — only flip this one key.
sed -i.bak -E "s|^VITE_POB_STAKE_MINT=.*|VITE_POB_STAKE_MINT=$NEW_MINT|" .env.local
grep '^VITE_POB_STAKE_MINT=' .env.local

# ── 2. Update server worker .env ──────────────────────────────────────────────
log "2/7 updating server .env (POB_STAKE_MINT=$NEW_MINT)"
ssh -i "$SSH_KEY" "$SSH_HOST" "set -e
  ENV=$SRV_ROOT/pobindex-worker/.env
  cp \$ENV \$ENV.bak-\$(date +%Y%m%d-%H%M%S)
  if grep -q '^POB_STAKE_MINT=' \$ENV; then
    sed -i 's|^POB_STAKE_MINT=.*|POB_STAKE_MINT=$NEW_MINT|' \$ENV
  else
    echo 'POB_STAKE_MINT=$NEW_MINT' >> \$ENV
  fi
  grep '^POB_STAKE_MINT=' \$ENV
"

# ── 3. Initialize the pool + register stake-mint as first reward ──────────────
# These two commands are idempotent — stake:init fails gracefully if the pool
# already exists, and register-stake-reward likewise no-ops.
log "3/7 initializing pool on-chain (idempotent)"
ssh -i "$SSH_KEY" "$SSH_HOST" "cd $SRV_ROOT/pobindex-worker \
  && node scripts/stake-admin.js init || true \
  && node scripts/stake-admin.js register-stake-reward || true"

# ── 4. Rebuild frontend locally ───────────────────────────────────────────────
# The droplet has ~150MiB headroom — Vite build would OOM. Build on the dev
# box, rsync the artifact, and let nginx serve it.
log "4/7 npm run build (local — server can't build, too little RAM)"
npm run build >/tmp/pob500-build.log 2>&1 || { tail -n 40 /tmp/pob500-build.log; exit 1; }
ls -la dist/index.html dist/assets/ | tail -n 5

# ── 5. Push dist + worker source to server ───────────────────────────────────
log "5/7 rsyncing dist/ + worker src to $SSH_HOST:$SRV_ROOT"
rsync -a --delete -e "ssh -i $SSH_KEY" dist/ "$SSH_HOST:$SRV_ROOT/dist/"
rsync -a --delete -e "ssh -i $SSH_KEY" \
  --exclude='node_modules' --exclude='data' --exclude='.env' --exclude='*.log' \
  pobindex-worker/ "$SSH_HOST:$SRV_ROOT/pobindex-worker/"
rsync -a --delete -e "ssh -i $SSH_KEY" --exclude='node_modules' \
  staking-sdk/ "$SSH_HOST:$SRV_ROOT/staking-sdk/"

# If the worker gained new dependencies, npm ci on the server. We detect this
# by hashing package-lock.json before + after and skipping the install when
# they match (saves ~30s on no-dep rotations).
log "5b/7 checking if npm ci needed on server"
REMOTE_LOCK_HASH=$(ssh -i "$SSH_KEY" "$SSH_HOST" "sha256sum $SRV_ROOT/pobindex-worker/package-lock.json | cut -d' ' -f1")
LOCAL_LOCK_HASH=$(sha256sum pobindex-worker/package-lock.json | cut -d' ' -f1)
if [[ "$REMOTE_LOCK_HASH" != "$LOCAL_LOCK_HASH" ]]; then
  log "     lockfile changed — running npm ci on server"
  ssh -i "$SSH_KEY" "$SSH_HOST" "cd $SRV_ROOT/pobindex-worker && npm ci --omit=dev"
else
  log "     lockfile unchanged — skipping npm ci"
fi

# ── 6. Reload worker with new env ────────────────────────────────────────────
log "6/7 pm2 reload pob500-worker"
ssh -i "$SSH_KEY" "$SSH_HOST" "pm2 reload pob500-worker --update-env"

# ── 7. Verify ────────────────────────────────────────────────────────────────
log "7/7 waiting 20s and tailing first cycle"
sleep 20
ssh -i "$SSH_KEY" "$SSH_HOST" "pm2 logs pob500-worker --nostream --lines 40 --no-color | tail -n 40"

log "done — live at https://pob500.com  ·  new stake mint: $NEW_MINT"
