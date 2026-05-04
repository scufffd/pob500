#!/usr/bin/env bash
# Deploy the v4 per-position-penalty upgrade for pob-index-stake.
#
# Adds (one new instruction; one event field; one error variant):
#   - set_position_early_unstake_bps(bps: u16)
#       Pool-authority-gated. Writes a per-position early-unstake bps
#       override into `position.reserved[0..2]` (LE u16). Capped at 50%.
#       `bps == 0` clears the override.
#   - unstake_early now resolves penalty bps via:
#         position override > pool override > 10% global default
#     instead of the hardcoded 10% that was baked in v1..v3.
#   - UnstakedEarly event gains `penalty_bps_applied: u32` (appended at end;
#     old indexers ignore the trailing bytes — Borsh-tolerant).
#
# Layout safety:
#   - StakePosition.reserved[0..2] is now meaningful. All existing positions
#     have it as zero, which `effective_early_unstake_bps` reads as "no
#     override" → falls through to 10% default → identical pre-upgrade
#     behavior. No realloc, no migration, no remediation.
#   - StakePool.reserved[0..2] is reserved for a future per-pool default
#     setter (not in v4; only the read path is wired). Zero bytes there
#     also resolve to "use global 10%".
#
# Sizing: v3 .so was ~488 KB; v4 .so is ~497 KB (one new ix, ~9 KB extra).
# Currently-deployed ProgramData buffer is 492,000 bytes — needs an extend
# of at least ~5 KB. We extend by 20 KB for headroom against future minor
# tweaks before the next planned major upgrade.
#
# Run from the staking-program directory of this repo.
#
# Override AUTH_KEYPAIR / SO_PATH / RPC_URL via env if your local layout
# differs. Authority pubkey: bankUKLhk6C4dzMnWopd2umgstLH9Y1oTWAxDw94Cgp.

set -euo pipefail

PROGRAM_ID="65YrGaBL5ukm4SVcsEBoUgnqTrNXy2pDiPKeQKjSexVA"
AUTH_KEYPAIR="${AUTH_KEYPAIR:-./scripts/bank-starts-keypair.json}"
SO_PATH="${SO_PATH:-./target/deploy/pob_index_stake.so}"
RPC_URL="${RPC_URL:-https://api.mainnet-beta.solana.com}"
EXTEND_BYTES=20000

if [[ "${1:-}" == "--help" ]]; then
  grep '^#' "$0" | head -50
  exit 0
fi

echo "=============================================================="
echo "pob-index-stake v4 upgrade — per-position early-unstake bps"
echo "=============================================================="
echo "  Program ID:     $PROGRAM_ID"
echo "  RPC:            $RPC_URL"
echo "  .so path:       $SO_PATH"
echo "  Authority:      $AUTH_KEYPAIR"

if [[ ! -f "$SO_PATH" ]]; then
  echo "  ERROR: .so missing — run 'anchor build' first" >&2
  exit 1
fi
if [[ ! -f "$AUTH_KEYPAIR" ]]; then
  echo "  ERROR: authority keypair missing" >&2
  exit 1
fi

AUTH_PUBKEY=$(solana-keygen pubkey "$AUTH_KEYPAIR")
echo "  Auth pubkey:    $AUTH_PUBKEY"

ON_CHAIN_AUTH=$(solana program show "$PROGRAM_ID" --url "$RPC_URL" 2>/dev/null \
  | awk '/Authority:/ { print $2 }')
if [[ "$ON_CHAIN_AUTH" != "$AUTH_PUBKEY" ]]; then
  echo "  ERROR: keypair pubkey ($AUTH_PUBKEY) != on-chain upgrade authority ($ON_CHAIN_AUTH)" >&2
  exit 1
fi
echo "  ✓ keypair matches on-chain upgrade authority"

BAL_LAMPORTS=$(solana balance "$AUTH_PUBKEY" --url "$RPC_URL" --lamports | awk '{print $1}')
BAL_SOL=$(awk "BEGIN { printf \"%.6f\", $BAL_LAMPORTS / 1e9 }")
echo "  Auth balance:   $BAL_SOL SOL"

NEED_LAMPORTS=3500000000  # 3.5 SOL — write-buffer (~3.4) + extend (~0.14) + tx fees
NEED_SOL=$(awk "BEGIN { printf \"%.4f\", $NEED_LAMPORTS / 1e9 }")
if (( BAL_LAMPORTS < NEED_LAMPORTS )); then
  echo "  ERROR: need at least $NEED_SOL SOL on $AUTH_PUBKEY for the upgrade" >&2
  echo "  Top up via: solana transfer $AUTH_PUBKEY <amount> --keypair <funder> --url $RPC_URL" >&2
  exit 1
fi
echo "  ✓ sufficient balance for upgrade"

SO_BYTES=$(stat -f%z "$SO_PATH")
echo "  .so size:       $SO_BYTES bytes"

CURRENT_DATA_LEN=$(solana program show "$PROGRAM_ID" --url "$RPC_URL" 2>/dev/null \
  | awk '/Data Length:/ { print $3 }')
echo "  current alloc:  $CURRENT_DATA_LEN bytes"
echo "  after extend:   $((CURRENT_DATA_LEN + EXTEND_BYTES)) bytes"

echo
echo "--------------------------------------------------------------"
echo "Step 1/2: extend ProgramData by $EXTEND_BYTES bytes"
echo "--------------------------------------------------------------"
echo "  cmd: solana program extend $PROGRAM_ID $EXTEND_BYTES --url $RPC_URL --keypair $AUTH_KEYPAIR"
read -r -p "  proceed? [y/N] " ans
[[ "$ans" =~ ^[Yy]$ ]] || { echo "aborted."; exit 1; }
solana program extend "$PROGRAM_ID" "$EXTEND_BYTES" \
  --url "$RPC_URL" \
  --keypair "$AUTH_KEYPAIR"
echo "  ✓ extended"

echo
echo "--------------------------------------------------------------"
echo "Step 2/2: upgrade program"
echo "--------------------------------------------------------------"
echo "  cmd: solana program deploy $SO_PATH --program-id $PROGRAM_ID --upgrade-authority $AUTH_KEYPAIR --url $RPC_URL"
read -r -p "  proceed? [y/N] " ans
[[ "$ans" =~ ^[Yy]$ ]] || { echo "aborted."; exit 1; }
solana program deploy "$SO_PATH" \
  --program-id "$PROGRAM_ID" \
  --upgrade-authority "$AUTH_KEYPAIR" \
  --url "$RPC_URL"

echo
echo "--------------------------------------------------------------"
echo "Verifying"
echo "--------------------------------------------------------------"
solana program show "$PROGRAM_ID" --url "$RPC_URL"

echo
echo "=============================================================="
echo "v4 upgrade complete. Behaviour summary:"
echo "=============================================================="
echo "  - All existing positions: unchanged (reserved[0..2] is zero,"
echo "    falls through to global 10% default)."
echo "  - New per-launch flows (presale autostake, KOL airdrop, KOL"
echo "    claim accept) can now set a per-position bps override via"
echo "    set_position_early_unstake_bps in the same tx as stake_for."
echo "  - Cap: 50% (MAX_EARLY_UNSTAKE_BPS = 5_000)."
echo
