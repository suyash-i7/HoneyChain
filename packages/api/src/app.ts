import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { BlockchainService, digestBatch } from "./blockchain.js";

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

type UserClaims = { sub: string; role: string; name: string; email: string };
type BlockchainPort = Pick<BlockchainService, "isConfigured" | "anchorBatch" | "verifyBatch">;
type AppOptions = { prisma?: PrismaClient; blockchain?: BlockchainPort; jwtSecret?: string };

function publicUser(user: { id: string; name: string; email: string; role: string }) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

function failure(reply: FastifyReply, statusCode: number, message: string) {
  return reply.code(statusCode).send({ error: message });
}

export async function createApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const prisma = options.prisma ?? new PrismaClient();
  const blockchain = options.blockchain ?? new BlockchainService();
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
    const result = await prisma.batch.findUnique({ where: { id: batch.id }, include: { hive: { select: { name: true } }, events: { orderBy: { createdAt: "asc" } } } });
    return reply.code(201).send(result);
  });

  app.get("/api/batches", { preHandler: authenticate }, async (request) => {
    const { sub } = request.user as UserClaims;
    return prisma.batch.findMany({ where: { beekeeperId: sub }, orderBy: { createdAt: "desc" }, include: { hive: { select: { name: true } }, events: { orderBy: { createdAt: "asc" } } } });
  });

  app.get("/api/batches/:code", { preHandler: authenticate }, async (request, reply) => {
    const { sub } = request.user as UserClaims;
    const { code } = request.params as { code: string };
    const batch = await prisma.batch.findFirst({ where: { code, beekeeperId: sub }, include: { hive: { select: { name: true, location: true } }, events: { orderBy: { createdAt: "asc" } } } });
    return batch ?? failure(reply, 404, "Batch not found");
  });

  app.get("/api/public/batches/:code", async (request, reply) => {
    const { code } = request.params as { code: string };
    const batch = await prisma.batch.findUnique({
      where: { code },
      select: { code: true, hiveId: true, harvestDate: true, quantityKg: true, floralSource: true, status: true, integrityDigest: true, blockchainTx: true, blockchainNet: true, createdAt: true, hive: { select: { name: true, location: true } }, beekeeper: { select: { name: true } }, events: { orderBy: { createdAt: "asc" }, select: { type: true, note: true, createdAt: true } } },
    });
    if (!batch) return failure(reply, 404, "Batch not found");
    const currentDigest = digestBatch({ code: batch.code, hiveId: batch.hiveId, quantityKg: batch.quantityKg, harvestDate: batch.harvestDate.toISOString(), floralSource: batch.floralSource });
    const offchainIntact = currentDigest.toLowerCase() === batch.integrityDigest.toLowerCase();
    const chainVerified = offchainIntact ? await blockchain.verifyBatch(batch.code, currentDigest) : false;
    const verification = !offchainIntact ? "OFFCHAIN_TAMPERED" : chainVerified === true ? "VERIFIED_ON_CHAIN" : chainVerified === false ? "CHAIN_MISMATCH" : "NOT_ANCHORED";
    return { ...batch, chainVerified, verification };
  });

  app.get("/api/blockchain/status", async () => ({ configured: blockchain.isConfigured(), network: process.env.BLOCKCHAIN_CHAIN_ID ?? null, contractAddress: process.env.CONTRACT_ADDRESS ?? null }));

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    return reply.code(500).send({ error: "An unexpected server error occurred" });
  });

  return app;
}