import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatEthersChaiMatchers from "@nomicfoundation/hardhat-ethers-chai-matchers";
import hardhatMocha from "@nomicfoundation/hardhat-mocha";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import { configVariable, defineConfig } from "hardhat/config";
import "dotenv/config";

// Accept the common bare 64-hex private-key form while keeping Hardhat's
// configured account in its required 0x-prefixed representation.
const configuredPrivateKey = process.env.DEPLOYER_PRIVATE_KEY?.trim();
if (/^[0-9a-fA-F]{64}$/.test(configuredPrivateKey ?? "")) {
  process.env.DEPLOYER_PRIVATE_KEY = `0x${configuredPrivateKey}`;
}

const compiler = {
  version: "0.8.28",
  settings: {
    optimizer: {
      enabled: true,
      runs: 200,
    },
    // OpenZeppelin 5.6 EnumerableSet imports Arrays, which uses MCOPY.
    evmVersion: "cancun",
  },
};

export default defineConfig({
  coverage: { skipFiles: ["contracts/test/**"] },
  plugins: [
    hardhatEthers,
    hardhatEthersChaiMatchers,
    hardhatMocha,
    hardhatVerify,
  ],
  solidity: {
    profiles: {
      default: compiler,
      production: {
        ...compiler,
        preferWasm: true,
      },
    },
  },
  networks: {
    arbitrumSepolia: {
      type: "http",
      chainType: "generic",
      url: configVariable("ARBITRUM_SEPOLIA_RPC_URL"),
      chainId: 421614,
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
  },
});
