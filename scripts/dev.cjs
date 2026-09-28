const { spawn, spawnSync } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { randomBytes } = require("node:crypto");
const path = require("node:path");
const dotenv = require("dotenv");
const { Wallet } = require("ethers");

const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env");
const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const children = [];

function npmArgs(args) {
  return process.platform === "win32" && process.env.npm_execpath
    ? [process.env.npm_execpath, ...args]
    : args;
}

function setEnvValue(name, value) {
  const contents = readFileSync(envPath, "utf8");
  const entry = new RegExp(`^${name}=.*$`, "m");
  const updated = entry.test(contents)
    ? contents.replace(entry, `${name}=${value}`)
    : `${contents.trimEnd()}\n${name}=${value}\n`;
  writeFileSync(envPath, updated);
}

function prepareEnvironment() {
  if (!existsSync(envPath)) {
    const example = readFileSync(path.join(root, ".env.example"), "utf8");
    writeFileSync(envPath, example);
  }

  const env = dotenv.parse(readFileSync(envPath));
  if (!env.JWT_SECRET || env.JWT_SECRET.startsWith("replace-with-")) {
    setEnvValue("JWT_SECRET", randomBytes(48).toString("hex"));
  }
  if (!env.BLOCKCHAIN_PRIVATE_KEY) {
    setEnvValue("BLOCKCHAIN_PRIVATE_KEY", Wallet.createRandom().privateKey);
  }

  Object.assign(process.env, dotenv.parse(readFileSync(envPath)));
}

function runNpm(args, label) {
  console.log(`\n[setup] ${label}`);
  const result = spawnSync(npmCommand, npmArgs(args), { cwd: root, env: process.env, encoding: "utf8" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

async function waitForChain(child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Local blockchain stopped before becoming ready");
    try {
      const response = await fetch(process.env.BLOCKCHAIN_RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Local blockchain did not become ready within 30 seconds");
}

async function fundLocalSigner() {
  const signer = new Wallet(process.env.BLOCKCHAIN_PRIVATE_KEY);
  const response = await fetch(process.env.BLOCKCHAIN_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hardhat_setBalance", params: [signer.address, "0x3635C9ADC5DEA00000"] }),
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(`Could not fund local signer: ${result.error?.message ?? response.statusText}`);
}

function startNpm(args, label) {
  console.log(`[${label}] npm ${args.join(" ")}`);
  const child = spawn(npmCommand, npmArgs(args), { cwd: root, env: process.env, stdio: "inherit" });
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`[${label}] stopped with exit code ${code}`);
      stopChildren();
      process.exitCode = code;
    }
  });
  children.push(child);
  return child;
}

function stopChildren() {
  for (const child of children) if (child.exitCode === null) child.kill();
}

async function start() {
  prepareEnvironment();
  runNpm(["run", "db:generate"], "Generate database client");

  const chain = startNpm(["run", "node", "--workspace", "@honeychain/contracts"], "chain");
  await waitForChain(chain);
  await fundLocalSigner();
  const deployOutput = runNpm(["run", "deploy:local", "--workspace", "@honeychain/contracts"], "Deploy local batch registry");
  const contractAddress = deployOutput.match(/CONTRACT_ADDRESS=(0x[a-fA-F0-9]{40})/)?.[1];
  if (!contractAddress) throw new Error("Contract deployment did not report an address");
  setEnvValue("CONTRACT_ADDRESS", contractAddress);
  process.env.CONTRACT_ADDRESS = contractAddress;
  runNpm(["run", "db:push"], "Prepare local database");
  runNpm(["run", "chain:reanchor"], "Restore local batch anchors");

  startNpm(["run", "dev", "--workspace", "@honeychain/api"], "api");
  startNpm(["run", "dev", "--workspace", "@honeychain/web"], "web");
  console.log("\nHoneyChain is starting at http://localhost:5173");
  console.log("Local API: http://localhost:3001/api/health");
  console.log("Press Ctrl+C to stop the API, web server, and local chain.\n");
}

process.on("SIGINT", () => { stopChildren(); process.exit(0); });
process.on("SIGTERM", () => { stopChildren(); process.exit(0); });
start().catch((error) => {
  console.error(`\nHoneyChain startup failed: ${error.message}`);
  stopChildren();
  process.exitCode = 1;
});