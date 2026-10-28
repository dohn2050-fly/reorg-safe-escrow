import { createConfig, http } from "wagmi";
import { hardhat, sepolia } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";
import type { Address } from "viem";

export const ESCROW_ADDRESS = (import.meta.env.VITE_ESCROW_ADDRESS ?? "0x5FbDB2315678afecb367f032d93F642f64180aa3") as Address;
export const INDEXER_URL: string = import.meta.env.VITE_INDEXER_URL ?? "http://127.0.0.1:4000";
const LOCAL_RPC: string = import.meta.env.VITE_RPC_URL ?? "http://127.0.0.1:8545";
const WC_PROJECT_ID: string | undefined = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || undefined;

export const config = createConfig({
  chains: [hardhat, sepolia],
  connectors: [
    injected(), // MetaMask, Rabby, Brave, ... (EIP-1193 / EIP-6963)
    ...(WC_PROJECT_ID ? [walletConnect({ projectId: WC_PROJECT_ID, showQrModal: true })] : []),
  ],
  transports: {
    [hardhat.id]: http(LOCAL_RPC),
    [sepolia.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
