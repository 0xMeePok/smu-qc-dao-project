import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getRpcUrls, RPC_ALLOWED_ORIGINS } from "../functions/rpcPolicy.js";

/** Add exact configured origins; provider key paths never enter the CSP. */
export function withRpcCsp(config, options = {}) {
  const origins = getRpcUrls(options).map(value => {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "https:" || endpoint.hostname.includes("*")) {
      throw new Error("Production RPC endpoints must use HTTPS without wildcard hosts.");
    }
    return endpoint.origin;
  });
  const updated = structuredClone(config);
  const policy = updated.hosting.headers.flatMap(entry => entry.headers)
    .find(header => header.key === "Content-Security-Policy");
  if (!policy) throw new Error("Hosting must declare its Content-Security-Policy.");
  const directives = policy.value.split(";").map(value => value.trim()).filter(Boolean);
  const index = directives.findIndex(value => value.startsWith("connect-src "));
  if (index < 0) throw new Error("Hosting CSP must declare connect-src.");
  const existing = directives[index].split(/\s+/).slice(1)
    .filter(origin => !RPC_ALLOWED_ORIGINS.includes(origin));
  directives[index] = ["connect-src", ...new Set([...existing, ...origins])].join(" ");
  policy.value = directives.join("; ");
  return updated;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2] ?? fileURLToPath(new URL("../firebase.json", import.meta.url));
  const config = JSON.parse(await fs.readFile(path, "utf8"));
  const updated = withRpcCsp(config, {
    primaryUrl: process.env.VITE_ARBITRUM_SEPOLIA_RPC_URL,
    backupUrls: process.env.VITE_ARBITRUM_SEPOLIA_RPC_BACKUP_URLS,
  });
  await fs.writeFile(path, JSON.stringify(updated, null, 2) + "\n");
  console.log("Hosting CSP configured for the exact RPC origins; API-key paths excluded.");
}
