import { defineChain } from "viem";

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  // Canonical Multicall3 (verified deployed on chain 4663): wagmi batches each useReadContracts into one call.
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

// A local Hardhat node, for development (NEXT_PUBLIC_ENABLE_LOCAL=1). Defined here rather than imported from
// viem/chains, whose full chain list drags extra code into the build.
export const localChain = defineChain({
  id: 31337,
  name: "Hardhat",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

export function explorerAddress(address: string) {
  return `${robinhoodChain.blockExplorers.default.url}/address/${address}`;
}
