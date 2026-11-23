/* AGENT ARENA — deployment config.
   Fill in ARENA_ADDRESS after deploying (see README.md).
   The Agent ID address below is the official contract on BNB Chain. */
const CONFIG = {
  // BNB Chain mainnet (chain id 56). Use 97 (BSC Testnet) for practice.
  CHAIN_ID: 56,
  CHAIN_NAME: "BNB Chain",
  // Public read-only RPC used when no wallet is connected.
  PUBLIC_RPC: "https://bsc-dataseed.binance.org/",
  BSCSCAN: "https://bscscan.com",
  // Official Agent ID contract (SPACE ID, ERC-721, symbol AI).
  AGENT_ID_ADDRESS: "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F",
  // TODO: paste the deployed Arena address here after `node scripts/deploy.js`.
  // The ChampionBadge is created by the Arena constructor; read it via arena.badge().
  ARENA_ADDRESS: "0x0000000000000000000000000000000000000000",
};
