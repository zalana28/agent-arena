#!/usr/bin/env node
// Compile Arena.sol + ChampionBadge.sol (+ test mocks) with solc-js.
// Resolves @openzeppelin imports from node_modules and relative imports.
// Usage: node scripts/compile.js [--mock]
// Output: build/Arena.json, build/ChampionBadge.json (+ MockAgentID.json
// and ReentrantReceiver.json with --mock)
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const ROOT = path.resolve(__dirname, "..");
const BUILD = path.join(ROOT, "build");

function findImports(importPath) {
  try {
    let full;
    if (importPath.startsWith("@openzeppelin/")) {
      full = path.join(ROOT, "node_modules", importPath);
    } else if (importPath.startsWith(".") || !importPath.startsWith("@")) {
      // Relative imports (solc may strip the leading "./") resolve against
      // contracts/ first, then contracts/test/.
      const candidates = [
        path.join(ROOT, "contracts", importPath),
        path.join(ROOT, "contracts", "test", importPath),
      ];
      full = candidates.find((c) => fs.existsSync(c));
      if (!full) throw new Error("not found: " + importPath);
    } else {
      full = path.join(ROOT, "node_modules", importPath);
    }
    return { contents: fs.readFileSync(full, "utf8") };
  } catch (e) {
    return { error: "Import not found: " + importPath };
  }
}

function compileOne(file) {
  const source = fs.readFileSync(path.join(ROOT, "contracts", file), "utf8");
  const input = {
    language: "Solidity",
    sources: { [file]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Paris (pre-Shanghai): no PUSH0 opcode, so the bytecode also runs on
      // older EVMs / local test chains whose default hardfork predates it.
      evmVersion: "paris",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  const warnings = (out.errors || []).filter((e) => e.severity === "warning");
  for (const w of warnings) console.warn("WARN:", w.formattedMessage.split("\n")[0]);
  if (errors.length) {
    for (const e of errors) console.error(e.formattedMessage);
    throw new Error("Compilation failed for " + file);
  }
  return out.contracts[file];
}

function main() {
  const withMock = process.argv.includes("--mock");
  fs.mkdirSync(BUILD, { recursive: true });
  const files = ["Arena.sol", "ChampionBadge.sol"];
  if (withMock) files.push("test/MockAgentID.sol", "test/ReentrantReceiver.sol");
  for (const f of files) {
    const contracts = compileOne(f);
    for (const [name, c] of Object.entries(contracts)) {
      const artifact = {
        contractName: name,
        abi: c.abi,
        bytecode: "0x" + c.evm.bytecode.object,
        deployedBytecode: "0x" + c.evm.deployedBytecode.object,
      };
      fs.writeFileSync(path.join(BUILD, name + ".json"), JSON.stringify(artifact, null, 2));
      console.log(`compiled ${name}: bytecode ${(c.evm.bytecode.object.length / 2) | 0} bytes`);
    }
  }
  console.log("OK: artifacts in build/");
}

main();
