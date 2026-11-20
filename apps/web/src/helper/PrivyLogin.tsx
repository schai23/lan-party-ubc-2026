// Loaded lazily, only when VITE_PRIVY_APP_ID is set. Email login + Solana embedded wallet created on login.
import { useEffect } from 'react';
import { PrivyProvider, usePrivy, useSolanaWallets } from '@privy-io/react-auth';
import { PRIVY_APP_ID } from '../env';

export interface PrivyIdentity { email: string; wallet: string }

function Inner({ onLogin }: { onLogin: (id: PrivyIdentity) => void }) {
  const { ready, authenticated, login, user } = usePrivy();
  const { wallets, createWallet } = useSolanaWallets();
  const wallet = wallets[0]?.address ?? '';
  const email = user?.email?.address ?? '';
  useEffect(() => {
    if (ready && authenticated && !wallet) createWallet().catch(() => undefined);
  }, [ready, authenticated, wallet, createWallet]);
  useEffect(() => {
    if (authenticated && wallet) onLogin({ email, wallet });
  }, [authenticated, wallet, email, onLogin]);
  if (!ready) return <div className="dim">Loading login…</div>;
  if (!authenticated)
    return (
      <button className="big" onClick={() => login({ loginMethods: ['email'] })}>
        Log in with email
      </button>
    );
  return <div className="dim">Setting up your wallet…</div>;
}

export default function PrivyLogin({ onLogin }: { onLogin: (id: PrivyIdentity) => void }) {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ['email'],
        appearance: { theme: 'dark', walletChainType: 'solana-only' },
        embeddedWallets: { solana: { createOnLogin: 'users-without-wallets' }, showWalletUIs: false },
      }}
    >
      <Inner onLogin={onLogin} />
    </PrivyProvider>
  );
}
