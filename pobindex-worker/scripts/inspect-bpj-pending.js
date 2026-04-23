require('dotenv').config({ path: __dirname + '/../.env' });
const { PublicKey } = require('@solana/web3.js');
const anchor = require('@coral-xyz/anchor');
const { getTokenMetadata, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const config = require('../src/config');
const idl = require('../../staking-sdk/src/idl.json');
const BN = require('bn.js');
const ACC = new BN('1000000000000000000');

(async () => {
  const programId = new PublicKey(process.env.POB_STAKE_PROGRAM_ID);
  const stakeMint = new PublicKey(process.env.POB_STAKE_MINT);
  const wallet = { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t };
  const provider = new anchor.AnchorProvider(config.stakeConnection, wallet, { commitment: 'confirmed' });
  const program = new anchor.Program({ ...idl, address: programId.toBase58() }, provider);
  const [pool] = PublicKey.findProgramAddressSync([Buffer.from('pool'), stakeMint.toBuffer()], programId);

  const rewardMints = (await program.account.rewardMint.all([
    { memcmp: { offset: 8 + 1, bytes: pool.toBase58() } },
  ])).filter((a) => a.account.pool.equals(pool));

  const positions = (await program.account.stakePosition.all([
    { memcmp: { offset: 8 + 1, bytes: pool.toBase58() } },
  ])).filter((a) => a.account.pool.equals(pool) && !a.account.closed);

  for (const pos of positions) {
    const eff = new BN(pos.account.effective.toString());
    console.log('Position', pos.publicKey.toBase58().slice(0,10), '... effective=', eff.toString());
    for (const rm of rewardMints) {
      const [ckpt] = PublicKey.findProgramAddressSync(
        [Buffer.from('checkpoint'), pos.publicKey.toBuffer(), rm.publicKey.toBuffer()],
        programId,
      );
      const cp = await program.account.rewardCheckpoint.fetchNullable(ckpt);
      const acc = new BN(rm.account.accPerShare.toString());
      const cpAcc = cp ? new BN(cp.accPerShare.toString()) : new BN(0);
      const claimable = cp ? new BN(cp.claimable.toString()) : new BN(0);
      const delta = acc.sub(cpAcc);
      const accrued = delta.mul(eff).div(ACC);
      const pending = claimable.add(accrued);

      let meta = null;
      try { meta = await getTokenMetadata(config.stakeConnection, rm.account.mint, 'confirmed', TOKEN_2022_PROGRAM_ID); } catch {}
      const ticker = meta?.symbol || rm.account.mint.toBase58().slice(0, 6);
      const decimals = meta?.additionalMetadata ? 6 : 6;
      console.log('  ', ticker.padEnd(10), 'pending (raw u64):', pending.toString(), `  -> ~${(Number(pending.toString()) / 1e6).toFixed(4)} (assuming 6 decimals)`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
