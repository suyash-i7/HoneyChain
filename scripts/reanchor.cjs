const { Contract, JsonRpcProvider, NonceManager, Wallet, keccak256, toUtf8Bytes } = require("ethers");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const dotenv = require("dotenv");

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

const root = path.resolve(__dirname, "..");
Object.assign(process.env, dotenv.config({ path: path.join(root, ".env"), quiet: true }).parsed ?? {});

async function main() {
  const prisma = new PrismaClient();
  const provider = new JsonRpcProvider(process.env.BLOCKCHAIN_RPC_URL);
  const signer = new NonceManager(new Wallet(process.env.BLOCKCHAIN_PRIVATE_KEY, provider));
  const artifact = JSON.parse(readFileSync(path.join(root, "packages/contracts/artifacts/contracts/BatchRegistry.sol/BatchRegistry.json"), "utf8"));
  const registry = new Contract(process.env.CONTRACT_ADDRESS, artifact.abi, signer);
  const network = await provider.getNetwork();
  const batches = await prisma.batch.findMany({ orderBy: { createdAt: "asc" } });

  for (const batch of batches) {
    const currentRecord = await registry.getBatch(batch.code);
    if (currentRecord.recordedAt > 0n) {
      if (currentRecord.dataDigest.toLowerCase() !== `0x${batch.integrityDigest}`.toLowerCase()) throw new Error(`On-chain digest mismatch for ${batch.code}`);
    } else {
      const transaction = await registry.anchorBatch(batch.code, `0x${batch.integrityDigest}`);
      const receipt = await transaction.wait();
      if (!receipt?.hash) throw new Error(`Could not anchor ${batch.code}`);
      await prisma.$transaction([
        prisma.batch.update({ where: { id: batch.id }, data: { blockchainTx: receipt.hash, blockchainNet: network.chainId.toString() } }),
        prisma.batchEvent.create({ data: { batchId: batch.id, type: "BLOCKCHAIN_ANCHORED", note: `Anchored on local development chain ${network.chainId}; transaction ${receipt.hash}` } }),
      ]);
      console.log(`Anchored ${batch.code}: ${receipt.hash}`);
    }

    let stages = await prisma.batchStage.findMany({ where: { batchId: batch.id }, orderBy: { sequence: "asc" } });
    if (stages.length === 0) {
      const harvestedData = {
        batchCode: batch.code,
        type: "HARVESTED",
        sequence: 1,
        occurredAt: batch.harvestDate.toISOString(),
        actorId: batch.beekeeperId,
        status: "RECORDED",
        metadata: { quantityKg: batch.quantityKg, floralSource: batch.floralSource },
        previousDigest: batch.integrityDigest,
      };
      const harvestedDigest = keccak256(toUtf8Bytes(JSON.stringify(canonicalize(harvestedData)))).slice(2);
      await prisma.batchStage.create({ data: {
        batchId: batch.id,
        type: harvestedData.type,
        sequence: harvestedData.sequence,
        occurredAt: batch.harvestDate,
        actorId: batch.beekeeperId,
        metadataJson: JSON.stringify(harvestedData.metadata),
        previousDigest: harvestedData.previousDigest,
        digest: harvestedDigest,
        proofKey: `${batch.code}:STAGE:1`,
      } });

      if (batch.status === "VERIFIED") {
        const review = await prisma.batchEvent.findFirst({ where: { batchId: batch.id, type: "VERIFICATION_VERIFIED" }, orderBy: { createdAt: "asc" } });
        const occurredAt = review?.createdAt && review.createdAt > batch.harvestDate ? review.createdAt : new Date(batch.harvestDate.getTime() + 1000);
        const verifiedData = {
          batchCode: batch.code,
          type: "VERIFIED",
          sequence: 2,
          occurredAt: occurredAt.toISOString(),
          actorId: review?.actorId ?? null,
          status: "RECORDED",
          metadata: { decision: "VERIFIED", note: review?.note ?? "Historical verifier approval" },
          previousDigest: harvestedDigest,
        };
        const verifiedDigest = keccak256(toUtf8Bytes(JSON.stringify(canonicalize(verifiedData)))).slice(2);
        await prisma.batchStage.create({ data: {
          batchId: batch.id,
          type: verifiedData.type,
          sequence: verifiedData.sequence,
          occurredAt,
          actorId: verifiedData.actorId,
          metadataJson: JSON.stringify(verifiedData.metadata),
          previousDigest: verifiedData.previousDigest,
          digest: verifiedDigest,
          proofKey: `${batch.code}:STAGE:2`,
        } });
      }
      stages = await prisma.batchStage.findMany({ where: { batchId: batch.id }, orderBy: { sequence: "asc" } });
    }
    let previousDigest = batch.integrityDigest;
    for (const [index, stage] of stages.entries()) {
      if (stage.sequence !== index + 1 || stage.previousDigest.toLowerCase() !== previousDigest.toLowerCase()) throw new Error(`Stage sequence mismatch for ${batch.code} at ${stage.type}`);
      const stageData = {
        batchCode: batch.code,
        type: stage.type,
        sequence: stage.sequence,
        occurredAt: stage.occurredAt.toISOString(),
        actorId: stage.actorId,
        status: stage.status,
        metadata: JSON.parse(stage.metadataJson),
        previousDigest: stage.previousDigest,
      };
      const expectedDigest = keccak256(toUtf8Bytes(JSON.stringify(canonicalize(stageData)))).slice(2);
      if (expectedDigest.toLowerCase() !== stage.digest.toLowerCase()) throw new Error(`Off-chain stage data mismatch for ${batch.code} at ${stage.type}`);

      const stageRecord = await registry.getBatch(stage.proofKey);
      if (stageRecord.recordedAt > 0n) {
        if (stageRecord.dataDigest.toLowerCase() !== `0x${stage.digest}`.toLowerCase()) throw new Error(`On-chain stage digest mismatch for ${batch.code} at ${stage.type}`);
      } else {
        const stageTransaction = await registry.anchorBatch(stage.proofKey, `0x${stage.digest}`);
        const stageReceipt = await stageTransaction.wait();
        if (!stageReceipt?.hash) throw new Error(`Could not anchor ${batch.code} stage ${stage.type}`);
        await prisma.batchStage.update({ where: { id: stage.id }, data: { blockchainTx: stageReceipt.hash, blockchainNet: network.chainId.toString() } });
        console.log(`Anchored ${batch.code} ${stage.type}: ${stageReceipt.hash}`);
      }
      previousDigest = stage.digest;
    }
  }

  if (batches.length === 0) console.log("No existing batches to anchor.");
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});