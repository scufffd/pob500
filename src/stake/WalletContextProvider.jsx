import { useMemo } from 'react';
import {
  ConnectionProvider,
  WalletProvider,
} from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import { WalletConnectWalletAdapter } from '@solana/wallet-adapter-walletconnect';
import { clusterApiUrl } from '@solana/web3.js';

import '@solana/wallet-adapter-react-ui/styles.css';

const DEFAULT_ENDPOINT =
  import.meta.env.VITE_SOLANA_RPC || clusterApiUrl('mainnet-beta');
const WALLETCONNECT_PROJECT_ID = (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '').trim();
const DEFAULT_NETWORK = /devnet/i.test(DEFAULT_ENDPOINT)
  ? WalletAdapterNetwork.Devnet
  : WalletAdapterNetwork.Mainnet;

export default function WalletContextProvider({ children }) {
  const endpoint = useMemo(() => DEFAULT_ENDPOINT, []);
  const wallets = useMemo(
    () => {
      const adapters = [new PhantomWalletAdapter(), new SolflareWalletAdapter()];
      if (WALLETCONNECT_PROJECT_ID) {
        adapters.push(
          new WalletConnectWalletAdapter({
            network: DEFAULT_NETWORK,
            options: {
              relayUrl: 'wss://relay.walletconnect.com',
              projectId: WALLETCONNECT_PROJECT_ID,
              metadata: {
                name: 'POB500',
                description: 'POB500 staking',
                url: 'https://pob500.com',
                icons: ['https://pob500.com/favicon.ico'],
              },
            },
          }),
        );
      }
      return adapters;
    },
    [],
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
