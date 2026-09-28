import "dotenv/config";
import { createApp } from "./app.js";

const port = Number(process.env.API_PORT ?? 3001);
if (process.env.NODE_ENV === "production" && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  throw new Error("JWT_SECRET must contain at least 32 characters in production");
}

const app = await createApp();
try {
  await app.listen({ port, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}