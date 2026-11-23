#!/usr/bin/env node
// AGENT ARENA test suite — runs against an in-process ganache chain.
// Usage: node test/arena.test.js
// Exit code 0 = all pass.
//
// NOTE: ganache mines blocks seconds apart, so a cell claimed in one block
// is still inside its 5-minute cooldown in the next block. The suite
// advances chain time (+301s) wherever a follow-up action on a fresh cell
// is meant to succeed. This mirrors real BSC usage (blocks 3s apart,
// humans act minutes apart).
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const BUILD = path.join(__dirname, "..", "build");
const load = (name) => JSON.parse(fs.readFileSync(path.join(BUILD, name + ".json"), "utf8"));

let passed = 0;
let failed = 0;
const gas = {};
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String(e.message).split("\n")[0]}`);
  }
}
// Expect a call to revert with `substr`. Probed via staticCall, which
// returns the decoded revert reason reliably (estimateGas errors do not).
async function reverts(method, args, substr) {
  try {
    await method.staticCall(...args);
  } catch (e) {
    const msg = e.reason || String(e.message || e);
    assert.ok(msg.includes(substr), `expected revert "${substr}", got: ${msg.slice(0, 200)}`);
    return;
  }
  assert.fail(`expected revert "${substr}" but call succeeded`);
}
async function increaseTime(provider, seconds) {
  await provider.send("evm_increaseTime", [seconds]);
  await provider.send("evm_mine", []);
}

async function main() {
  const server = ganache.server({ logging: { quiet: true } });
  await server.listen(8545);
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
  const [deployer, alice, bob, carol] = await Promise.all(
    [0, 1, 2, 3].map((i) => provider.getSigner(i))
  );
  const [deployerAddr, aliceAddr, bobAddr, carolAddr] = await Promise.all(
    [deployer, alice, bob, carol].map((s) => s.getAddress())
  );

  // Deploy MockAgentID, mint ids: 1->alice, 2->bob, 3->alice, 4->carol
  const mockArt = load("MockAgentID");
  const mock = await new ethers.ContractFactory(mockArt.abi, mockArt.bytecode, deployer).deploy();
  await mock.waitForDeployment();
  await (await mock.mint(aliceAddr)).wait();
  await (await mock.mint(bobAddr)).wait();
  await (await mock.mint(aliceAddr)).wait();
  await (await mock.mint(carolAddr)).wait();

  const arenaArt = load("Arena");
  const arena = await new ethers.ContractFactory(arenaArt.abi, arenaArt.bytecode, deployer).deploy(
    await mock.getAddress()
  );
  const deployReceipt = await arena.deploymentTransaction().wait();
  gas.deployArena = Number(deployReceipt.gasUsed);
  await arena.waitForDeployment();

  const badgeArt = load("ChampionBadge");
  const badge = new ethers.Contract(await arena.badge(), badgeArt.abi, provider);

  console.log("== claim ==");
  await test("claim: happy path, new cell HP 3, count 1", async () => {
    const tx = await arena.connect(alice).claimCell(5, 5, 1);
    const r = await tx.wait();
    gas.claim = Number(r.gasUsed);
    const [ownerId, hp] = await arena.getCell(0, 5, 5);
    assert.equal(ownerId, 1n);
    assert.equal(hp, 3n);
    assert.equal(await arena.cellsOwnedOf(0, 1), 1n);
    assert.equal(await arena.hasClaimed(0, 1), true);
  });
  await test("claim: non-holder rejected", async () => {
    await reverts(arena.connect(bob).claimCell, [6, 6, 1], "not Agent ID holder");
  });
  await test("claim: double claim with same Agent ID rejected", async () => {
    await reverts(arena.connect(alice).claimCell, [6, 6, 1], "already claimed");
  });
  await test("claim: taken cell rejected", async () => {
    await reverts(arena.connect(bob).claimCell, [5, 5, 2], "cell taken");
  });
  await test("claim: out of grid rejected", async () => {
    await reverts(arena.connect(bob).claimCell, [16, 0, 2], "out of grid");
  });
  await test("claim: second Agent ID of same wallet can claim", async () => {
    await arena.connect(alice).claimCell(0, 0, 3);
    assert.equal(await arena.cellsOwnedOf(0, 3), 1n);
  });
  await test("claim: bob claims (0,1)", async () => {
    await arena.connect(bob).claimCell(0, 1, 2);
    assert.equal(await arena.cellsOwnedOf(0, 2), 1n);
  });

  console.log("== raid ==");
  // Move past the 5-min cooldown set by the claims above.
  await increaseTime(provider, 320);
  await test("raid: unclaimed cell rejected", async () => {
    await reverts(arena.connect(bob).raid, [10, 10, 2], "cell unclaimed");
  });
  await test("raid: own cell rejected", async () => {
    await reverts(arena.connect(bob).raid, [0, 1, 2], "own cell");
  });
  await test("raid: non-adjacent target rejected", async () => {
    await reverts(arena.connect(bob).raid, [5, 5, 2], "not adjacent");
  });
  await test("raid: happy path, damage 1 or 2 (crit), HP drops", async () => {
    // bob's (0,1) is adjacent to alice's (0,0) — alice raids it
    const tx = await arena.connect(alice).raid(0, 1, 3, { gasLimit: 300_000 });
    const r = await tx.wait();
    gas.raid = Number(r.gasUsed);
    const [ownerId, hp] = await arena.getCell(0, 0, 1);
    assert.equal(ownerId, 2n); // not flipped yet (HP 3 - max 2 = 1)
    assert.ok(hp === 1n || hp === 2n, `hp should be 1 or 2, got ${hp}`);
  });
  await test("raid: cooldown enforced on same cell", async () => {
    await reverts(arena.connect(alice).raid, [0, 1, 3], "cell on cooldown");
  });
  await test("reinforce: cooldown enforced after raid", async () => {
    await reverts(arena.connect(bob).reinforce, [0, 1, 2], "cell on cooldown");
  });
  // NOTE (2026-11-23, flake root cause): raid gas depends on the crit roll,
  // which depends on blockhash(block.number - 1). ethers estimates gas against
  // the pending block, but this ganache build mines an extra block between
  // estimation and send, so the roll (and branch: damage-only ~57k vs flip
  // ~65-70k) can differ — the tx then runs out of gas on the exact estimate
  // and the whole raid/reinforce/settle cluster fails. An explicit 300k
  // gasLimit removes the flake. The CONTRACT is correct (hp <= damage flips,
  // else subtracts); on mainnet estimation and mining share the same parent
  // block, so wallets do not hit this.
  await test("raid: cell flips to attacker at HP 0 with HP 1", async () => {
    // advance past cooldown, raid until flip
    let flipped = false;
    for (let i = 0; i < 4 && !flipped; i++) {
      await increaseTime(provider, 5 * 60 + 20);
      const tx = await arena.connect(alice).raid(0, 1, 3, { gasLimit: 300_000 });
      await tx.wait();
      const [ownerId, hp] = await arena.getCell(0, 0, 1);
      if (ownerId === 3n) {
        flipped = true;
        assert.equal(hp, 1n);
      }
    }
    assert.ok(flipped, "cell should have flipped within 4 raids");
    assert.equal(await arena.cellsOwnedOf(0, 3), 2n); // (0,0) + flipped (0,1)
    assert.equal(await arena.cellsOwnedOf(0, 2), 0n);
  });
  await test("reinforce: happy path restores 1 HP", async () => {
    await increaseTime(provider, 5 * 60 + 20);
    const tx = await arena.connect(alice).reinforce(0, 1, 3);
    const r = await tx.wait();
    gas.reinforce = Number(r.gasUsed);
    const [, hp] = await arena.getCell(0, 0, 1);
    assert.equal(hp, 2n);
  });
  await test("reinforce: not your cell rejected", async () => {
    await reverts(arena.connect(bob).reinforce, [0, 1, 2], "not your cell");
  });
  await test("reinforce: full HP rejected", async () => {
    await increaseTime(provider, 5 * 60 + 20);
    await arena.connect(alice).reinforce(0, 1, 3); // 2 -> 3
    const [, hp] = await arena.getCell(0, 0, 1);
    assert.equal(hp, 3n);
    await reverts(arena.connect(alice).reinforce, [0, 1, 3], "already full HP");
  });

  console.log("== pause / access control ==");
  await test("pause: only owner can pause; gameplay blocked while paused", async () => {
    // Ownable2Step reverts with the OZ custom error, not a string reason.
    await reverts(arena.connect(alice).setPaused, [true], "OwnableUnauthorizedAccount");
    await arena.connect(deployer).setPaused(true);
    assert.equal(await arena.paused(), true);
    await reverts(arena.connect(carol).claimCell, [9, 9, 4], "paused");
    await arena.connect(deployer).setPaused(false);
    await arena.connect(carol).claimCell(9, 9, 4); // works again
  });

  console.log("== epochs / settle ==");
  await test("settle: too early rejected", async () => {
    await reverts(arena.settleEpoch, [], "epoch not over");
  });
  await test("epoch: gameplay blocked after epoch end until settle", async () => {
    await increaseTime(provider, 3 * 24 * 60 * 60 + 1);
    await reverts(arena.connect(carol).claimCell, [9, 8, 4], "epoch ended");
  });
  await test("settle: winner = most cells, badge minted to winner owner", async () => {
    // Epoch 0 standings: id 1: 1 cell (5,5); id 3: 2 cells (0,0)+(0,1); id 4: 1 cell (9,9); id 2: 0
    const tx = await arena.connect(bob).settleEpoch(); // permissionless
    const r = await tx.wait();
    gas.settle = Number(r.gasUsed);
    assert.equal(await arena.epochWinner(0), 3n);
    assert.equal(await arena.currentEpoch(), 1n);
    assert.equal(await badge.balanceOf(aliceAddr), 1n);
    assert.equal(await badge.tokenEpoch(1), 0n);
    assert.equal(await badge.ownerOf(1), aliceAddr);
    // new epoch starts empty, old epoch stays readable
    const [ownerId] = await arena.getCell(1, 5, 5);
    assert.equal(ownerId, 0n);
    const [oldOwner] = await arena.getCell(0, 5, 5);
    assert.equal(oldOwner, 1n);
  });
  await test("badge: soulbound, transfers blocked", async () => {
    await reverts(
      badge.connect(alice).transferFrom,
      [aliceAddr, bobAddr, 1],
      "soulbound"
    );
  });
  await test("badge: direct mint blocked (Arena only)", async () => {
    await reverts(badge.connect(deployer).mint, [bobAddr, 99], "only Arena");
  });
  await test("badge: tokenURI is on-chain JSON with epoch", async () => {
    const uri = await badge.tokenURI(1);
    assert.ok(uri.startsWith("data:application/json;base64,"));
    const json = JSON.parse(
      Buffer.from(uri.replace("data:application/json;base64,", ""), "base64").toString("utf8")
    );
    assert.ok(json.name.includes("Epoch 0"), `name: ${json.name}`);
    assert.equal(json.attributes[0].value, 0);
  });
  await test("epoch 1: free claim resets, same Agent ID can claim again", async () => {
    await arena.connect(alice).claimCell(5, 5, 1);
    assert.equal(await arena.cellsOwnedOf(1, 1), 1n);
  });
  await test("settle: epoch with a winner, then empty epoch settles with no winner", async () => {
    // settle epoch 1 (alice id 1 has 1 cell -> wins again, badge #2)
    await increaseTime(provider, 3 * 24 * 60 * 60 + 1);
    await arena.settleEpoch();
    assert.equal(await arena.epochWinner(1), 1n);
    assert.equal(await badge.balanceOf(aliceAddr), 2n);
    // epoch 2: nobody plays
    await increaseTime(provider, 3 * 24 * 60 * 60 + 1);
    await arena.settleEpoch();
    assert.equal(await arena.epochWinner(2), 0n);
    assert.equal(await badge.balanceOf(aliceAddr), 2n); // no new badge
    assert.equal(await arena.currentEpoch(), 3n);
  });

  console.log("== audit coverage (2026-11-23) ==");
  // Fresh Arena for the scenario tests, same mock (ids 1-4 already minted).
  const arena2 = await new ethers.ContractFactory(arenaArt.abi, arenaArt.bytecode, deployer).deploy(
    await mock.getAddress()
  );
  await arena2.waitForDeployment();
  const badge2 = new ethers.Contract(await arena2.badge(), badgeArt.abi, provider);

  await test("raid: non-holder rejected", async () => {
    await reverts(arena2.connect(bob).raid, [0, 0, 1], "not Agent ID holder");
  });
  await test("reinforce: non-holder rejected", async () => {
    await reverts(arena2.connect(bob).reinforce, [0, 0, 1], "not Agent ID holder");
  });
  await test("raid: out of grid rejected", async () => {
    await reverts(arena2.connect(alice).raid, [16, 0, 1], "out of grid");
  });
  await test("reinforce: out of grid rejected", async () => {
    await reverts(arena2.connect(alice).reinforce, [0, 16, 1], "out of grid");
  });
  await test("claim: agentId 0 reverts (no such token)", async () => {
    // ownerOf(0) reverts with the OZ custom error ERC721NonexistentToken;
    // assert any revert rather than a specific reason string.
    let reverted = false;
    try {
      await arena2.connect(alice).claimCell.staticCall(0, 0, 0);
    } catch (e) {
      reverted = true;
    }
    assert.ok(reverted, "claimCell(agentId 0) should revert");
  });
  await test("crit: damage matches off-chain recomputation (M-1 determinism)", async () => {
    await arena2.connect(alice).claimCell(0, 0, 1);
    await arena2.connect(bob).claimCell(0, 1, 2);
    await increaseTime(provider, 320);
    const tx = await arena2.connect(alice).raid(0, 1, 1, { gasLimit: 300_000 });
    const r = await tx.wait();
    // The roll uses blockhash(block.number - 1) of the raid's block.
    const prevBlock = await provider.getBlock(r.blockNumber - 1);
    const roll =
      BigInt(
        ethers.keccak256(
          ethers.solidityPacked(
            ["uint256", "uint256", "bytes32"],
            [1n, 2n, prevBlock.hash]
          )
        )
      ) % 4n;
    const expectedDamage = roll === 0n ? 2n : 1n;
    const ev = r.logs
      .map((l) => {
        try {
          return arena2.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.name === "CellRaided");
    assert.ok(ev, "CellRaided event expected");
    assert.equal(ev.args.damage, expectedDamage, `damage ${ev.args.damage} != recomputed ${expectedDamage} (roll ${roll})`);
    assert.equal(ev.args.crit, expectedDamage === 2n);
  });
  await test("settle: tie goes to first interactor", async () => {
    // After the crit test: id 1 owns (0,0), id 2 owns (0,1) — 1 cell each.
    await increaseTime(provider, 3 * 24 * 60 * 60 + 1);
    await arena2.connect(bob).settleEpoch();
    assert.equal(await arena2.epochWinner(0), 1n);
    assert.equal(await arena2.currentEpoch(), 1n);
  });
  await test("settle: second settle call reverts", async () => {
    // The already-settled flag is unreachable via the public flow (settle
    // advances the epoch), so the second call reverts as "epoch not over".
    await reverts(arena2.settleEpoch, [], "epoch not over");
  });
  await test("settle: works while paused", async () => {
    await arena2.connect(deployer).setPaused(true);
    assert.equal(await arena2.paused(), true);
    await increaseTime(provider, 3 * 24 * 60 * 60 + 1); // epoch 1 ends, nobody played
    await arena2.connect(bob).settleEpoch(); // permissionless, pause must not block it
    assert.equal(await arena2.currentEpoch(), 2n);
    assert.equal(await arena2.epochWinner(1), 0n); // no badge for an empty epoch
    await arena2.connect(deployer).setPaused(false);
  });
  await test("settle: contract-owned winner settles, badge minted (H-1)", async () => {
    // Epoch 2 of arena2: carol (id 5) is the only player, then her address
    // gains code (bare contract, no onERC721Received) before settlement.
    // With _safeMint this would brick the game forever; with _mint it settles.
    await (await mock.mint(carolAddr)).wait(); // id 5 -> carol
    await arena2.connect(carol).claimCell(5, 5, 5);
    await provider.send("evm_setAccountCode", [carolAddr, "0x6000"]);
    await increaseTime(provider, 3 * 24 * 60 * 60 + 1);
    const tx = await arena2.connect(deployer).settleEpoch();
    const r = await tx.wait();
    assert.equal(await arena2.epochWinner(2), 5n);
    assert.equal(await arena2.currentEpoch(), 3n);
    assert.equal(await badge2.balanceOf(carolAddr), 1n);
    const badgeEv = r.logs
      .map((l) => {
        try {
          return badge2.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.name === "BadgeMinted");
    assert.ok(badgeEv, "BadgeMinted event expected");
    assert.equal(await badge2.ownerOf(badgeEv.args.tokenId), carolAddr);
    assert.equal(await badge2.tokenEpoch(badgeEv.args.tokenId), 2n);
  });
  await test("reentrancy: malicious badge recipient cannot corrupt state", async () => {
    // Fresh arena + a receiver whose onERC721Received tries to reenter
    // settleEpoch. With the _mint fix the hook is never invoked, so the
    // callback flag stays false and settlement succeeds with state intact.
    const arena3 = await new ethers.ContractFactory(arenaArt.abi, arenaArt.bytecode, deployer).deploy(
      await mock.getAddress()
    );
    await arena3.waitForDeployment();
    const badge3 = new ethers.Contract(await arena3.badge(), badgeArt.abi, provider);
    const recvArt = load("ReentrantReceiver");
    const receiver = await new ethers.ContractFactory(recvArt.abi, recvArt.bytecode, deployer).deploy(
      await arena3.getAddress()
    );
    await receiver.waitForDeployment();
    const receiverAddr = await receiver.getAddress();
    await (await mock.mint(receiverAddr)).wait(); // id 6 -> receiver
    await (await receiver.play(3, 3, 6)).wait(); // receiver claims as itself
    await increaseTime(provider, 3 * 24 * 60 * 60 + 1);
    await (await arena3.connect(deployer).settleEpoch()).wait();
    assert.equal(await arena3.epochWinner(0), 6n);
    assert.equal(await arena3.currentEpoch(), 1n);
    assert.equal(await receiver.callbackCalled(), false);
    assert.equal(await receiver.reenterSucceeded(), false);
    assert.equal(await badge3.balanceOf(receiverAddr), 1n);
  });

  console.log("\n== gas (ganache, 0 gwei — gas units only) ==");
  for (const [k, v] of Object.entries(gas)) console.log(`  ${k}: ${v.toLocaleString()} gas`);
  console.log(`\n${passed} passed, ${failed} failed`);
  await server.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
