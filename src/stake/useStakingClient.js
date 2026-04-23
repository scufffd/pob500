import { useEffect, useMemo, useState } from 'react';
import { useAnchorWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';

import { StakeClient, getStakeProgram, makeProvider } from '../../staking-sdk/src/client.js';

function parsePk(value, fallback) {
  if (!value) return fallback;
  try {
    return new PublicKey(value);
  } catch {
    return fallback;
  }
}

export function useStakingClient() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  const programId = useMemo(
    () => parsePk(import.meta.env.VITE_POB_STAKE_PROGRAM_ID, null),
    [],
  );
  const stakeMint = useMemo(
    () => parsePk(import.meta.env.VITE_POB_STAKE_MINT, null),
    [],
  );

  // Detect once per (connection, stakeMint) whether this is Token-2022 or
  // legacy SPL. Must run before we construct StakeClient so every ATA we build
  // — client-side and inside the SDK — targets the right token program.
  const [stakeTokenProgram, setStakeTokenProgram] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setStakeTokenProgram(null);
    if (!connection || !stakeMint) return undefined;
    (async () => {
      try {
        const info = await connection.getAccountInfo(stakeMint);
        if (cancelled) return;
        if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
          setStakeTokenProgram(TOKEN_2022_PROGRAM_ID);
        } else {
          setStakeTokenProgram(TOKEN_PROGRAM_ID);
        }
      } catch {
        if (!cancelled) setStakeTokenProgram(TOKEN_PROGRAM_ID);
      }
    })();
    return () => { cancelled = true; };
  }, [connection, stakeMint]);

  const ready = !!(connection && wallet && programId && stakeMint && stakeTokenProgram);

  const client = useMemo(() => {
    if (!ready) return null;
    const provider = makeProvider(connection, wallet);
    const program = getStakeProgram(provider, programId);
    return new StakeClient({ program, programId, stakeMint, stakeTokenProgram });
  }, [ready, connection, wallet, programId, stakeMint, stakeTokenProgram]);

  return {
    client,
    ready,
    wallet,
    connection,
    programId,
    stakeMint,
    stakeTokenProgram,
    notConfigured: !programId || !stakeMint,
  };
}
