import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createApp } from "./app.js";

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