#!/usr/bin/env node
// Regenerate frontend/abi.js from build/ artifacts after recompiling.
// Usage: node scripts/compile.js && node scripts/gen-frontend-abi.js
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const arena = JSON.parse(fs.readFileSync(path.join(ROOT, "build", "Arena.json"), "utf8"));
const badge = JSON.parse(fs.readFileSync(path.join(ROOT, "build", "ChampionBadge.json"), "utf8"));
const agentIdAbi = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function balanceOf(address owner) view returns (uint256)",
];
const out =
  "/* Generated from build/ artifacts — DO NOT EDIT BY HAND.\n   Regenerate: node scripts/compile.js && node scripts/gen-frontend-abi.js */\n" +
  "const ARENA_ABI = " + JSON.stringify(arena.abi) + ";\n" +
  "const BADGE_ABI = " + JSON.stringify(badge.abi) + ";\n" +
  "const AGENT_ID_ABI = " + JSON.stringify(agentIdAbi) + ";\n";
fs.writeFileSync(path.join(ROOT, "frontend", "abi.js"), out);
console.log("frontend/abi.js written,", out.length, "bytes");
