const { ethers } = require("hardhat");

async function main() {
  const registry = await ethers.deployContract("BatchRegistry");
  await registry.waitForDeployment();
  console.log(`CONTRACT_ADDRESS=${await registry.getAddress()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});