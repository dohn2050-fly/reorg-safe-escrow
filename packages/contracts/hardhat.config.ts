import type { HardhatUserConfig } from "hardhat/config";
import { configVariable } from "hardhat/config";
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 200 },
        },
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 10_000 },
          metadata: { bytecodeHash: "none" },
        },
      },
    },
  },
  networks: {
    // In-process simulated chain used by `hardhat test`.
    hardhatMainnet: { type: "edr-simulated", chainType: "l1" },
    // `hardhat node` on :8545 (chainId 31337) used by the indexer, web app and chaos runner.
    localhost: { type: "http", chainType: "l1", url: "http://127.0.0.1:8545" },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
    },
  },
};

export default config;
