import {
  addSecurityHeaders,
  handleFaucet,
  type FaucetEnvironment,
} from "../lib/faucet";

export const config = { maxDuration: 60 };

function getEnvironment(): FaucetEnvironment {
  return {
    ARBITRUM_SEPOLIA_RPC_URL: process.env.ARBITRUM_SEPOLIA_RPC_URL,
    FAUCET_PRIVATE_KEY: process.env.FAUCET_PRIVATE_KEY,
    XSGD_TOKEN_ADDRESS: process.env.XSGD_TOKEN_ADDRESS,
    USDT_TOKEN_ADDRESS: process.env.USDT_TOKEN_ADDRESS,
    USDC_TOKEN_ADDRESS: process.env.USDC_TOKEN_ADDRESS,
  };
}

export default {
  async fetch(request: Request) {
    return addSecurityHeaders(await handleFaucet(request, getEnvironment()));
  },
};
