import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import handler from "../api/faucet";
import { describe, expect, it } from "vitest";
import { boundedBody, checkLength, MAX_REQUEST_BYTES, RequestTooLarge } from "../lib/request-body";
import { handleFaucet } from "../lib/faucet";

describe("QCDAO-136 streaming request limit", () => {
  it("stops a chunked body before retaining or reading the remainder", async () => {
    let chunksRead = 0;
    let closed = false;
    async function* chunks() {
      try { for (let i = 0; i < 1000; i++) { chunksRead++; yield new Uint8Array(1024); } }
      finally { closed = true; }
    }
    await expect(boundedBody(chunks())).rejects.toBeInstanceOf(RequestTooLarge);
    expect(chunksRead).toBe(9);
    expect(closed).toBe(true);
  });
  it("accepts the boundary and rejects malformed or negative declared lengths", async () => {
    async function* chunks() { yield "x".repeat(MAX_REQUEST_BYTES); }
    expect((await boundedBody(chunks())).length).toBe(MAX_REQUEST_BYTES);
    for (const length of ["-1", "NaN", "8193", "1.5"]) expect(() => checkLength(length)).toThrow(RequestTooLarge);
  });
  it("returns 413 and cancels an oversized web stream without a content-length", async () => {
    let pulled = 0; let cancelled = false;
    const body = new ReadableStream({
      pull(controller) { pulled++; controller.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled = true; },
    });
    const request = new Request("https://faucet.example/api/faucet", {
      method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half",
    } as RequestInit);
    expect((await handleFaucet(request, {})).status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(10);
  });
});


describe("QCDAO-136 Node/Vercel adapter", () => {
  for (const raw of [" ".repeat(524288) + "{}", '{"a":0,' + '"a":0,'.repeat(3000) + '"a":0}']) {
    it("rejects oversized raw JSON without touching a parsed-body getter", async () => {
      let consumed = 0;
      async function* chunks() { for (let i = 0; i < raw.length; i += 1024) { consumed++; yield Buffer.from(raw.slice(i, i + 1024)); } }
      const request = Object.assign(Readable.from(chunks()), { method: "POST", url: "/api/faucet", headers: { host: "faucet.example", "content-type": "application/json" } });
      Object.defineProperty(request, "body", { get() { throw new Error("Automatic parsing must never run"); } });
      const response = { statusCode: 200, setHeader() {}, end() {} };
      await handler(request as unknown as IncomingMessage, response as unknown as ServerResponse);
      expect(response.statusCode).toBe(413);
      expect(consumed).toBeLessThanOrEqual(11);
      request.destroy();
    });
  }
  it("preserves a normal malformed-JSON response through the raw adapter", async () => {
    const request = Object.assign(Readable.from([Buffer.from("{")]), {
      method: "POST", url: "/api/faucet", headers: { host: "faucet.example", "content-type": "application/json" },
    });
    const response = { statusCode: 200, setHeader() {}, end() {} };
    await handler(request as unknown as IncomingMessage, response as unknown as ServerResponse);
    expect(response.statusCode).toBe(400);
  });
});
