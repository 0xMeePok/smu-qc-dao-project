import {
  addSecurityHeaders,
  handleFaucet,
  type FaucetEnvironment,
} from "../lib/faucet.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { boundedBody, checkLength, RequestTooLarge } from "../lib/request-body.js";

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

type VercelRequest = IncomingMessage;

async function requestBody(request: VercelRequest) {
  checkLength(request.headers["content-length"] ?? null);
  // Never access Vercel's lazy request.body parser: only raw bytes can enforce
  // the limit before parsing (whitespace and duplicate keys still count).
  // Do not destroy the socket on early return: the caller must receive the 413.
  return boundedBody(request.iterator({ destroyOnReturn: false }));
}

async function toWebRequest(request: VercelRequest) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const protocolHeader = request.headers["x-forwarded-proto"];
  const protocol = Array.isArray(protocolHeader)
    ? protocolHeader[0]
    : protocolHeader ?? "https";
  const host = request.headers.host ?? "localhost";
  const method = request.method ?? "GET";

  return new Request(`${protocol}://${host}${request.url ?? "/"}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : await requestBody(request),
  });
}

async function sendWebResponse(result: Response, response: ServerResponse) {
  response.statusCode = result.status;
  result.headers.forEach((value, name) => response.setHeader(name, value));
  response.end(Buffer.from(await result.arrayBuffer()));
}

export default async function handler(
  request: VercelRequest,
  response: ServerResponse,
) {
  try {
    const webRequest = await toWebRequest(request);
    const result = addSecurityHeaders(
      await handleFaucet(webRequest, getEnvironment()),
    );
    await sendWebResponse(result, response);
  } catch (error) {
    response.statusCode = error instanceof RequestTooLarge ? 413 : 500;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(JSON.stringify({ error: error instanceof RequestTooLarge ? "Request is too large." : "The faucet service is temporarily unavailable." }));
  }
}
