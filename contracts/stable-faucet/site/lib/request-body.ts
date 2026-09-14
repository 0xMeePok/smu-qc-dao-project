export const MAX_REQUEST_BYTES = 8_192;
export class RequestTooLarge extends Error {}

export function checkLength(value: string | null) {
  if (value !== null && (!/^\d+$/.test(value) || Number(value) > MAX_REQUEST_BYTES)) {
    throw new RequestTooLarge();
  }
}

export async function boundedBody(chunks: AsyncIterable<Uint8Array | string>) {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of chunks) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    size += bytes.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new RequestTooLarge();
    parts.push(bytes);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return new TextDecoder().decode(result);
}

export async function readWebBody(request: Request) {
  checkLength(request.headers.get("content-length"));
  if (!request.body) return "";
  const reader = request.body.getReader();
  async function* chunks() {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        yield next.value;
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
  }
  return boundedBody(chunks());
}
