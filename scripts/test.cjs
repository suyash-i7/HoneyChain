const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

const root = path.resolve(__dirname, "..");
const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmArgs = (args) => process.platform === "win32" && process.env.npm_execpath
  ? [process.env.npm_execpath, ...args]
  : args;
const envPath = path.join(root, ".env");
const env = {
  ...process.env,
  ...(existsSync(envPath) ? dotenv.parse(readFileSync(envPath)) : {}),
};
env.DATABASE_URL ??= "file:./dev.db";
env.JWT_SECRET ??= "local-integration-test-secret-48-characters-long";

for (const args of [
  ["run", "db:push"],
  ["run", "test", "--workspace", "@honeychain/api"],
]) {
  const result = spawnSync(npmCommand, npmArgs(args), { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}