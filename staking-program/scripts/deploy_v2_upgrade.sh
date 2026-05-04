#!/usr/bin/env bash
# Deploy the v2 admin-instructions upgrade for pob-index-stake.
#
# Adds (no state changes, no modifications to value-bearing logic):
#   - set_pool_authority(new_authority: Pubkey)
#   - set_paused(paused: bool)
#   - sweep_reward_vault(amount: u64)
#   - admin_reset_checkpoint(new_acc_per_share: u128)
#   - admin_reset_reward_mint(new_acc_per_share: u128, new_total_deposited: u64, new_total_claimed: u64)
#
# Existing 10 instructions and account layouts are unchanged. Old client
# code keeps working without any redeploy.
#
# WHY THE EXTEND STEP: the v2 .so is 482,224 bytes. The currently-deployed
# ProgramData buffer is 452,045 bytes. We need to grow the on-chain buffer
# by 30,179 bytes before `solana program upgrade` will accept the new .so.
# The extend incurs a one-time rent payment (~0.21 SOL); the upgrade
# itself uses a write-buffer that's reclaimed (~3.4 SOL temporary).
#
# Run this from the staking-program directory of this repo.
#
# Authority keypair (`bankUKLhk6C4dzMnWopd2umgstLH9Y1oTWAxDw94Cgp`) is the
# program's on-chain BPF upgrade authority. Override AUTH_KEYPAIR / SO_PATH
# below or via env if your local layout differs.
#
# Pre-flight balance check, extend, then deploy. Fails fast on each step.

set -euo pipefail

PROGRAM_ID="65YrGaBL5ukm4SVcsEBoUgnqTrNXy2pDiPKeQKjSexVA"
AUTH_KEYPAIR="${AUTH_KEYPAIR:-./scripts/bank-starts-keypair.json}"
SO_PATH="${SO_PATH:-./target/deploy/pob_index_stake.so}"
RPC_URL="${RPC_URL:-https://api.mainnet-beta.solana.com}"
EXTEND_BYTES=40000   # comfortable headroom; ~10KB beyond what we need today

if [[ "${1:-}" == "--help" ]]; then
  grep '^#' "$0" | head -40
  exit 0
fi

echo "=============================================================="
echo "pob-index-stake v2 upgrade"
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

# Validate auth matches on-chain upgrade authority
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

NEED_LAMPORTS=3500000000  # 3.5 SOL — write-buffer (~3.36) + extend (~0.21) + tx fees
NEED_SOL=$(awk "BEGIN { printf \"%.4f\", $NEED_LAMPORTS / 1e9 }")
if (( BAL_LAMPORTS < NEED_LAMPORTS )); then
  echo "  ERROR: need at least $NEED_SOL SOL on $AUTH_PUBKEY for the upgrade" >&2
  echo "  Top up via: solana transfer $AUTH_PUBKEY <amount> --keypair <funder> --url $RPC_URL" >&2
  exit 1
fi
echo "  ✓ sufficient balance for upgrade"

SO_BYTES=$(stat -f%z "$SO_PATH")
echo "  .so size:       $SO_BYTES bytes"

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
echo "Upgrade complete. Next steps:"
echo "=============================================================="
echo "  1. cd <stakrr-repo>/worker"
echo "  2. node scripts/remediate_sqwark.mjs               # dry-run plan"
echo "  3. node scripts/remediate_sqwark.mjs --execute     # send the 12 txs"
echo
echo "  The remediation script reads POOL_AUTH from worker/.env (already set)"
echo "  and walks: pause → sweep 91.9M SQWARK → reset reward state → reset"
echo "  GE9JWdz checkpoint → prime 7 other positions → unpause."
echo
