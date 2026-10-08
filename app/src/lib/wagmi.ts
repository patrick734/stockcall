import { createConfig, http, injected } from "wagmi";
import { localChain, robinhoodChain } from "./chains";

const includeLocal = process.env.NEXT_PUBLIC_ENABLE_LOCAL === "1";

export const wagmiConfig = includeLocal
  ? createConfig({
      chains: [localChain, robinhoodChain],
      connectors: [injected()],
      transports: { [robinhoodChain.id]: http(), [localChain.id]: http() },
      ssr: true,
    })
  : createConfig({
      chains: [robinhoodChain],
      connectors: [injected()],
      transports: { [robinhoodChain.id]: http() },
      ssr: true,
    });

export const defaultChainId = includeLocal ? localChain.id : robinhoodChain.id;
