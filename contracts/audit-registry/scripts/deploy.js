import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import hre, { network } from "hardhat";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";

const EXPECTED_NETWORK = "arbitrumSepolia";
const EXPECTED_CHAIN_ID = 421614n;
const DEFAULT_FALLBACK_RPC_URL = "https://sepolia-rollup.arbitrum.io/rpc";
const RECEIPT_POLL_INTERVAL_MS = 3_000;
const RECEIPT_TIMEOUT_MS = 180_000;
const MAX_CONSECUTIVE_RPC_ERRORS = 5;

function requireEnvironment() {
  const required = [
    "ARBITRUM_SEPOLIA_RPC_URL",
    "DEPLOYER_PRIVATE_KEY",
  ];
  const missing = required.filter((name) => !process.env[name]?.trim());

  if (missing.length > 0) {
    throw new Error(`Missing required .env values: ${missing.join(", ")}`);
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(process.env.DEPLOYER_PRIVATE_KEY?.trim() ?? "")) {
    throw new Error("DEPLOYER_PRIVATE_KEY is not a valid 32-byte private key");
  }
}

async function verifyOnEtherscan(address, constructorArgs, attempts = 4) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      console.log(`Etherscan verification attempt ${attempt}/${attempts}...`);
      await verifyContract(
        {
          address,
          constructorArgs,
          contract: "contracts/AuditRegistry.sol:AuditRegistry",
          provider: "etherscan",
        },
        hre
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.warn("Explorer indexing is not ready; retrying in 15 seconds...");
        await new Promise((resolve) => setTimeout(resolve, 15_000));
      }
    }
  }

  throw new Error(
    `Automatic Etherscan verification failed after ${attempts} attempts: ${lastError?.message ?? "unknown error"}`
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function archiveExistingDeployment(deploymentFile) {
  if (!fs.existsSync(deploymentFile)) return;

  let existingRecord = {};
  try {
    existingRecord = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
  } catch {
    console.warn("Previous deployment record is not valid JSON; archiving it unchanged.");
  }
  const archiveDirectory = path.join(path.dirname(deploymentFile), "history");
  const address = existingRecord.address || "unknown-address";
  const transactionSuffix = existingRecord.transactionHash
    ? existingRecord.transactionHash.slice(2, 10)
    : "unknown-tx";
  const archiveFile = path.join(
    archiveDirectory,
    `arbitrumSepolia-${address}-${transactionSuffix}.json`
  );

  fs.mkdirSync(archiveDirectory, { recursive: true });
  if (!fs.existsSync(archiveFile)) {
    fs.copyFileSync(deploymentFile, archiveFile);
    console.log(`Previous deployment archived: ${archiveFile}`);
  }
}

async function pollForDeploymentReceipt(
  provider,
  transactionHash,
  rpcLabel,
  confirmations = 2
) {
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  let consecutiveErrors = 0;

  while (Date.now() < deadline) {
    try {
      const receipt = await provider.getTransactionReceipt(transactionHash);

      if (receipt !== null) {
        const latestBlock = await provider.getBlockNumber();
        const receiptConfirmations = latestBlock - receipt.blockNumber + 1;
        if (receiptConfirmations >= confirmations) return receipt;
      }

      consecutiveErrors = 0;
    } catch {
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_RPC_ERRORS) {
        throw new Error(
          `${rpcLabel} RPC failed ${consecutiveErrors} consecutive receipt checks`
        );
      }
      console.warn(
        `${rpcLabel} RPC receipt check failed (${consecutiveErrors}/${MAX_CONSECUTIVE_RPC_ERRORS}); retrying...`
      );
    }

    await delay(RECEIPT_POLL_INTERVAL_MS);
  }

  throw new Error(`${rpcLabel} RPC timed out waiting for transaction receipt`);
}

async function waitForDeploymentReceipt(ethers, transactionHash) {
  try {
    return await pollForDeploymentReceipt(
      ethers.provider,
      transactionHash,
      "Primary"
    );
  } catch {
    console.warn(
      "Primary RPC could not confirm the transaction after retries; using the read-only fallback RPC..."
    );
    const fallbackUrl =
      process.env.ARBITRUM_SEPOLIA_FALLBACK_RPC_URL?.trim() ||
      DEFAULT_FALLBACK_RPC_URL;
    const fallbackProvider = new ethers.JsonRpcProvider(fallbackUrl);

    try {
      return await pollForDeploymentReceipt(
        fallbackProvider,
        transactionHash,
        "Fallback"
      );
    } catch {
      throw new Error(
        `Deployment transaction ${transactionHash} was broadcast but neither RPC could confirm it. Check the transaction before rerunning.`
      );
    } finally {
      fallbackProvider.destroy();
    }
  }
}

async function main() {
  requireEnvironment();

  const { ethers, networkName, verification } = await network.create();

  if (networkName !== EXPECTED_NETWORK) {
    throw new Error(
      `Refusing deployment on ${networkName}; expected ${EXPECTED_NETWORK}`
    );
  }

  const connectedNetwork = await ethers.provider.getNetwork();
  if (connectedNetwork.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `Refusing deployment on chain ${connectedNetwork.chainId}; expected ${EXPECTED_CHAIN_ID}`
    );
  }

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const deploymentFile = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "deployments",
    "arbitrumSepolia.json"
  );
  archiveExistingDeployment(deploymentFile);

  const balance = await ethers.provider.getBalance(deployerAddress);
  if (balance === 0n) {
    throw new Error(`Deployer ${deployerAddress} has no Arbitrum Sepolia ETH`);
  }

  console.log(`Network: ${EXPECTED_NETWORK} (${connectedNetwork.chainId})`);
  console.log(`Deployer: ${deployerAddress}`);

  const AuditRegistry = await ethers.getContractFactory("AuditRegistry", deployer);
  const registry = await AuditRegistry.deploy();
  const deploymentTransaction = registry.deploymentTransaction();
  const address = await registry.getAddress();

  console.log(`Deployment transaction: ${deploymentTransaction.hash}`);
  const record = {
    network: EXPECTED_NETWORK,
    chainId: Number(connectedNetwork.chainId),
    address,
    transactionHash: deploymentTransaction.hash,
    blockNumber: null,
    deployer: deployerAddress,
    deploymentStatus: "broadcast",
    deployedAt: null,
    verification: {
      provider: "etherscan",
      status: "pending",
    },
  };

  fs.mkdirSync(path.dirname(deploymentFile), { recursive: true });
  fs.writeFileSync(deploymentFile, `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o644,
  });

  const receipt = await waitForDeploymentReceipt(
    ethers,
    deploymentTransaction.hash
  );
  if (receipt.status !== 1) {
    record.deploymentStatus = "failed";
    fs.writeFileSync(deploymentFile, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o644,
    });
    throw new Error(`Deployment transaction ${deploymentTransaction.hash} reverted`);
  }

  record.blockNumber = receipt.blockNumber;
  record.deploymentStatus = "confirmed";
  record.deployedAt = new Date().toISOString();
  fs.writeFileSync(deploymentFile, `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o644,
  });

  console.log(`AuditRegistry deployed to: ${address}`);
  console.log(`Deployment record: ${deploymentFile}`);

  if (!process.env.ETHERSCAN_API_KEY?.trim()) {
    record.verification = {
      provider: "etherscan",
      status: "skipped",
      reason: "ETHERSCAN_API_KEY was not configured",
    };
    fs.writeFileSync(deploymentFile, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o644,
    });
    console.log("Etherscan verification skipped: ETHERSCAN_API_KEY is not configured.");
    return;
  }

  try {
    await verifyOnEtherscan(address, []);
    record.verification = {
      provider: "etherscan",
      status: "verified",
      verifiedAt: new Date().toISOString(),
      url: await verification.etherscan.getContractUrl(address),
    };
    fs.writeFileSync(deploymentFile, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o644,
    });
    console.log(`AuditRegistry verified on Etherscan: ${record.verification.url}`);
  } catch (error) {
    record.verification = {
      provider: "etherscan",
      status: "failed",
      lastAttemptAt: new Date().toISOString(),
    };
    fs.writeFileSync(deploymentFile, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o644,
    });
    throw error;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
