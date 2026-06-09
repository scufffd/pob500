#!/usr/bin/env bash
# Deploy the v5 dynamic-early-unstake upgrade for pob-index-stake.
#
# What changes (logic only — NO new instruction, NO account-layout change):
#   - New positions opt into a LINEAR time-decay early-unstake penalty that
#     starts at EARLY_UNSTAKE_START_BPS (50%) at `lock_start` and decays to
#     EARLY_UNSTAKE_END_BPS (10%) at `lock_end`. The decay is continuous in
#     time (per-second), so it scales identically for 1-day and 30-day locks.
#   - `stake` / `stake_for` set a per-position flag in `position.reserved[2]`
#     (1 = use the dynamic curve). `effective_early_unstake_bps` now resolves:
#         per-position fixed override  (set_position_early_unstake_bps; v4)
#           > v5 dynamic curve         (reserved[2] == 1)
#           > per-pool fixed override
#           > flat 10% global default
#
# Backward compatibility (IMPORTANT — no migration, no remediation):
#   - EVERY existing position has reserved[2] == 0 (never flagged), so it keeps
#     its original FLAT 10% terms. The decay applies to NEW positions only.
#   - reserved[0..2] (v4 fixed override) is untouched and still wins, so KOL /
#     presale anti-dump locks keep their fixed bps and do NOT decay.
#   - StakePosition.reserved is still [u8; 32] and StakePool is unchanged →
#     account sizes are identical. No realloc of any data account.
#   - No instruction signatures or account structs changed → the shipped IDL
#     (worker + frontend) does not need updating for this release.
#
# Run from the staking-program directory of this repo. Override
# AUTH_KEYPAIR / SO_PATH / RPC_URL via env if your layout differs.
# Authority pubkey: bankUKLhk6C4dzMnWopd2umgstLH9Y1oTWAxDw94Cgp.

set -euo pipefail

PROGRAM_ID="65YrGaBL5ukm4SVcsEBoUgnqTrNXy2pDiPKeQKjSexVA"
AUTH_KEYPAIR="${AUTH_KEYPAIR:-./scripts/bank-starts-keypair.json}"
SO_PATH="${SO_PATH:-./target/deploy/pob_index_stake.so}"
RPC_URL="${RPC_URL:-https://api.mainnet-beta.solana.com}"
# Headroom added on top of the exact deficit when extending. Default 0 to keep
# the (permanent) extend rent minimal — the current binary only overflows the
# allocation by ~840 bytes, so we grow by exactly that. Set EXTEND_HEADROOM>0
# if you want to pre-pay for a slightly larger future binary.
EXTEND_HEADROOM="${EXTEND_HEADROOM:-0}"

if [[ "${1:-}" == "--help" ]]; then
  grep '^#' "$0" | head -40
  exit 0
fi

echo "=============================================================="
echo "pob-index-stake v5 upgrade — dynamic early-unstake decay 50%→10%"
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

NEED_LAMPORTS=3500000000  # 3.5 SOL — write-buffer (~3.4) + extend + tx fees
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

# Compute the extend amount: only extend if the new binary doesn't already fit.
DEFICIT=$(( SO_BYTES - CURRENT_DATA_LEN ))
if (( DEFICIT > 0 )); then
  EXTEND_BYTES=$(( DEFICIT + EXTEND_HEADROOM ))
  echo "  after extend:   $(( CURRENT_DATA_LEN + EXTEND_BYTES )) bytes (+$EXTEND_BYTES)"
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
else
  echo "  ✓ current allocation already fits the new binary — no extend needed"
fi

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
echo "v5 upgrade complete. Behaviour summary:"
echo "=============================================================="
echo "  - Existing positions: UNCHANGED (flat 10% — never flagged)."
echo "  - New stakes (stake / stake_for): early-unstake penalty starts at"
echo "    50% on day 1 and decays linearly to 10% at lock end."
echo "  - KOL / presale fixed overrides (v4): still fixed, no decay."
echo "  - No account migration; no IDL change required."
echo
