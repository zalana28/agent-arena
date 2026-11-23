#!/usr/bin/env node
// Deploy Arena (which creates ChampionBadge in its constructor) to BNB Chain.
// Usage:
//   BSC_RPC_URL=https://bsc-dataseed.binance.org \
//   DEPLOYER_KEY=0x... \
//   node scripts/deploy.js [--agent-id 0x...] [--chain-id 56]
//
// DEPLOYER_KEY is read from the environment only — never put it in a file.
// The deployer needs ~0.01 BNB for gas (measured 3,000,909 gas on ganache;
// at 3 gwei that is ~0.0090 BNB). The script prints the exact cost paid.
// After deploy it writes the Arena address into frontend/config.js.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const MAINNET_AGENT_ID = "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F";

async function main() {
  const args = process.argv.slice(2);
  const agentIdIdx = args.indexOf("--agent-id");
  const chainIdx = args.indexOf("--chain-id");
  const expectedChain = chainIdx >= 0 ? Number(args[chainIdx + 1]) : 56;
  // L-4 (audit 2026-11-23): the mainnet Agent ID address is NOT a safe
  // default off-mainnet — on testnet it points at an address with no code
  // and every ownerOf call reverts, bricking all gameplay. Require an
  // explicit --agent-id whenever the target chain is not mainnet (56).
  if (expectedChain !== 56 && agentIdIdx < 0) {
    throw new Error(
      "Refusing to deploy to chain " +
        expectedChain +
        " without --agent-id: the default Agent ID address " +
        MAINNET_AGENT_ID +
        " only exists on BNB Chain mainnet (56). Pass --agent-id <mock address> for testnet."
    );
  }
  const agentId = agentIdIdx >= 0 ? args[agentIdIdx + 1] : MAINNET_AGENT_ID;

  const rpc = process.env.BSC_RPC_URL;
  const key = process.env.DEPLOYER_KEY;
  if (!rpc) throw new Error("Set BSC_RPC_URL (e.g. https://bsc-dataseed.binance.org/)");
  if (!key) throw new Error("Set DEPLOYER_KEY (0x-prefixed private key, env only)");

  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== expectedChain) {
    throw new Error(`Connected to chain ${network.chainId}, expected ${expectedChain}`);
  }
  console.log("Deployer:", wallet.address);
  console.log("Balance:", ethers.formatEther(await provider.getBalance(wallet.address)), "BNB");
  console.log("Agent ID contract:", agentId);

  const arenaArt = JSON.parse(fs.readFileSync(path.join(ROOT, "build", "Arena.json"), "utf8"));
  const factory = new ethers.ContractFactory(arenaArt.abi, arenaArt.bytecode, wallet);
  const arena = await factory.deploy(agentId);
  console.log("Deploy tx:", arena.deploymentTransaction().hash);
  const receipt = await arena.deploymentTransaction().wait();
  const arenaAddr = await arena.getAddress();
  const badgeAddr = await arena.badge();
  const costBNB = receipt.gasUsed * receipt.gasPrice;
  console.log("\nArena deployed at:", arenaAddr);
  console.log("ChampionBadge at:", badgeAddr);
  console.log("Gas used:", receipt.gasUsed.toString());
  console.log("Gas price:", ethers.formatUnits(receipt.gasPrice, "gwei"), "gwei");
  console.log("Cost paid:", ethers.formatEther(costBNB), "BNB");
  console.log("Block:", receipt.blockNumber);

  // Write the address into the frontend config.
  const cfgPath = path.join(ROOT, "frontend", "config.js");
  let cfg = fs.readFileSync(cfgPath, "utf8");
  cfg = cfg.replace(
    /ARENA_ADDRESS: "0x[0-9a-fA-F]{40}"/,
    `ARENA_ADDRESS: "${arenaAddr}"`
  );
  fs.writeFileSync(cfgPath, cfg);
  console.log("\nfrontend/config.js updated with the Arena address.");

  console.log("\nVerify on BscScan with:");
  console.log("  node scripts/verify-json.js  # writes build/verify-input.json");
  console.log("  then BscScan > Contract > Verify & Publish > Solidity (Standard JSON Input)");
  console.log(`  contract: ${arenaAddr} (Arena) and ${badgeAddr} (ChampionBadge)`);
}

main().catch((e) => {
  console.error("DEPLOY FAILED:", e.message);
  process.exit(1);
});
