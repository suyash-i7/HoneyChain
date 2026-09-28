import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";
import { createApp } from "./app.js";
import { BlockchainService } from "./blockchain.js";

const prisma = new PrismaClient();
let blockchainAvailable = false;
const appPromise = createApp({
  prisma,
  jwtSecret: "integration-test-secret-that-is-long-enough",
  blockchain: {
    isConfigured: () => blockchainAvailable,
    anchorBatch: async () => null,
    verifyBatch: async () => blockchainAvailable ? true : null,
  },
});
let beekeeperId = "";
let secondaryUserId = "";
let verifierId = "";
let hiveId = "";
let batchId = "";
let rejectedBatchId = "";

before(async () => {
  const app = await appPromise;
  await app.ready();
});

after(async () => {
  if (batchId) await prisma.batch.deleteMany({ where: { id: batchId } });
  if (rejectedBatchId) await prisma.batch.deleteMany({ where: { id: rejectedBatchId } });
  if (beekeeperId) await prisma.user.deleteMany({ where: { id: beekeeperId } });
  if (secondaryUserId) await prisma.user.deleteMany({ where: { id: secondaryUserId } });
  if (verifierId) await prisma.user.deleteMany({ where: { id: verifierId } });
  await (await appPromise).close();
  await prisma.$disconnect();
});

test("beekeeper can register a hive, ingest sensors, create a batch, and expose verifiable history", async () => {
  const app = await appPromise;
  const email = `beekeeper-${randomUUID()}@example.test`;
  const registration = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name: "Field Tester", email, password: "field-test-password-123" },
  });
  assert.equal(registration.statusCode, 201);
  const registered = registration.json();
  beekeeperId = registered.user.id;
  assert.equal(registered.user.role, "BEEKEEPER");
  const token = registered.token as string;
  const auth = { authorization: `Bearer ${token}` };

  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().database, "connected");

  const hiveResponse = await app.inject({
    method: "POST",
    url: "/api/hives",
    headers: auth,
    payload: { name: "Test orchard hive", location: "Demo village", colonyType: "Apis mellifera" },
  });
  assert.equal(hiveResponse.statusCode, 201);
  hiveId = hiveResponse.json().id;

  const invalidReading = await app.inject({
    method: "POST",
    url: `/api/hives/${hiveId}/readings`,
    headers: auth,
    payload: { temperatureC: 100, humidityPct: 45, weightKg: 30, source: "MANUAL" },
  });
  assert.equal(invalidReading.statusCode, 400);

  const simulatedReading = await app.inject({ method: "POST", url: `/api/hives/${hiveId}/readings/simulate`, headers: auth });
  assert.equal(simulatedReading.statusCode, 201);
  assert.equal(simulatedReading.json().source, "SIMULATOR");

  for (const reading of [
    { temperatureC: 33.2, humidityPct: 52, weightKg: 19.6, source: "MANUAL", recordedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() },
    { temperatureC: 34.1, humidityPct: 54, weightKg: 21.4, source: "DEVICE", recordedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString() },
    { temperatureC: 35.4, humidityPct: 57, weightKg: 23.1, source: "MANUAL", recordedAt: new Date().toISOString() },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/hives/${hiveId}/readings`,
      headers: auth,
      payload: { ...reading, temperatureC: Number(reading.temperatureC), humidityPct: Number(reading.humidityPct), weightKg: Number(reading.weightKg) },
    });
    assert.equal(response.statusCode, 201);
  }

  const analysis = await app.inject({ method: "GET", url: `/api/hives/${hiveId}/analysis`, headers: auth });
  assert.equal(analysis.statusCode, 200);
  assert.equal(analysis.json().health, "HEALTHY");
  assert.equal(analysis.json().productivityTrend, "RISING");
  assert.ok(analysis.json().explanation.length > 20);

  const harvestDate = new Date().toISOString().slice(0, 10);
  const batchResponse = await app.inject({
    method: "POST",
    url: "/api/batches",
    headers: auth,
    payload: { hiveId, harvestDate, quantityKg: 14.5, floralSource: "Mustard" },
  });
  assert.equal(batchResponse.statusCode, 201);
  const batch = batchResponse.json();
  batchId = batch.id;
  assert.match(batch.code, /^HC-\d{4}-[A-F0-9]{8}$/);
  assert.equal(batch.events[0].type, "BATCH_CREATED");

  const invalidTransition = await app.inject({
    method: "PATCH",
    url: `/api/batches/${batch.code}/status`,
    headers: auth,
    payload: { status: "SUBMITTED_FOR_VERIFICATION" },
  });
  assert.equal(invalidTransition.statusCode, 409);

  const processing = await app.inject({
    method: "PATCH",
    url: `/api/batches/${batch.code}/status`,
    headers: auth,
    payload: { status: "PROCESSING" },
  });
  assert.equal(processing.statusCode, 200);
  assert.equal(processing.json().status, "PROCESSING");

  const submission = await app.inject({
    method: "PATCH",
    url: `/api/batches/${batch.code}/status`,
    headers: auth,
    payload: { status: "SUBMITTED_FOR_VERIFICATION" },
  });
  assert.equal(submission.statusCode, 200);
  assert.equal(submission.json().status, "SUBMITTED_FOR_VERIFICATION");

  const beekeeperQueue = await app.inject({ method: "GET", url: "/api/verifier/batches", headers: auth });
  assert.equal(beekeeperQueue.statusCode, 403);

  const verifier = await prisma.user.create({
    data: { name: "Lab Verifier", email: `verifier-${randomUUID()}@example.test`, passwordHash: await bcrypt.hash("verifier-test-password-123", 4), role: "VERIFIER" },
  });
  verifierId = verifier.id;
  const verifierToken = app.jwt.sign({ sub: verifier.id, role: verifier.role, name: verifier.name, email: verifier.email });
  const verifierAuth = { authorization: `Bearer ${verifierToken}` };

  await prisma.batch.update({ where: { id: batchId }, data: { beekeeperId: verifierId } });
  const selfReview = await app.inject({
    method: "PATCH",
    url: `/api/verifier/batches/${batch.code}/decision`,
    headers: verifierAuth,
    payload: { decision: "VERIFIED", note: "Reviewed the lab results" },
  });
  assert.equal(selfReview.statusCode, 403);
  await prisma.batch.update({ where: { id: batchId }, data: { beekeeperId } });

  const unavailableDecision = await app.inject({
    method: "PATCH",
    url: `/api/verifier/batches/${batch.code}/decision`,
    headers: verifierAuth,
    payload: { decision: "VERIFIED", note: "Reviewed the lab results" },
  });
  assert.equal(unavailableDecision.statusCode, 409);

  blockchainAvailable = true;
  const verifierQueue = await app.inject({ method: "GET", url: "/api/verifier/batches", headers: verifierAuth });
  assert.equal(verifierQueue.statusCode, 200);
  assert.equal(verifierQueue.json().length, 1);

  const decision = await app.inject({
    method: "PATCH",
    url: `/api/verifier/batches/${batch.code}/decision`,
    headers: verifierAuth,
    payload: { decision: "VERIFIED", note: "Lab result and integrity digest checked" },
  });
  assert.equal(decision.statusCode, 200);
  assert.equal(decision.json().status, "VERIFIED");

  const publicRecord = await app.inject({ method: "GET", url: `/api/public/batches/${batch.code}` });
  assert.equal(publicRecord.statusCode, 200);
  assert.equal(publicRecord.json().verification, "VERIFIED_ON_CHAIN");
  assert.equal(publicRecord.json().status, "VERIFIED");
  assert.equal(publicRecord.json().events.at(-1).type, "VERIFICATION_VERIFIED");
  assert.equal(publicRecord.json().hive.name, "Test orchard hive");

  const rejectionBatchResponse = await app.inject({
    method: "POST",
    url: "/api/batches",
    headers: auth,
    payload: { hiveId, harvestDate, quantityKg: 8.25, floralSource: "Eucalyptus" },
  });
  assert.equal(rejectionBatchResponse.statusCode, 201);
  const rejectionBatch = rejectionBatchResponse.json();
  rejectedBatchId = rejectionBatch.id;
  for (const status of ["PROCESSING", "SUBMITTED_FOR_VERIFICATION"]) {
    const transition = await app.inject({
      method: "PATCH",
      url: `/api/batches/${rejectionBatch.code}/status`,
      headers: auth,
      payload: { status },
    });
    assert.equal(transition.statusCode, 200);
  }
  const rejection = await app.inject({
    method: "PATCH",
    url: `/api/verifier/batches/${rejectionBatch.code}/decision`,
    headers: verifierAuth,
    payload: { decision: "REJECTED", note: "Moisture result exceeds the allowed range" },
  });
  assert.equal(rejection.statusCode, 200);
  assert.equal(rejection.json().status, "REJECTED");
  const rejectedPublicRecord = await app.inject({ method: "GET", url: `/api/public/batches/${rejectionBatch.code}` });
  assert.equal(rejectedPublicRecord.json().verification, "VERIFIED_ON_CHAIN");
  assert.equal(rejectedPublicRecord.json().status, "REJECTED");
  assert.equal(rejectedPublicRecord.json().events.at(-1).type, "VERIFICATION_REJECTED");

  await prisma.batch.update({ where: { id: batchId }, data: { quantityKg: 99 } });
  const tamperedRecord = await app.inject({ method: "GET", url: `/api/public/batches/${batch.code}` });
  assert.equal(tamperedRecord.json().verification, "OFFCHAIN_TAMPERED");

  const secondaryRegistration = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name: "Other Keeper", email: `other-${randomUUID()}@example.test`, password: "other-field-password-123" },
  });
  secondaryUserId = secondaryRegistration.json().user.id;
  const foreignReading = await app.inject({
    method: "POST",
    url: `/api/hives/${hiveId}/readings/simulate`,
    headers: { authorization: `Bearer ${secondaryRegistration.json().token}` },
  });
  assert.equal(foreignReading.statusCode, 404);
});

test("hive analytics classifies sensor evidence and protects private hives", async () => {
  const app = await appPromise;
  const registration = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name: "Analytics Tester", email: `analytics-${randomUUID()}@example.test`, password: "analytics-test-password-123" },
  });
  assert.equal(registration.statusCode, 201);
  const userId = registration.json().user.id as string;
  const auth = { authorization: `Bearer ${registration.json().token as string}` };

  async function createAnalysis(name: string, readings: Array<{ temperatureC: number; humidityPct: number; weightKg: number }>) {
    const hiveResponse = await app.inject({
      method: "POST",
      url: "/api/hives",
      headers: auth,
      payload: { name, location: "Analytics test apiary" },
    });
    assert.equal(hiveResponse.statusCode, 201);
    const createdHiveId = hiveResponse.json().id as string;
    const start = Date.now() - (readings.length - 1) * 24 * 60 * 60 * 1000;
    for (const [index, reading] of readings.entries()) {
      const response = await app.inject({
        method: "POST",
        url: `/api/hives/${createdHiveId}/readings`,
        headers: auth,
        payload: { ...reading, source: "MANUAL", recordedAt: new Date(start + index * 24 * 60 * 60 * 1000).toISOString() },
      });
      assert.equal(response.statusCode, 201);
    }
    const response = await app.inject({ method: "GET", url: `/api/hives/${createdHiveId}/analysis`, headers: auth });
    assert.equal(response.statusCode, 200);
    return { hiveId: createdHiveId, result: response.json() as { health: string; diseaseRisk: number; productivityTrend: string; explanation: string } };
  }

  try {
    const healthy = await createAnalysis("Healthy evidence hive", [
      { temperatureC: 33.4, humidityPct: 54, weightKg: 25 },
      { temperatureC: 34, humidityPct: 56, weightKg: 26 },
      { temperatureC: 34.3, humidityPct: 55, weightKg: 28 },
    ]);
    assert.equal(healthy.result.health, "HEALTHY");
    assert.ok(healthy.result.diseaseRisk < 35);
    assert.equal(healthy.result.productivityTrend, "RISING");
    assert.ok(healthy.result.explanation.length > 40);

    const abnormal = await createAnalysis("Abnormal climate hive", [
      { temperatureC: 41, humidityPct: 82, weightKg: 25 },
      { temperatureC: 42, humidityPct: 84, weightKg: 25.2 },
      { temperatureC: 43, humidityPct: 85, weightKg: 25.3 },
    ]);
    assert.equal(abnormal.result.health, "URGENT_REVIEW");
    assert.ok(abnormal.result.diseaseRisk >= 70);
    assert.match(abnormal.result.explanation, /immediate review/i);

    const declining = await createAnalysis("Declining weight hive", [
      { temperatureC: 34, humidityPct: 55, weightKg: 28 },
      { temperatureC: 34.1, humidityPct: 55, weightKg: 25 },
      { temperatureC: 34, humidityPct: 56, weightKg: 21 },
    ]);
    assert.equal(declining.result.productivityTrend, "FALLING");
    assert.ok(declining.result.diseaseRisk >= 30);
    assert.match(declining.result.explanation, /-7\.0 kg/);

    const improving = await createAnalysis("Improving weight hive", [
      { temperatureC: 34, humidityPct: 55, weightKg: 20 },
      { temperatureC: 34.1, humidityPct: 55, weightKg: 23 },
      { temperatureC: 34, humidityPct: 56, weightKg: 26 },
    ]);
    assert.equal(improving.result.productivityTrend, "RISING");
    assert.equal(improving.result.health, "HEALTHY");

    const emptyHive = await app.inject({ method: "POST", url: "/api/hives", headers: auth, payload: { name: "Insufficient data hive", location: "Analytics test apiary" } });
    assert.equal(emptyHive.statusCode, 201);
    const insufficient = await app.inject({ method: "GET", url: `/api/hives/${emptyHive.json().id}/analysis`, headers: auth });
    assert.equal(insufficient.statusCode, 200);
    assert.equal(insufficient.json().health, "OBSERVE");
    assert.equal(insufficient.json().diseaseRisk, null);
    assert.equal(insufficient.json().productivityTrend, "STABLE");
    assert.match(insufficient.json().explanation, /no recent sensor readings/i);

    const unauthorized = await app.inject({ method: "GET", url: `/api/hives/${healthy.hiveId}/analysis` });
    assert.equal(unauthorized.statusCode, 401);
    const nonexistent = await app.inject({ method: "GET", url: "/api/hives/not-a-real-hive/analysis", headers: auth });
    assert.equal(nonexistent.statusCode, 404);
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("real chain supports batch traceability through public consumer proof", async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const envKeys = ["BLOCKCHAIN_RPC_URL", "BLOCKCHAIN_CHAIN_ID", "BLOCKCHAIN_PRIVATE_KEY", "CONTRACT_ADDRESS"] as const;
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const hardhatDefaultKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  let chainProcess: ReturnType<typeof spawn> | undefined;
  let provider: JsonRpcProvider | undefined;
  let realApp: Awaited<ReturnType<typeof createApp>> | undefined;
  let keeperId = "";
  let verifierId = "";
  let createdBatchId = "";

  try {
    const portServer = createServer();
    await new Promise<void>((resolve, reject) => {
      portServer.once("error", reject);
      portServer.listen(0, "127.0.0.1", resolve);
    });
    const port = (portServer.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => portServer.close((error) => error ? reject(error) : resolve()));

    const rpcUrl = `http://127.0.0.1:${port}`;
    const hardhatCli = path.join(repoRoot, "node_modules", "hardhat", "internal", "cli", "cli.js");
    chainProcess = spawn(process.execPath, [hardhatCli, "node", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: path.join(repoRoot, "packages", "contracts"),
      stdio: "ignore",
      windowsHide: true,
    });

    let chainReady = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (chainProcess.exitCode !== null) throw new Error(`Hardhat node exited with code ${chainProcess.exitCode}`);
      try {
        const response = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        });
        const result = await response.json() as { result?: string };
        if (response.ok && result.result === "0x7a69") {
          chainReady = true;
          break;
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    assert.equal(chainReady, true, "local Hardhat chain starts on chain 31337");

    const artifactPath = path.join(repoRoot, "packages", "contracts", "artifacts", "contracts", "BatchRegistry.sol", "BatchRegistry.json");
    const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as { abi: ConstructorParameters<typeof ContractFactory>[0]; bytecode: string };
    provider = new JsonRpcProvider(rpcUrl, 31337);
    const signer = new Wallet(hardhatDefaultKey, provider);
    const registry = await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy();
    await registry.waitForDeployment();

    process.env.BLOCKCHAIN_RPC_URL = rpcUrl;
    process.env.BLOCKCHAIN_CHAIN_ID = "31337";
    process.env.BLOCKCHAIN_PRIVATE_KEY = hardhatDefaultKey;
    process.env.CONTRACT_ADDRESS = await registry.getAddress();
    realApp = await createApp({ prisma, blockchain: new BlockchainService(), jwtSecret: "real-contract-traceability-test-secret" });
    await realApp.ready();

    const registration = await realApp.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Traceability Keeper", email: `traceability-${randomUUID()}@example.test`, password: "traceability-test-password-123" },
    });
    assert.equal(registration.statusCode, 201);
    keeperId = registration.json().user.id;
    const keeperAuth = { authorization: `Bearer ${registration.json().token as string}` };

    const hiveResponse = await realApp.inject({ method: "POST", url: "/api/hives", headers: keeperAuth, payload: { name: "Proof hive", location: "Traceability Apiary" } });
    assert.equal(hiveResponse.statusCode, 201);
    const hiveId = hiveResponse.json().id as string;
    const batchResponse = await realApp.inject({
      method: "POST",
      url: "/api/batches",
      headers: keeperAuth,
      payload: { hiveId, harvestDate: new Date().toISOString().slice(0, 10), quantityKg: 12.75, floralSource: "Clover" },
    });
    assert.equal(batchResponse.statusCode, 201);
    const batch = batchResponse.json();
    createdBatchId = batch.id;
    assert.match(batch.blockchainTx, /^0x[a-fA-F0-9]{64}$/);
    assert.equal(batch.blockchainNet, "31337");
    assert.deepEqual(batch.events.map((event: { type: string }) => event.type), ["BATCH_CREATED", "BLOCKCHAIN_ANCHORED"]);

    for (const status of ["PROCESSING", "SUBMITTED_FOR_VERIFICATION"] as const) {
      const lifecycleResponse: { statusCode: number; json: () => { status: string } } = await realApp.inject({ method: "PATCH", url: `/api/batches/${batch.code}/status`, headers: keeperAuth, payload: { status } });
      assert.equal(lifecycleResponse.statusCode, 200);
      assert.equal(lifecycleResponse.json().status, status);
    }

    const verifier = await prisma.user.create({
      data: { name: "Traceability Verifier", email: `traceability-verifier-${randomUUID()}@example.test`, passwordHash: await bcrypt.hash("traceability-verifier-password-123", 4), role: "VERIFIER" },
    });
    verifierId = verifier.id;
    const verifierAuth = { authorization: `Bearer ${realApp.jwt.sign({ sub: verifier.id, role: verifier.role, name: verifier.name, email: verifier.email })}` };
    const queue = await realApp.inject({ method: "GET", url: "/api/verifier/batches", headers: verifierAuth });
    assert.equal(queue.statusCode, 200);
    assert.equal(queue.json().some((queued: { code: string }) => queued.code === batch.code), true);

    const decision = await realApp.inject({
      method: "PATCH",
      url: `/api/verifier/batches/${batch.code}/decision`,
      headers: verifierAuth,
      payload: { decision: "VERIFIED", note: "Sample and source records checked against the anchored digest" },
    });
    assert.equal(decision.statusCode, 200);
    assert.equal(decision.json().status, "VERIFIED");

    const publicResponse = await realApp.inject({ method: "GET", url: `/api/public/batches/${batch.code}` });
    assert.equal(publicResponse.statusCode, 200);
    const publicBatch = publicResponse.json();
    assert.equal(publicBatch.chainVerified, true);
    assert.equal(publicBatch.verification, "VERIFIED_ON_CHAIN");
    assert.equal(publicBatch.status, "VERIFIED");
    assert.equal(publicBatch.hive.name, "Proof hive");
    assert.equal(publicBatch.hiveId, undefined);
    assert.equal(publicBatch.chainProof.dataDigest, `0x${batch.integrityDigest}`);
    assert.equal(publicBatch.chainProof.recordedBy.toLowerCase(), (await signer.getAddress()).toLowerCase());
    assert.ok(Number.isFinite(Date.parse(publicBatch.chainProof.recordedAt)));
    assert.equal(publicBatch.chainProof.network, "31337");
    assert.equal(publicBatch.chainProof.contractAddress, await registry.getAddress());
    assert.equal(publicBatch.chainProof.transactionHash, batch.blockchainTx);
    assert.equal(publicBatch.events.at(-1).type, "VERIFICATION_VERIFIED");
    assert.equal(publicBatch.events.at(-1).note, "Sample and source records checked against the anchored digest");

    const invalidBatch = await realApp.inject({ method: "GET", url: "/api/public/batches/not-a-real-batch" });
    assert.equal(invalidBatch.statusCode, 404);
  } finally {
    if (realApp) await realApp.close();
    if (createdBatchId) await prisma.batch.deleteMany({ where: { id: createdBatchId } });
    if (keeperId) await prisma.user.deleteMany({ where: { id: keeperId } });
    if (verifierId) await prisma.user.deleteMany({ where: { id: verifierId } });
    provider?.destroy();
    chainProcess?.kill();
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});