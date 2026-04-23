require('dotenv').config({ path: '/Users/tom/refi/POBINDEX/pobindex-worker/.env' });
const { PublicKey } = require('@solana/web3.js');
const anchor = require('@coral-xyz/anchor');
const { getAccount } = require('@solana/spl-token');
const config = require('/Users/tom/refi/POBINDEX/pobindex-worker/src/config');
const idl = require('/Users/tom/refi/POBINDEX/staking-sdk/src/idl.json');

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
  console.log('Reward mints on pool:', rewardMints.length);

  const positions = (await program.account.stakePosition.all([
    { memcmp: { offset: 8 + 1, bytes: pool.toBase58() } },
  ])).filter((a) => a.account.pool.equals(pool) && !a.account.closed);
  console.log('Open positions:', positions.length);

  for (const pos of positions) {
    console.log('\nPosition', pos.publicKey.toBase58(), 'owner', pos.account.owner.toBase58());
    for (const rm of rewardMints) {
      const [ckpt] = PublicKey.findProgramAddressSync(
        [Buffer.from('checkpoint'), pos.publicKey.toBuffer(), rm.publicKey.toBuffer()],
        programId,
      );
      const cp = await program.account.rewardCheckpoint.fetchNullable(ckpt);
      const vaultInfo = await config.stakeConnection.getParsedAccountInfo(rm.account.vault);
      const vaultAmt = vaultInfo?.value?.data?.parsed?.info?.tokenAmount?.amount || '?';
      console.log('  reward', rm.account.mint.toBase58().slice(0,8), '... acc=', rm.account.accPerShare.toString(),
                  '| ckpt=', cp ? cp.accPerShare.toString() : 'MISSING',
                  '| vault=', vaultAmt);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
