import { BrowserProvider } from "ethers";
import { readFaucetResult } from "./api-client";
import {
  CHAIN_ID,
  currentUnixTime,
  mintMessage,
  shortAddress,
  switchToArbitrumSepolia,
  type EthereumProvider,
  type TokenSymbol,
} from "./wallet";

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

type MintStatus = "idle" | "signing" | "minting" | "success" | "error";
const tokens: TokenSymbol[] = ["XSGD", "USDT", "USDC"];
let account = "";

function element<T extends Element>(selector: string): T {
  const match = document.querySelector<T>(selector);
  if (!match) throw new Error(`Missing required element: ${selector}`);
  return match;
}

const connectButton = element<HTMLButtonElement>("#connect-button");
const walletStrip = element<HTMLButtonElement>("#wallet-strip");
const recipientAddress = element<HTMLElement>("#recipient-address");
const walletAction = element<HTMLElement>("#wallet-action");
const stepCount = element<HTMLElement>("#step-count");
const notice = element<HTMLElement>("#notice");

function showNotice(message = "") {
  notice.textContent = message;
  notice.hidden = !message;
}

function updateAccount(nextAccount: string) {
  account = nextAccount;
  connectButton.textContent = account ? shortAddress(account) : "Connect wallet";
  recipientAddress.textContent = account
    ? shortAddress(account)
    : "Connect your wallet to continue";
  walletAction.textContent = account ? "Change" : "Connect";
  stepCount.textContent = account ? "2 / 3" : "1 / 3";
  for (const token of tokens) {
    const button = element<HTMLButtonElement>(`[data-mint="${token}"]`);
    if (!button.disabled) button.textContent = account ? "Mint" : "Connect";
  }
}

async function connectWallet() {
  showNotice();
  try {
    if (!window.ethereum) {
      throw new Error(
        "No browser wallet found. Install MetaMask or another EVM wallet.",
      );
    }
    const accounts = (await window.ethereum.request({
      method: "eth_requestAccounts",
    })) as string[];
    await switchToArbitrumSepolia(window.ethereum);
    updateAccount(accounts[0] ?? "");
  } catch (error) {
    showNotice(
      error instanceof Error
        ? error.message
        : "Wallet connection was cancelled.",
    );
  }
}

function setMintState(
  token: TokenSymbol,
  status: MintStatus,
  message = "",
  txHash?: string,
) {
  const row = element<HTMLElement>(`[data-row="${token}"]`);
  const button = element<HTMLButtonElement>(`[data-mint="${token}"]`);
  const link = element<HTMLAnchorElement>(`[data-success-link="${token}"]`);
  const statusText = element<HTMLElement>(`[data-status="${token}"]`);
  const busy = status === "signing" || status === "minting";

  row.classList.remove(...["idle", "signing", "minting", "success", "error"].map((state) => `state-${state}`));
  row.classList.add(`state-${status}`);
  button.disabled = busy;
  button.hidden = status === "success";
  link.hidden = status !== "success";
  statusText.hidden = !message;
  statusText.textContent = message;
  statusText.setAttribute("role", status === "error" ? "alert" : "status");

  button.replaceChildren();
  if (busy) {
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    button.append(spinner);
  } else {
    button.textContent = account ? "Mint" : "Connect";
  }
  if (status === "success" && txHash) {
    link.href = `https://sepolia.arbiscan.io/tx/${txHash}`;
  }
}

async function claim(token: TokenSymbol) {
  if (!account) {
    await connectWallet();
    return;
  }
  showNotice();
  setMintState(token, "signing", "Confirm in wallet");
  try {
    if (!window.ethereum) throw new Error("Wallet disconnected.");
    await switchToArbitrumSepolia(window.ethereum);
    const provider = new BrowserProvider(window.ethereum as never, {
      chainId: CHAIN_ID,
      name: "arbitrum-sepolia",
    });
    const signer = await provider.getSigner();
    const recipient = await signer.getAddress();
    const issuedAt = currentUnixTime();
    const signature = await signer.signMessage(
      mintMessage(token, recipient, issuedAt),
    );
    setMintState(token, "minting", "Minting onchain");

    const response = await fetch("/api/faucet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, recipient, issuedAt, signature }),
    });
    const result = await readFaucetResult(response);
    if (!response.ok || !result.txHash) {
      throw new Error(result.error ?? "Mint request failed.");
    }
    setMintState(token, "success", "10,000 minted", result.txHash);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Mint request failed.";
    setMintState(
      token,
      "error",
      /rejected|denied/i.test(message) ? "Signature cancelled" : message,
    );
  }
}

connectButton.addEventListener("click", connectWallet);
walletStrip.addEventListener("click", connectWallet);
for (const token of tokens) {
  element<HTMLButtonElement>(`[data-mint="${token}"]`).addEventListener(
    "click",
    () => claim(token),
  );
}

const handleAccounts = (...args: unknown[]) =>
  updateAccount((args[0] as string[])?.[0] ?? "");
window.ethereum?.on?.("accountsChanged", handleAccounts);
updateAccount("");
