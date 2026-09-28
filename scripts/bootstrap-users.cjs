const path = require("node:path");
const bcrypt = require("bcryptjs");
const { PrismaClient, UserRole } = require("@prisma/client");
const dotenv = require("dotenv");

const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });

async function main() {
  const prisma = new PrismaClient();
  const configuredRoles = [
    { role: UserRole.VERIFIER, prefix: "BOOTSTRAP_VERIFIER", defaultName: "Honey Verifier" },
    { role: UserRole.ADMIN, prefix: "BOOTSTRAP_ADMIN", defaultName: "HoneyChain Admin" },
  ];
  let provisioned = 0;

  for (const configuration of configuredRoles) {
    const email = process.env[`${configuration.prefix}_EMAIL`]?.trim().toLowerCase();
    const password = process.env[`${configuration.prefix}_PASSWORD`];
    const name = process.env[`${configuration.prefix}_NAME`]?.trim() || configuration.defaultName;
    if (!email && !password) continue;
    if (!email || !password || password.length < 12) {
      throw new Error(`${configuration.prefix} needs an email and a password of at least 12 characters`);
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.user.upsert({
      where: { email },
      create: { email, name, passwordHash, role: configuration.role },
      update: { name, passwordHash, role: configuration.role },
    });
    provisioned += 1;
    console.log(`Provisioned ${configuration.role} account: ${email}`);
  }

  if (!provisioned) console.log("No verifier/admin credentials configured; no accounts were changed.");
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});