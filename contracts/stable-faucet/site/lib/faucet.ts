import {
  Contract,
  JsonRpcProvider,
  Wallet,
  getAddress,
  isAddress,
  verifyMessage,
} from "ethers";
import {
  completeWalletDistribution,
  reserveWalletDistribution,
} from "./rate-limit.js";

export interface FaucetEnvironment {
  ARBITRUM_SEPOLIA_RPC_URL?: string;
  FAUCET_PRIVATE_KEY?: string;
  XSGD_TOKEN_ADDRESS?: string;
  USDT_TOKEN_ADDRESS?: string;
  USDC_TOKEN_ADDRESS?: string;
}

type TokenSymbol = "XSGD" | "USDT" | "USDC";
type FaucetBody = {
  token?: unknown;
  recipient?: unknown;
  issuedAt?: unknown;
  signature?: unknown;
};

const CHAIN_ID = 421614;
const SIGNATURE_TTL_SECONDS = 5 * 60;
const MAX_REQUEST_BYTES = 8_192;
const FAUCET_ABI = [
  "function faucetMint(address recipient)",
  "function nextClaimAt(address recipient) view returns (uint256)",
];

function json(body: unknown, status = 200, extraHeaders?: HeadersInit) {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

function tokenAddresses(
  env: FaucetEnvironment,
): Record<TokenSymbol, string | undefined> {
  return {
    XSGD: env.XSGD_TOKEN_ADDRESS,
    USDT: env.USDT_TOKEN_ADDRESS,
    USDC: env.USDC_TOKEN_ADDRESS,
  };
}

function mintMessage(
  token: TokenSymbol,
  recipient: string,
  issuedAt: number,
) {
  return [
    "TAP Faucet Mint",
    `Token: ${token}`,
    `Recipient: ${recipient}`,
    `Chain ID: ${CHAIN_ID}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

function isConfigured(env: FaucetEnvironment) {
  const addresses = tokenAddresses(env);
  return Boolean(
    env.ARBITRUM_SEPOLIA_RPC_URL &&
      env.FAUCET_PRIVATE_KEY &&
      Object.values(addresses).every(
        (address) => address && isAddress(address),
      ),
  );
}

export function addSecurityHeaders(response: Response) {
  const secured = new Response(response.body, response);
  secured.headers.set("x-content-type-options", "nosniff");
  secured.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  secured.headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=()",
  );
  secured.headers.set("x-frame-options", "DENY");
  return secured;
}

export async function handleFaucet(
  request: Request,
  env: FaucetEnvironment,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405, { allow: "POST" });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(contentLength) || contentLength > MAX_REQUEST_BYTES) {
    return json({ error: "Request is too large." }, 413);
  }
  if (
    !request.headers.get("content-type")?.toLowerCase().startsWith(
      "application/json",
    )
  ) {
    return json({ error: "Expected a JSON request." }, 415);
  }
  let body: FaucetBody;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
      return json({ error: "Request is too large." }, 413);
    }
    body = JSON.parse(rawBody) as FaucetBody;
  } catch {
    return json({ error: "Invalid JSON request." }, 400);
  }

  if (!isConfigured(env)) {
    return json(
      { error: "The faucet is awaiting its testnet deployment configuration." },
      503,
    );
  }

  const token =
    typeof body.token === "string"
      ? (body.token.toUpperCase() as TokenSymbol)
      : ("" as TokenSymbol);
  const recipient = typeof body.recipient === "string" ? body.recipient : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  const issuedAt = typeof body.issuedAt === "number" ? body.issuedAt : NaN;
  const addresses = tokenAddresses(env);

  if (!(token in addresses)) {
    return json({ error: "Unsupported token." }, 400);
  }
  if (!isAddress(recipient)) {
    return json({ error: "Invalid recipient address." }, 400);
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return json({ error: "Invalid wallet signature." }, 400);
  }
  if (!Number.isInteger(issuedAt)) {
    return json({ error: "Invalid request timestamp." }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  if (issuedAt > now + 60 || now - issuedAt > SIGNATURE_TTL_SECONDS) {
    return json({ error: "This mint request expired. Please try again." }, 400);
  }

  const normalizedRecipient = getAddress(recipient);
  try {
    const recovered = verifyMessage(
      mintMessage(token, normalizedRecipient, issuedAt),
      signature,
    );
    if (getAddress(recovered) !== normalizedRecipient) {
      return json(
        { error: "Signature does not match the connected wallet." },
        401,
      );
    }
  } catch {
    return json({ error: "Invalid wallet signature." }, 401);
  }

  const rateLimit = reserveWalletDistribution(normalizedRecipient, token);
  if (rateLimit.allowed === false) {
    if (rateLimit.capacityExceeded) {
      return json(
        { error: "The faucet is temporarily busy. Please try again shortly." },
        503,
      );
    }
    const retryAfter = Math.max(
      1,
      Math.ceil(((rateLimit.reset ?? Date.now()) - Date.now()) / 1_000),
    );
    return json(
      { error: "Rate limit reached. Please try again later." },
      429,
      {
        "rate-limit-limit": "1",
        "rate-limit-remaining": "0",
        "rate-limit-reset": String(
          Math.ceil((rateLimit.reset ?? Date.now()) / 1_000),
        ),
        "retry-after": String(retryAfter),
      },
    );
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(env.FAUCET_PRIVATE_KEY!)) {
    completeWalletDistribution(rateLimit.reservation, false);
    return json({ error: "The faucet is not configured correctly." }, 503);
  }

  let distributed = false;
  try {
    const provider = new JsonRpcProvider(
      env.ARBITRUM_SEPOLIA_RPC_URL,
      { chainId: CHAIN_ID, name: "arbitrum-sepolia" },
      { staticNetwork: true },
    );
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== CHAIN_ID) {
      return json(
        { error: "Faucet RPC is connected to the wrong network." },
        503,
      );
    }

    const signer = new Wallet(env.FAUCET_PRIVATE_KEY!, provider);
    const contract = new Contract(addresses[token]!, FAUCET_ABI, signer);
    const nextClaimAt = (await contract.nextClaimAt(
      normalizedRecipient,
    )) as bigint;
    if (nextClaimAt > BigInt(now)) {
      return json(
        {
          error: `This wallet can claim ${token} again at ${new Date(
            Number(nextClaimAt) * 1000,
          ).toISOString()}.`,
        },
        429,
      );
    }

    const transaction = await contract.faucetMint(normalizedRecipient);
    const receipt = await transaction.wait(1);
    if (!receipt || receipt.status !== 1) {
      return json({ error: "The mint transaction was not confirmed." }, 502);
    }

    distributed = true;
    return json({
      token,
      recipient: normalizedRecipient,
      amount: "10000",
      decimals: 6,
      txHash: transaction.hash,
    });
  } catch {
    return json(
      {
        error:
          "The testnet mint could not be completed. Please try again shortly.",
      },
      502,
    );
  } finally {
    completeWalletDistribution(rateLimit.reservation, distributed);
  }
}
