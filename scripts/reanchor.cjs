const { Contract, JsonRpcProvider, Wallet } = require("ethers");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const dotenv = require("dotenv");

const root = path.resolve(__dirname, "..");
Object.assign(process.env, dotenv.config({ path: path.join(root, ".env"), quiet: true }).parsed ?? {});

async function main() {
  const prisma = new PrismaClient();
  const provider = new JsonRpcProvider(process.env.BLOCKCHAIN_RPC_URL);
  const signer = new Wallet(process.env.BLOCKCHAIN_PRIVATE_KEY, provider);
  const artifact = JSON.parse(readFileSync(path.join(root, "packages/contracts/artifacts/contracts/BatchRegistry.sol/BatchRegistry.json"), "utf8"));
  const registry = new Contract(process.env.CONTRACT_ADDRESS, artifact.abi, signer);
  const network = await provider.getNetwork();
  const batches = await prisma.batch.findMany({ orderBy: { createdAt: "asc" } });

  for (const batch of batches) {
    const currentRecord = await registry.getBatch(batch.code);
    if (currentRecord.recordedAt > 0n && currentRecord.dataDigest.toLowerCase() === `0x${batch.integrityDigest}`.toLowerCase()) continue;
    if (currentRecord.recordedAt > 0n) throw new Error(`On-chain digest mismatch for ${batch.code}`);

    const transaction = await registry.anchorBatch(batch.code, `0x${batch.integrityDigest}`);
    const receipt = await transaction.wait();
    if (!receipt?.hash) throw new Error(`Could not anchor ${batch.code}`);
    await prisma.$transaction([
      prisma.batch.update({ where: { id: batch.id }, data: { blockchainTx: receipt.hash, blockchainNet: network.chainId.toString() } }),
      prisma.batchEvent.create({ data: { batchId: batch.id, type: "BLOCKCHAIN_ANCHORED", note: `Anchored on local development chain ${network.chainId}; transaction ${receipt.hash}` } }),
    ]);
    console.log(`Anchored ${batch.code}: ${receipt.hash}`);
  }

  if (batches.length === 0) console.log("No existing batches to anchor.");
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});