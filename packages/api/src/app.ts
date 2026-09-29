import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { BatchStatus, PrismaClient, UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { batchStageProofKey, BlockchainService, digestBatch, digestBatchStage, type BatchStageDigestInput } from "./blockchain.js";
import { DefaultHiveAnalysisProvider, type HiveAnalysisProvider } from "./ai.js";

const registerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email(),
  password: z.string().min(10).max(100),
});
const loginSchema = z.object({ email: z.email(), password: z.string().min(1) });
const hiveSchema = z.object({
  name: z.string().trim().min(2).max(80),
  location: z.string().trim().min(2).max(160),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  colonyType: z.string().max(80).optional(),
  notes: z.string().max(500).optional(),
});
const sensorSchema = z.object({
  temperatureC: z.number().min(-30).max(80),
  humidityPct: z.number().min(0).max(100),
  weightKg: z.number().min(0).max(1000),
  recordedAt: z.iso.datetime().optional(),
  source: z.enum(["SIMULATOR", "MANUAL", "DEVICE"]).default("SIMULATOR"),
});
const batchSchema = z.object({
  hiveId: z.string().min(1),
  harvestDate: z.iso.date(),
  quantityKg: z.number().positive().max(10000),
  floralSource: z.string().trim().max(120).optional(),
});
const lifecycleSchema = z.object({ status: z.enum(["PROCESSING", "SUBMITTED_FOR_VERIFICATION"]) });
const verificationDecisionSchema = z.object({
  decision: z.enum(["VERIFIED", "REJECTED"]),
  note: z.string().trim().min(8).max(500),
});
const stageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PROCESSED"), processedAt: z.iso.date().optional(), method: z.string().trim().min(2).max(120), quantityKg: z.number().positive().max(10000), notes: z.string().trim().max(500).optional() }),
  z.object({ type: z.literal("PACKAGED"), packagedAt: z.iso.date().optional(), packageType: z.string().trim().min(2).max(120).optional(), lotIdentifier: z.string().trim().max(100).optional(), quantityKg: z.number().positive().max(10000), notes: z.string().trim().max(500).optional() }),
  z.object({ type: z.literal("DISTRIBUTED"), distributedAt: z.iso.date().optional(), destination: z.string().trim().min(2).max(160), quantityKg: z.number().positive().max(10000), notes: z.string().trim().max(500).optional() }),
]);

type UserClaims = { sub: string; role: string; name: string; email: string };
type BlockchainPort = Pick<BlockchainService, "isConfigured" | "anchorBatch" | "verifyBatch">;
type AppOptions = { prisma?: PrismaClient; blockchain?: BlockchainPort & Partial<Pick<BlockchainService, "getBatchProof">>; jwtSecret?: string; analysisProvider?: HiveAnalysisProvider };
type LedgerStageType = "HARVESTED" | "VERIFIED" | "PROCESSED" | "PACKAGED" | "DISTRIBUTED" | "CONSUMER_VERIFIED";

function stageData(input: BatchStageDigestInput) {
  return { ...input, occurredAt: new Date(input.occurredAt).toISOString() };
}

function stageMetadata(stage: z.infer<typeof stageSchema>) {
  if (stage.type === "PROCESSED") {
    return { occurredAt: stage.processedAt ? new Date(`${stage.processedAt}T12:00:00.000Z`) : new Date(), metadata: { method: stage.method, quantityKg: stage.quantityKg, notes: stage.notes } };
  }
  if (stage.type === "PACKAGED") {
    return { occurredAt: stage.packagedAt ? new Date(`${stage.packagedAt}T12:00:00.000Z`) : new Date(), metadata: { packageType: stage.packageType, lotIdentifier: stage.lotIdentifier, quantityKg: stage.quantityKg, notes: stage.notes } };
  }
  return { occurredAt: stage.distributedAt ? new Date(`${stage.distributedAt}T12:00:00.000Z`) : new Date(), metadata: { destination: stage.destination, quantityKg: stage.quantityKg, notes: stage.notes } };
}

function parseStageMetadata(metadataJson: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(metadataJson);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function publicStageMetadata(type: string, metadata: Record<string, unknown>) {
  const publicFields: Record<string, string[]> = {
    HARVESTED: ["quantityKg", "floralSource"],
    VERIFIED: [],
    PROCESSED: ["method", "quantityKg"],
    PACKAGED: ["packageType", "lotIdentifier", "quantityKg"],
    DISTRIBUTED: ["destination", "quantityKg"],
    CONSUMER_VERIFIED: [],
  };
  return Object.fromEntries((publicFields[type] ?? []).filter((key) => metadata[key] !== undefined).map((key) => [key, metadata[key]]));
}

function publicUser(user: { id: string; name: string; email: string; role: string }) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

function failure(reply: FastifyReply, statusCode: number, message: string) {
  return reply.code(statusCode).send({ error: message });
}

export async function createApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const prisma = options.prisma ?? new PrismaClient();
  const blockchain = options.blockchain ?? new BlockchainService();
  const analysisProvider = options.analysisProvider ?? new DefaultHiveAnalysisProvider();
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  app.decorate("prisma", prisma);
  app.addHook("onClose", async () => {
    if (!options.prisma) await prisma.$disconnect();
  });
  await app.register(helmet);
  await app.register(cors, { origin: process.env.WEB_ORIGIN ?? "http://localhost:5173" });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(jwt, { secret: options.jwtSecret ?? process.env.JWT_SECRET ?? randomBytes(32).toString("hex") });

  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify<UserClaims>();
    } catch {
      return failure(reply, 401, "Sign in to continue");
    }
  };
  const requireRoles = (...roles: UserRole[]) => async (request: FastifyRequest, reply: FastifyReply) => {
    const claims = request.user as UserClaims;
    if (!roles.includes(claims.role as UserRole)) return failure(reply, 403, "Your account cannot perform this action");
  };

  const appendStage = async (input: {
    batchId: string;
    batchCode: string;
    batchDigest: string;
    type: LedgerStageType;
    occurredAt: Date;
    actorId: string | null;
    metadata: Record<string, unknown>;
  }) => {
    const previous = await prisma.batchStage.findFirst({ where: { batchId: input.batchId }, orderBy: { sequence: "desc" } });
    const sequence = (previous?.sequence ?? 0) + 1;
    const data = stageData({
      batchCode: input.batchCode,
      type: input.type,
      sequence,
      occurredAt: input.occurredAt.toISOString(),
      actorId: input.actorId,
      status: "RECORDED",
      metadata: input.metadata,
      previousDigest: previous?.digest ?? input.batchDigest,
    });
    const digest = digestBatchStage(data);
    const proofKey = batchStageProofKey(input.batchCode, sequence);
    const stage = await prisma.batchStage.create({ data: {
      batchId: input.batchId,
      type: input.type,
      sequence,
      occurredAt: input.occurredAt,
      actorId: input.actorId,
      metadataJson: JSON.stringify(input.metadata),
      previousDigest: data.previousDigest,
      digest,
      proofKey,
    } });

    try {
      const anchor = await blockchain.anchorBatch(proofKey, digest);
      if (anchor) return await prisma.batchStage.update({ where: { id: stage.id }, data: { blockchainTx: anchor.txHash, blockchainNet: anchor.network } });
    } catch (error) {
      requestLogger.error({ err: error, batchCode: input.batchCode, stage: input.type }, "Batch stage recorded but blockchain anchor failed");
    }
    return stage;
  };

  const requestLogger = app.log;

  const publicStageHistory = async (batchCode: string) => {
    const stages = await prisma.batchStage.findMany({ where: { batch: { code: batchCode } }, orderBy: { sequence: "asc" } });
    return Promise.all(stages.map(async (stage) => {
      const fullMetadata = parseStageMetadata(stage.metadataJson);
      const input = stageData({
        batchCode,
        type: stage.type,
        sequence: stage.sequence,
        occurredAt: stage.occurredAt.toISOString(),
        actorId: stage.actorId,
        status: stage.status,
        metadata: fullMetadata,
        previousDigest: stage.previousDigest,
      });
      const offchainVerified = digestBatchStage(input).toLowerCase() === stage.digest.toLowerCase();
      const chainVerified = offchainVerified && await blockchain.verifyBatch(stage.proofKey, stage.digest) === true;
      return {
        type: stage.type,
        sequence: stage.sequence,
        occurredAt: stage.occurredAt,
        status: stage.status,
        metadata: publicStageMetadata(stage.type, fullMetadata),
        proof: { verified: chainVerified, digest: `0x${stage.digest}`, transactionHash: stage.blockchainTx, network: stage.blockchainNet },
      };
    }));
  };

  app.get("/api/health", async () => {
    let database = "connected";
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      database = "unavailable";
    }
    return { status: database === "connected" ? "ok" : "degraded", database, blockchain: blockchain.isConfigured() ? "configured" : "not-configured" };
  });

  app.post("/api/auth/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) return failure(reply, 400, parsed.error.issues[0]?.message ?? "Invalid registration details");
    const email = parsed.data.email.trim().toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return failure(reply, 409, "An account with this email already exists");
    const user = await prisma.user.create({
      data: { name: parsed.data.name, email, passwordHash: await bcrypt.hash(parsed.data.password, 12), role: "BEEKEEPER" },
    });
    const token = app.jwt.sign({ sub: user.id, role: user.role, name: user.name, email: user.email });
    return reply.code(201).send({ token, user: publicUser(user) });
  });

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return failure(reply, 400, "Email and password are required");
    const user = await prisma.user.findUnique({ where: { email: parsed.data.email.trim().toLowerCase() } });
    if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) return failure(reply, 401, "Email or password is incorrect");
    const token = app.jwt.sign({ sub: user.id, role: user.role, name: user.name, email: user.email });
    return { token, user: publicUser(user) };
  });

  app.get("/api/auth/me", { preHandler: authenticate }, async (request, reply) => {
    const claims = request.user as UserClaims;
    const user = await prisma.user.findUnique({ where: { id: claims.sub } });
    return user ? publicUser(user) : failure(reply, 404, "Account not found");
  });

  app.get("/api/dashboard", { preHandler: authenticate }, async (request) => {
    const { sub } = request.user as UserClaims;
    const [hives, batches, readings, recentBatches] = await Promise.all([
      prisma.hive.count({ where: { ownerId: sub } }),
      prisma.batch.count({ where: { beekeeperId: sub } }),
      prisma.sensorReading.findMany({ where: { hive: { ownerId: sub } }, orderBy: { recordedAt: "desc" }, take: 8, include: { hive: { select: { name: true } } } }),
      prisma.batch.findMany({ where: { beekeeperId: sub }, orderBy: { createdAt: "desc" }, take: 6, include: { hive: { select: { name: true } }, events: { orderBy: { createdAt: "desc" }, take: 1 } } }),
    ]);
    return { counts: { hives, batches }, readings, batches: recentBatches };
  });

  app.get("/api/hives", { preHandler: authenticate }, async (request) => {
    const { sub } = request.user as UserClaims;
    return prisma.hive.findMany({ where: { ownerId: sub }, orderBy: { createdAt: "desc" }, include: { readings: { orderBy: { recordedAt: "desc" }, take: 1 } } });
  });

  app.get("/api/hives/:hiveId/analysis", { preHandler: authenticate }, async (request, reply) => {
    const { sub } = request.user as UserClaims;
    const { hiveId } = request.params as { hiveId: string };
    const hive = await prisma.hive.findFirst({ where: { id: hiveId, ownerId: sub }, select: { id: true } });
    if (!hive) return failure(reply, 404, "Hive not found");

    const readings = await prisma.sensorReading.findMany({
      where: { hiveId },
      orderBy: { recordedAt: "asc" },
      take: 30,
      select: { temperatureC: true, humidityPct: true, weightKg: true, recordedAt: true },
    });

    return analysisProvider.analyze({
      hiveId,
      readings: readings.map((reading) => ({
        temperatureC: reading.temperatureC,
        humidityPct: reading.humidityPct,
        weightKg: reading.weightKg,
        recordedAt: reading.recordedAt.toISOString(),
      })),
    });
  });

  app.post("/api/hives", { preHandler: authenticate }, async (request, reply) => {
    const parsed = hiveSchema.safeParse(request.body);
    if (!parsed.success) return failure(reply, 400, parsed.error.issues[0]?.message ?? "Invalid hive details");
    const { sub } = request.user as UserClaims;
    const hive = await prisma.hive.create({ data: { ...parsed.data, ownerId: sub } });
    return reply.code(201).send(hive);
  });

  app.post("/api/hives/:hiveId/readings", { preHandler: authenticate }, async (request, reply) => {
    const parsed = sensorSchema.safeParse(request.body);
    if (!parsed.success) return failure(reply, 400, parsed.error.issues[0]?.message ?? "Invalid sensor reading");
    const { sub } = request.user as UserClaims;
    const { hiveId } = request.params as { hiveId: string };
    const hive = await prisma.hive.findFirst({ where: { id: hiveId, ownerId: sub }, select: { id: true } });
    if (!hive) return failure(reply, 404, "Hive not found");
    return reply.code(201).send(await prisma.sensorReading.create({
      data: { hiveId, ...parsed.data, recordedAt: parsed.data.recordedAt ? new Date(parsed.data.recordedAt) : new Date() },
    }));
  });

  app.post("/api/hives/:hiveId/readings/simulate", { preHandler: authenticate }, async (request, reply) => {
    const { sub } = request.user as UserClaims;
    const { hiveId } = request.params as { hiveId: string };
    const hive = await prisma.hive.findFirst({ where: { id: hiveId, ownerId: sub }, select: { id: true } });
    if (!hive) return failure(reply, 404, "Hive not found");
    const reading = sensorSchema.parse({
      temperatureC: Number((32 + Math.random() * 4).toFixed(1)),
      humidityPct: Number((48 + Math.random() * 22).toFixed(1)),
      weightKg: Number((24 + Math.random() * 12).toFixed(1)),
      source: "SIMULATOR",
    });
    return reply.code(201).send(await prisma.sensorReading.create({ data: { hiveId, ...reading } }));
  });

  app.get("/api/hives/:hiveId/readings", { preHandler: authenticate }, async (request, reply) => {
    const { sub } = request.user as UserClaims;
    const { hiveId } = request.params as { hiveId: string };
    const hive = await prisma.hive.findFirst({ where: { id: hiveId, ownerId: sub }, select: { id: true } });
    if (!hive) return failure(reply, 404, "Hive not found");
    return prisma.sensorReading.findMany({ where: { hiveId }, orderBy: { recordedAt: "desc" }, take: 100 });
  });

  app.post("/api/batches", { preHandler: authenticate }, async (request, reply) => {
    const parsed = batchSchema.safeParse(request.body);
    if (!parsed.success) return failure(reply, 400, parsed.error.issues[0]?.message ?? "Invalid harvest details");
    const { sub } = request.user as UserClaims;
    const hive = await prisma.hive.findFirst({ where: { id: parsed.data.hiveId, ownerId: sub }, select: { id: true } });
    if (!hive) return failure(reply, 404, "Hive not found");
    const code = `HC-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const harvestDate = new Date(`${parsed.data.harvestDate}T00:00:00.000Z`);
    const integrityDigest = digestBatch({ code, hiveId: hive.id, quantityKg: parsed.data.quantityKg, harvestDate: harvestDate.toISOString(), floralSource: parsed.data.floralSource });
    const batch = await prisma.batch.create({ data: {
      code,
      hiveId: hive.id,
      beekeeperId: sub,
      harvestDate,
      quantityKg: parsed.data.quantityKg,
      floralSource: parsed.data.floralSource,
      integrityDigest,
      events: { create: { type: "BATCH_CREATED", note: "Harvest recorded and batch created", actorId: sub } },
    } });
    try {
      const anchor = await blockchain.anchorBatch(code, integrityDigest);
      if (anchor) {
        await prisma.batch.update({ where: { id: batch.id }, data: { blockchainTx: anchor.txHash, blockchainNet: anchor.network } });
        await prisma.batchEvent.create({ data: { batchId: batch.id, type: "BLOCKCHAIN_ANCHORED", note: `Anchored on chain ${anchor.network}; transaction ${anchor.txHash}`, actorId: sub } });
      }
    } catch (error) {
      request.log.error({ err: error, batchCode: code }, "Batch created but blockchain anchor failed");
    }
    await appendStage({
      batchId: batch.id,
      batchCode: batch.code,
      batchDigest: batch.integrityDigest,
      type: "HARVESTED",
      occurredAt: harvestDate,
      actorId: sub,
      metadata: { quantityKg: parsed.data.quantityKg, floralSource: parsed.data.floralSource ?? null },
    });
    const result = await prisma.batch.findUnique({ where: { id: batch.id }, include: { hive: { select: { name: true } }, events: { orderBy: { createdAt: "asc" } }, stages: { orderBy: { sequence: "asc" } } } });
    return reply.code(201).send(result);
  });

  app.get("/api/batches", { preHandler: authenticate }, async (request) => {
    const { sub } = request.user as UserClaims;
    const batches = await prisma.batch.findMany({ where: { beekeeperId: sub }, orderBy: { createdAt: "desc" }, include: { hive: { select: { name: true } }, events: { orderBy: { createdAt: "asc" } }, stages: { orderBy: { sequence: "asc" } } } });
    return batches.map((batch) => ({ ...batch, stages: batch.stages.map((stage) => ({ ...stage, metadata: parseStageMetadata(stage.metadataJson), metadataJson: undefined })) }));
  });

  app.get("/api/batches/:code/stages", { preHandler: authenticate }, async (request, reply) => {
    const claims = request.user as UserClaims;
    const { code } = request.params as { code: string };
    const batch = await prisma.batch.findUnique({ where: { code }, select: { id: true, beekeeperId: true } });
    if (!batch) return failure(reply, 404, "Batch not found");
    const privileged = claims.role === UserRole.ADMIN || claims.role === UserRole.VERIFIER;
    if (batch.beekeeperId !== claims.sub && !privileged) return failure(reply, 403, "You cannot view this batch's stage history");
    const stages = await prisma.batchStage.findMany({ where: { batchId: batch.id }, orderBy: { sequence: "asc" } });
    return stages.map((stage) => ({ ...stage, metadata: parseStageMetadata(stage.metadataJson), metadataJson: undefined }));
  });

  app.post("/api/batches/:code/stages", { preHandler: authenticate }, async (request, reply) => {
    const parsed = stageSchema.safeParse(request.body);
    if (!parsed.success) return failure(reply, 400, parsed.error.issues[0]?.message ?? "Invalid stage details");
    const claims = request.user as UserClaims;
    if (claims.role !== UserRole.BEEKEEPER && claims.role !== UserRole.ADMIN) return failure(reply, 403, "Only the beekeeper or an administrator can record operational stages");
    const { code } = request.params as { code: string };
    let batch = await prisma.batch.findUnique({ where: { code }, include: { stages: { orderBy: { sequence: "desc" }, take: 1 } } });
    if (!batch) return failure(reply, 404, "Batch not found");
    if (claims.role !== UserRole.ADMIN && batch.beekeeperId !== claims.sub) return failure(reply, 403, "You cannot update this batch");

    if (batch.status === BatchStatus.VERIFIED && batch.stages.length === 0) {
      const priorReview = await prisma.batchEvent.findFirst({ where: { batchId: batch.id, type: "VERIFICATION_VERIFIED" }, orderBy: { createdAt: "asc" } });
      await appendStage({ batchId: batch.id, batchCode: batch.code, batchDigest: batch.integrityDigest, type: "HARVESTED", occurredAt: batch.harvestDate, actorId: batch.beekeeperId, metadata: { quantityKg: batch.quantityKg, floralSource: batch.floralSource } });
      await appendStage({ batchId: batch.id, batchCode: batch.code, batchDigest: batch.integrityDigest, type: "VERIFIED", occurredAt: priorReview?.createdAt ?? new Date(), actorId: priorReview?.actorId ?? null, metadata: { decision: "VERIFIED" } });
      batch = await prisma.batch.findUnique({ where: { code }, include: { stages: { orderBy: { sequence: "desc" }, take: 1 } } });
      if (!batch) return failure(reply, 404, "Batch not found");
    }

    const expectedPredecessor: Record<string, LedgerStageType> = { PROCESSED: "VERIFIED", PACKAGED: "PROCESSED", DISTRIBUTED: "PACKAGED" };
    const predecessor = expectedPredecessor[parsed.data.type];
    const latest = batch.stages[0];
    if (!latest || latest.type !== predecessor || batch.status !== BatchStatus.VERIFIED) return failure(reply, 409, `${parsed.data.type} requires the preceding verified stage`);
    const expectedDigest = digestBatchStage(stageData({
      batchCode: batch.code,
      type: latest.type,
      sequence: latest.sequence,
      occurredAt: latest.occurredAt.toISOString(),
      actorId: latest.actorId,
      status: latest.status,
      metadata: parseStageMetadata(latest.metadataJson),
      previousDigest: latest.previousDigest,
    }));
    if (expectedDigest.toLowerCase() !== latest.digest.toLowerCase() || await blockchain.verifyBatch(latest.proofKey, latest.digest) !== true) {
      return failure(reply, 409, "A valid blockchain proof for the preceding stage is required");
    }

    const { occurredAt: requestedAt, metadata } = stageMetadata(parsed.data);
    if (requestedAt.toISOString().slice(0, 10) < latest.occurredAt.toISOString().slice(0, 10)) return failure(reply, 400, "Stage date cannot precede the previous stage");
    const occurredAt = requestedAt <= latest.occurredAt ? new Date(latest.occurredAt.getTime() + 1000) : requestedAt;
    try {
      const stage = await appendStage({ batchId: batch.id, batchCode: batch.code, batchDigest: batch.integrityDigest, type: parsed.data.type, occurredAt, actorId: claims.sub, metadata });
      return reply.code(201).send({ ...stage, metadata, metadataJson: undefined });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") return failure(reply, 409, "This batch stage has already been recorded");
      throw error;
    }
  });

  app.get("/api/public/batches/:code/stages", async (request, reply) => {
    const { code } = request.params as { code: string };
    const batch = await prisma.batch.findUnique({ where: { code }, select: { id: true } });
    if (!batch) return failure(reply, 404, "Batch not found");
    return publicStageHistory(code);
  });

  app.patch("/api/batches/:code/status", { preHandler: authenticate }, async (request, reply) => {
    const parsed = lifecycleSchema.safeParse(request.body);
    if (!parsed.success) return failure(reply, 400, parsed.error.issues[0]?.message ?? "Invalid batch status");
    const { sub } = request.user as UserClaims;
    const { code } = request.params as { code: string };
    const batch = await prisma.batch.findFirst({ where: { code, beekeeperId: sub } });
    if (!batch) return failure(reply, 404, "Batch not found");

    const allowedNextStatus: Partial<Record<BatchStatus, BatchStatus>> = {
      [BatchStatus.CREATED]: BatchStatus.PROCESSING,
      [BatchStatus.PROCESSING]: BatchStatus.SUBMITTED_FOR_VERIFICATION,
    };
    if (allowedNextStatus[batch.status] !== parsed.data.status) return failure(reply, 409, `Batch cannot move from ${batch.status} to ${parsed.data.status}`);

    const eventType = parsed.data.status === BatchStatus.PROCESSING ? "PROCESSING_STARTED" : "SUBMITTED_FOR_VERIFICATION";
    const [updated] = await prisma.$transaction([
      prisma.batch.update({ where: { id: batch.id }, data: { status: parsed.data.status } }),
      prisma.batchEvent.create({ data: { batchId: batch.id, type: eventType, note: parsed.data.status === BatchStatus.PROCESSING ? "Batch moved to processing" : "Batch submitted for verifier review", actorId: sub } }),
    ]);
    return updated;
  });

  app.get("/api/verifier/batches", { preHandler: [authenticate, requireRoles(UserRole.VERIFIER, UserRole.ADMIN)] }, async () => {
    return prisma.batch.findMany({
      where: { status: BatchStatus.SUBMITTED_FOR_VERIFICATION },
      orderBy: { createdAt: "asc" },
      include: { hive: { select: { name: true, location: true } }, beekeeper: { select: { id: true, name: true } }, events: { orderBy: { createdAt: "asc" } } },
    });
  });

  app.patch("/api/verifier/batches/:code/decision", { preHandler: [authenticate, requireRoles(UserRole.VERIFIER, UserRole.ADMIN)] }, async (request, reply) => {
    const parsed = verificationDecisionSchema.safeParse(request.body);
    if (!parsed.success) return failure(reply, 400, parsed.error.issues[0]?.message ?? "A review decision and note are required");
    const { sub } = request.user as UserClaims;
    const { code } = request.params as { code: string };
    const batch = await prisma.batch.findUnique({ where: { code } });
    if (!batch) return failure(reply, 404, "Batch not found");
    if (batch.beekeeperId === sub) return failure(reply, 403, "A verifier cannot review their own batch");
    if (batch.status !== BatchStatus.SUBMITTED_FOR_VERIFICATION) return failure(reply, 409, "Only submitted batches can be reviewed");

    const currentDigest = digestBatch({ code: batch.code, hiveId: batch.hiveId, quantityKg: batch.quantityKg, harvestDate: batch.harvestDate.toISOString(), floralSource: batch.floralSource });
    if (currentDigest.toLowerCase() !== batch.integrityDigest.toLowerCase()) return failure(reply, 409, "Batch data no longer matches its integrity digest");
    if (await blockchain.verifyBatch(batch.code, currentDigest) !== true) return failure(reply, 409, "A valid blockchain anchor is required before verification");

    const [updated] = await prisma.$transaction([
      prisma.batch.update({ where: { id: batch.id }, data: { status: parsed.data.decision } }),
      prisma.batchEvent.create({ data: { batchId: batch.id, type: `VERIFICATION_${parsed.data.decision}`, note: parsed.data.note, actorId: sub } }),
    ]);
    if (parsed.data.decision === "VERIFIED") {
      const harvested = await prisma.batchStage.findFirst({ where: { batchId: batch.id, type: "HARVESTED" } });
      if (!harvested) await appendStage({ batchId: batch.id, batchCode: batch.code, batchDigest: batch.integrityDigest, type: "HARVESTED", occurredAt: batch.harvestDate, actorId: batch.beekeeperId, metadata: { quantityKg: batch.quantityKg, floralSource: batch.floralSource } });
      await appendStage({
        batchId: batch.id,
        batchCode: batch.code,
        batchDigest: batch.integrityDigest,
        type: "VERIFIED",
        occurredAt: new Date(),
        actorId: sub,
        metadata: { decision: "VERIFIED", note: parsed.data.note },
      });
    }
    return updated;
  });

  app.get("/api/batches/:code", { preHandler: authenticate }, async (request, reply) => {
    const { sub } = request.user as UserClaims;
    const { code } = request.params as { code: string };
    const batch = await prisma.batch.findFirst({ where: { code, beekeeperId: sub }, include: { hive: { select: { name: true, location: true } }, events: { orderBy: { createdAt: "asc" } }, stages: { orderBy: { sequence: "asc" } } } });
    return batch ? { ...batch, stages: batch.stages.map((stage) => ({ ...stage, metadata: parseStageMetadata(stage.metadataJson), metadataJson: undefined })) } : failure(reply, 404, "Batch not found");
  });

  app.get("/api/public/batches/:code", async (request, reply) => {
    const { code } = request.params as { code: string };
    const batch = await prisma.batch.findUnique({
      where: { code },
      select: { code: true, hiveId: true, harvestDate: true, quantityKg: true, floralSource: true, status: true, integrityDigest: true, blockchainTx: true, blockchainNet: true, createdAt: true, hive: { select: { name: true } }, events: { orderBy: { createdAt: "asc" }, select: { type: true, note: true, createdAt: true } } },
    });
    if (!batch) return failure(reply, 404, "Batch not found");
    const currentDigest = digestBatch({ code: batch.code, hiveId: batch.hiveId, quantityKg: batch.quantityKg, harvestDate: batch.harvestDate.toISOString(), floralSource: batch.floralSource });
    const offchainIntact = currentDigest.toLowerCase() === batch.integrityDigest.toLowerCase();
    const chainProof = await blockchain.getBatchProof?.(batch.code) ?? null;
    const chainVerified = !offchainIntact
      ? false
      : blockchain.getBatchProof
        ? chainProof ? chainProof.dataDigest.toLowerCase() === `0x${currentDigest}`.toLowerCase() : blockchain.isConfigured() ? false : null
        : await blockchain.verifyBatch(batch.code, currentDigest);
    const verification = !offchainIntact ? "OFFCHAIN_TAMPERED" : chainVerified === true ? "VERIFIED_ON_CHAIN" : chainVerified === false ? "CHAIN_MISMATCH" : "NOT_ANCHORED";
    const { hiveId: _hiveId, events, ...publicBatch } = batch;
    const publicStages = await publicStageHistory(code);
    return {
      ...publicBatch,
      beekeeper: { name: "a registered beekeeper" },
      events: events.map((event) => ({
        type: event.type,
        note: event.type === "VERIFICATION_VERIFIED" ? "Batch approved by an authorized verifier" : event.type === "VERIFICATION_REJECTED" ? "Batch was not approved" : event.type === "BLOCKCHAIN_ANCHORED" ? "Batch integrity digest anchored on-chain" : event.type.replaceAll("_", " ").toLowerCase(),
        createdAt: event.createdAt,
      })),
      stages: publicStages,
      chainProof: chainProof ? {
        ...chainProof,
        transactionHash: batch.blockchainTx,
        contractAddress: process.env.CONTRACT_ADDRESS ?? null,
      } : null,
      chainVerified,
      verification,
    };
  });

  app.post("/api/public/batches/:code/verify", async (request, reply) => {
    const { code } = request.params as { code: string };
    const batch = await prisma.batch.findUnique({ where: { code }, include: { stages: { orderBy: { sequence: "desc" }, take: 1 } } });
    if (!batch) return failure(reply, 404, "Batch not found");
    if (batch.stages[0]?.type !== "DISTRIBUTED") return failure(reply, 409, "Consumer verification is available after distribution");
    const distribution = batch.stages[0];
    const distributionData = stageData({
      batchCode: batch.code,
      type: distribution.type,
      sequence: distribution.sequence,
      occurredAt: distribution.occurredAt.toISOString(),
      actorId: distribution.actorId,
      status: distribution.status,
      metadata: parseStageMetadata(distribution.metadataJson),
      previousDigest: distribution.previousDigest,
    });
    if (digestBatchStage(distributionData).toLowerCase() !== distribution.digest.toLowerCase() || await blockchain.verifyBatch(distribution.proofKey, distribution.digest) !== true) return failure(reply, 409, "A valid distribution stage proof is required");
    const occurredAt = new Date(Math.max(Date.now(), distribution.occurredAt.getTime() + 1000));
    const stage = await appendStage({ batchId: batch.id, batchCode: batch.code, batchDigest: batch.integrityDigest, type: "CONSUMER_VERIFIED", occurredAt, actorId: null, metadata: { channel: "PUBLIC_QR" } });
    return reply.code(201).send({ type: stage.type, occurredAt: stage.occurredAt, proof: { verified: Boolean(stage.blockchainTx), digest: `0x${stage.digest}`, transactionHash: stage.blockchainTx, network: stage.blockchainNet } });
  });

  app.get("/api/blockchain/status", async () => ({ configured: blockchain.isConfigured(), network: process.env.BLOCKCHAIN_CHAIN_ID ?? null, contractAddress: process.env.CONTRACT_ADDRESS ?? null }));

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    return reply.code(500).send({ error: "An unexpected server error occurred" });
  });

  return app;
}