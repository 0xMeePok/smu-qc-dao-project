import assert from "node:assert/strict";
import { test } from "node:test";
import { createFxRateService, parseGoogleFxQuote, FX_CURRENCIES } from "../fxRates.js";

const NOW = 1_800_000_000_000;
const request = (localCurrency = "SGD") => ({ data: { localCurrency } });
const markup = (to = "SGD", rate = "1.28") => `<link rel="canonical" href="https://www.google.com/finance/quote/USD-${to}"><span jsname="Pdsbrc"><span>9999</span></span><div class="N6SYTe"><span jsname="Pdsbrc" class=""><span>${rate}</span></span></div>`;
const htmlResponse = body => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
const unavailable = error => error.code === "unavailable";

test("parser binds primary quote to the exact pair and ignores unrelated assets", () => {
  assert.equal(parseGoogleFxQuote(markup(), "USD", "SGD"), 1.28);
  assert.equal(parseGoogleFxQuote(markup("IDR", "15,500.50"), "USD", "IDR"), 15500.5);
  for (const body of [markup("EUR"), markup().replace('class="N6SYTe"', 'class="changed"'), markup("SGD", "0"), markup("SGD", "1,23"), markup() + markup(), "<title>Consent</title>"]) {
    assert.throws(() => parseGoogleFxQuote(body, "USD", "SGD"));
  }
});

test("SGD needs one quote and returns an exact identity rate", async () => {
  const calls = [];
  const service = createFxRateService({ now: () => NOW, fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, "error");
    assert.equal(options.headers["user-agent"], "Mozilla/5.0");
    return htmlResponse(markup());
  } });
  const result = await service(request());
  assert.deepEqual(result, { source: "Google Finance", localCurrency: "SGD", rates: { USD: 1.28, SGD: 1 }, fetchedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 900_000).toISOString() });
  assert.equal(calls.length, 1);
});

test("cross rates are derived from USD quotes and concurrent requests share the cache", async () => {
  const calls = [];
  let timestamp = NOW;
  const service = createFxRateService({ now: () => timestamp, fetchImpl: async url => {
    calls.push(url);
    const to = new URL(url).pathname.split("-").at(-1);
    return htmlResponse(markup(to, to === "SGD" ? "1.28" : "0.92"));
  } });
  const results = await Promise.all(Array.from({ length: 12 }, () => service(request("EUR"))));
  assert.equal(calls.length, 2);
  assert.equal(results[0].rates.SGD, 0.92 / 1.28);
  assert.equal(results[0].rates.USD, 0.92);
  assert.deepEqual(await service(request("EUR")), results[0]);
  const usd = await service(request("USD"));
  assert.equal(usd.rates.USD, 1);
  assert.equal(usd.rates.SGD, 1 / 1.28);
  assert.equal(calls.length, 2);
  timestamp += 900_000;
  await service(request("EUR"));
  assert.equal(calls.length, 4);
});

test("invalid inputs never reach Google and the target set is bounded", async () => {
  let calls = 0;
  const service = createFxRateService({ fetchImpl: () => { calls++; throw new Error("unexpected"); } });
  for (const data of [undefined, null, [], {}, { localCurrency: "XXX" }, { localCurrency: "sgd" }, { localCurrency: "https://example.com" }, { localCurrency: "USD", url: "https://example.com" }]) {
    await assert.rejects(service({ data }), error => error.code === "invalid-argument");
  }
  assert.equal(calls, 0);
  assert.equal(FX_CURRENCIES.length, new Set(FX_CURRENCIES).size);
});

test("expired rates are never returned after a refresh failure, and failures have a retry cooldown", async () => {
  let timestamp = NOW;
  let calls = 0;
  let fail = false;
  const service = createFxRateService({ now: () => timestamp, fetchImpl: () => {
    calls++;
    if (fail) throw new Error("provider failed");
    return Promise.resolve(htmlResponse(markup()));
  } });
  await service(request());
  timestamp += 900_000; fail = true;
  await assert.rejects(service(request()), unavailable);
  await assert.rejects(service(request()), unavailable);
  assert.equal(calls, 2);
  timestamp += 30_000; fail = false;
  assert.equal((await service(request())).rates.USD, 1.28);
  assert.equal(calls, 3);
});

test("HTTP, content type, declared length and streaming size failures fail closed", async () => {
  for (const response of [
    new Response("oops", { status: 503 }),
    new Response(markup(), { headers: { "content-type": "application/json" } }),
    new Response(markup(), { headers: { "content-type": "text/html", "content-length": "5000000" } }),
    htmlResponse("x".repeat(4 * 1024 * 1024 + 1)),
    htmlResponse(markup("SGD", "NaN")),
  ]) {
    await assert.rejects(createFxRateService({ fetchImpl: async () => response })(request()), unavailable);
  }
});

test("timeout aborts the upstream request", async () => {
  const keeper = setTimeout(() => {}, 1000);
  try {
    const service = createFxRateService({ timeoutMs: 5, fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) });
    await assert.rejects(service(request()), unavailable);
  } finally { clearTimeout(keeper); }
});

