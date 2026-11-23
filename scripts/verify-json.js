#!/usr/bin/env node
// Build the Standard JSON input for BscScan contract verification.
// Usage: node scripts/compile.js && node scripts/verify-json.js
// Output: build/verify-input-Arena.json, build/verify-input-ChampionBadge.json
// On BscScan: Contract > Verify & Publish > Compiler Type "Solidity
// (Standard JSON Input)" > paste the matching file > compiler 0.8.28,
// optimization ON, runs 200, EVM Paris.
// Only the sources actually imported are included (OpenZeppelin 5.4 ships
// some Cancun-only files that fail under evmVersion paris if included).
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const ROOT = path.resolve(__dirname, "..");

function readSource(key) {
  // key is the source-unit path as solc sees it.
  let full;
  if (key.startsWith("@openzeppelin/")) {
    full = path.join(ROOT, "node_modules", key);
  } else {
    full = path.join(ROOT, "contracts", key);
  }
  return fs.readFileSync(full, "utf8");
}

function resolveImport(fromKey, importPath) {
  if (importPath.startsWith("@")) return importPath;
  // Relative: resolve against the importing file's directory.
  const dir = path.posix.dirname(fromKey);
  const joined = path.posix.join(dir, importPath);
  // solc strips leading "./"
  return joined.replace(/^\.\//, "");
}

function collectSources(entryKey) {
  const sources = {};
  const queue = [entryKey];
  while (queue.length) {
    const key = queue.shift();
    if (sources[key]) continue;
    const content = readSource(key);
    sources[key] = { content };
    const re = /import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const resolved = resolveImport(key, m[1]);
      if (!sources[resolved]) queue.push(resolved);
    }
  }
  return sources;
}

function buildInput(entryFile) {
  return {
    language: "Solidity",
    sources: collectSources(entryFile),
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } },
    },
  };
}

function main() {
  const outDir = path.join(ROOT, "build");
  fs.mkdirSync(outDir, { recursive: true });
  for (const [contract, file] of [
    ["Arena", "Arena.sol"],
    ["ChampionBadge", "ChampionBadge.sol"],
  ]) {
    const input = buildInput(file);
    const compiled = JSON.parse(solc.compile(JSON.stringify(input)));
    const errors = (compiled.errors || []).filter((e) => e.severity === "error");
    if (errors.length) {
      console.error(errors.map((e) => e.formattedMessage).join("\n"));
      throw new Error("Verification input does not compile for " + contract);
    }
    const artifact = JSON.parse(
      fs.readFileSync(path.join(outDir, contract + ".json"), "utf8")
    );
    const got = compiled.contracts[file][contract].evm.bytecode.object;
    const want = artifact.bytecode.slice(2);
    if (got !== want) {
      throw new Error(
        `Bytecode mismatch for ${contract} — recompile first (node scripts/compile.js)`
      );
    }
    fs.writeFileSync(
      path.join(outDir, `verify-input-${contract}.json`),
      JSON.stringify(input, null, 2)
    );
    console.log(`build/verify-input-${contract}.json OK (bytecode matches build/)`);
  }
}

main();
