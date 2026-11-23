# AGENT ARENA

A 16×16 on-chain territory map for Agent ID holders on BNB Chain.
Claim a cell, raid your neighbours, hold the most territory when the
3-day epoch ends — and win a soulbound Champion Badge.

**No real-money stakes. No pot. Points and badges only.**
Every move costs only the player's own BSC gas (~$0.01–0.03).
Nothing here promises returns.

Built for the Agent ID Hackathon (Binance Wallet × BNB Chain).
Full design: [`../ARENA-DESIGN.md`](../ARENA-DESIGN.md).

## How to play

- **Claim** — one free cell per Agent ID per epoch. New cells start at 3 HP.
- **Raid** — attack a cell adjacent (Manhattan distance 1) to one of yours.
  Damage 1, 25% crit for 2. At 0 HP the cell flips to you with 1 HP.
- **Reinforce** — your own cell: +1 HP, max 3.
- **Cooldown** — 5 minutes per cell after a raid or reinforce.
- **Epochs** — 3 days. The grid resets; the Agent ID with the most cells
  wins a soulbound Champion Badge (minted to the Agent ID owner's wallet).
- **Identity** — every action verifies `ownerOf(agentId) == msg.sender`
  on the Agent ID contract. The map shows `.ai` names, not `0x` addresses.

## Project layout

```
contracts/
  Arena.sol            # the game (grid, claim/raid/reinforce, epochs)
  ChampionBadge.sol    # soulbound ERC-721, mintable only by Arena
  test/MockAgentID.sol # test-only mock Agent ID (NEVER deploy to mainnet)
  test/ReentrantReceiver.sol # test-only malicious badge recipient (reentrancy test)
scripts/
  compile.js           # solc-js compile (optimizer 200, EVM Paris)
  gen-frontend-abi.js  # regenerate frontend/abi.js from build/
  deploy.js            # deploy to BNB Chain (env: BSC_RPC_URL, DEPLOYER_KEY)
  verify-json.js       # Standard JSON inputs for BscScan verification
test/
  arena.test.js        # 37 tests on ganache (node test/arena.test.js)
frontend/
  index.html app.js style.css config.js abi.js   # static site, no backend
  vendor/ethers.umd.min.js  # vendored ethers 6.13.4 (no CDN dependency)
build/                 # compiler artifacts (generated)
```

## Build & test

```bash
npm install
npm run compile        # node scripts/compile.js --mock  (includes MockAgentID)
npm test               # 37 tests, ganache in-process — expect 37 passed, 0 failed
```

Toolchain: `solc` 0.8.28 (solc-js), OpenZeppelin Contracts 5.4,
ethers 6.13, ganache 7.9. No Foundry/Hardhat needed.

## Deploy (BNB Chain mainnet)

Prerequisite: the deployer wallet holds ~0.01 BNB for gas
(measured deploy cost below; 0.01 BNB covers it ~3× over at the typical
~1 gwei BSC gas price, and just barely at 3 gwei — check the live gas
price before deploying).

```bash
# 1. Compile (without the test mock — it is not part of the deploy)
node scripts/compile.js

# 2. Deploy. DEPLOYER_KEY is read from the environment only — never commit it.
BSC_RPC_URL=https://bsc-dataseed.binance.org \
DEPLOYER_KEY=0xYOUR_PRIVATE_KEY \
node scripts/deploy.js
# Prints: Arena address, ChampionBadge address, exact gas + BNB paid.
# Also writes the Arena address into frontend/config.js automatically.

# 3. Verify both contracts on BscScan (Standard JSON Input method)
node scripts/verify-json.js
# BscScan > Contract > Verify & Publish > "Solidity (Standard JSON Input)"
#   - Arena:  paste build/verify-input-Arena.json, compiler 0.8.28,
#             optimization ON, runs 200, EVM Paris
#   - ChampionBadge: paste build/verify-input-ChampionBadge.json, same settings
# The script already checks the JSON compiles to the exact deployed bytecode.

# 4. Host the frontend (static files only, e.g. GitHub Pages)
#    frontend/ needs no build step. Open index.html and connect a wallet.
```

To practise on BSC Testnet (chain 97) instead, deploy a MockAgentID
first and pass `--agent-id <mock address> --chain-id 97` to `deploy.js`
(the real Agent ID contract lives on mainnet only).

## Gas — measured on ganache (gas units)

| Action | Gas |
|---|---|
| Deploy Arena (creates ChampionBadge) | 3,000,909 |
| `claimCell` (first claim, cold storage) | 215,767 |
| `raid` (no flip) | 56,794 |
| `raid` (cell flips) | ~65,020 |
| `reinforce` | 49,831 |
| `settleEpoch` (4 participants) | 225,085 |

BNB cost at a given gas price (1 BNB ≈ $600 at time of writing):

| Gas price | Deploy | One raid |
|---|---|---|
| 0.1 gwei | 0.00030 BNB | 0.0000057 BNB (~$0.003) |
| 1 gwei | 0.0030 BNB | 0.000057 BNB (~$0.03) |
| 3 gwei | 0.0090 BNB | 0.00017 BNB (~$0.10) |

BSC gas prices vary; check the current price before deploying.
A 0.01 BNB top-up covers deployment with wide margin at any of these.

## Owner permissions (documented for the judges)

The Arena contract has exactly two privileged items:

1. **Owner address** (the deployer, via OpenZeppelin `Ownable2Step`,
   audit L-5): the owner's powers are `setPaused(true/false)` — an
   emergency brake on claim/raid/reinforce — and ownership transfer
   itself. `settleEpoch` stays callable while paused so epochs can
   always advance. The owner cannot move cells, mint badges, change
   rules, or touch funds (there are none). Ownership transfer is
   two-step (`transferOwnership` + `acceptOwnership` by the new owner), so
   a mistyped address cannot lock the pause key. Key plan: the deployer
   holds the key in the Binance Wallet used for deploy; if the key is ever
   lost after a pause, gameplay stays paused but epochs still advance
   (settlement is permissionless) — the only recovery is a fresh deploy.
2. **Agent ID contract address** (immutable, set in the constructor):
   `0x60B9262456de011f7d15a54cdd8c48baaa8b022f` on mainnet.
   It is only ever *read* (`ownerOf`) to verify the player holds the
   Agent ID they claim to play with.

The ChampionBadge contract has one privileged item: `mint` is callable
only by the Arena contract. Transfers are blocked for everyone
(soulbound).

## Red-line compliance checklist (hackathon §9)

- [x] **No money at stake** — territory + badges only; no pot, no stakes,
      no entry fee, no payouts. The contracts hold no BNB and have no
      payable functions.
- [x] **No web QR login / pairing codes** — the site uses only an injected
      wallet (Binance Wallet / MetaMask). No QR, no pairing, no sessions.
- [x] **User confirms every action** — every write is a normal wallet
      transaction the user signs in their own wallet. Nothing auto-signs.
- [x] **No unauthorized transfers, no unlimited approvals** — the game
      never moves tokens and never asks for any approval.
- [x] **Contracts open-source, permissions documented** — see above; both
      contracts are verified on BscScan after deploy.
- [x] **Project name uses no "Binance"/"BNB"** — the name is AGENT ARENA.
- [x] **No promised returns / passive income** — stated in the UI banner,
      the rules, and this README.
- [x] **Agent ID is not a wallet-lookup tool** — names appear only for
      players who opted in by claiming a cell, and only inside the game.

## Design notes & deviations from ARENA-DESIGN.md

- **`myAgentId(address)` is `isAgentOwner(agentId, account)` instead.**
  The Agent ID contract has no `tokenOfOwnerByIndex` (verified on-chain),
  so no contract can list an address's Agent IDs. The frontend asks the
  player for their tokenId once and verifies `ownerOf` on-chain.
- **One epoch advances per `settleEpoch` call.** If settlement is late,
  call it again for the next epoch. Epochs never auto-advance on their own.
- **Crit randomness** uses `keccak256(attacker, defender, blockhash(block-1))`.
  It decides only points (1 vs 2 damage) — manipulating a blockhash wins
  nothing of economic value.
- **Crit timing is a KNOWN, ACCEPTED game mechanic (audit M-1, 2026-11-23):**
  the roll is deterministic — all three inputs are public before the
  transaction is sent, so a patient raider can compute the roll off-chain
  and only submit the raid when it crits (effectively ~100% crits instead
  of 25% for anyone who bothers). The edge is bounded: the 5-minute
  per-cell cooldown limits the advantage to ~2× faster flips (a 3-HP cell
  falls in 2 raids instead of 3), never an instant win; and only points
  are at stake, no money. A two-step commit-reveal was deliberately NOT
  used (2 transactions per raid = worse play experience + double gas).
  This is documented game behavior, not a bug.
- **Ties** in `settleEpoch` go to the participant who interacted first.
- **Frontend name resolution** reads the Agent ID `tokenURI` metadata.
  If metadata is unreachable it falls back to `#tokenId`.

## Known limitations

- **Crit timing (accepted, see above):** a patient raider can time raids
  to crit nearly every time; the 5-minute cooldown caps the edge at ~2×
  faster flips, points only.
- The frontend needs `ARENA_ADDRESS` set in `frontend/config.js`
  (filled automatically by `scripts/deploy.js`).
- Players must know their Agent ID tokenId (shown in Binance Wallet /
  on the BscScan token page) — there is no on-chain enumeration.
- `settleEpoch` must be called by someone after each epoch ends
  (permissionless — anyone, including the frontend's Settle button).
- EVM target is Paris (not Cancun): OpenZeppelin 5.4's Cancun-only
  helpers are not in the import graph, and Paris bytecode runs on every
  EVM including the local ganache used for tests (whose default hardfork
  predates Shanghai — Cancun bytecode's `PUSH0` reverts there).

## License

MIT. See `LICENSE` (to be added with the repo).
