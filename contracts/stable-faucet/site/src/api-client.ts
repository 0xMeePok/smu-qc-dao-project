export type FaucetResult = {
  error?: string;
  txHash?: string;
};

export async function readFaucetResult(
  response: Response,
): Promise<FaucetResult> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    try {
      return (await response.json()) as FaucetResult;
    } catch {
      return { error: "The faucet returned an invalid response." };
    }
  }

  return {
    error: response.ok
      ? "The faucet returned an invalid response."
      : "The faucet service is temporarily unavailable. Please try again shortly.",
  };
}
