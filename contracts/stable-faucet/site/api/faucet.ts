import {
  addSecurityHeaders,
  handleFaucet,
  type FaucetEnvironment,
} from "../lib/faucet";
import type { IncomingMessage, ServerResponse } from "node:http";

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

type VercelRequest = IncomingMessage & { body?: unknown };

async function requestBody(request: VercelRequest) {
  if (request.body !== undefined) {
    if (typeof request.body === "string") {
      return request.body;
    }
    if (request.body instanceof Uint8Array) {
      return Buffer.from(request.body).toString("utf8");
    }
    return JSON.stringify(request.body);
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
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
  } catch {
    response.statusCode = 500;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(JSON.stringify({ error: "The faucet service is temporarily unavailable." }));
  }
}
