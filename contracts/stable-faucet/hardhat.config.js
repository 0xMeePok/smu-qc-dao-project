import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatEthersChaiMatchers from "@nomicfoundation/hardhat-ethers-chai-matchers";
import hardhatMocha from "@nomicfoundation/hardhat-mocha";
import { configVariable, defineConfig } from "hardhat/config";
import "dotenv/config";

const compiler = {
  version: "0.8.28",
  settings: {
    optimizer: {
      enabled: true,
      runs: 200,
    },
    evmVersion: "paris",
  },
};

export default defineConfig({
  plugins: [hardhatEthers, hardhatEthersChaiMatchers, hardhatMocha],
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
});
