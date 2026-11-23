/* AGENT ARENA frontend — static, no backend, no server-stored sessions.
   Reads the grid from a public BSC RPC. Writes go through the user's own
   injected wallet (Binance Wallet / MetaMask / any EIP-1193 provider).
   Every write asks the wallet for confirmation; nothing is auto-signed. */

const GRID = 16;
const COOLDOWN_S = 300;

let readProvider = null; // public RPC (read-only)
let arenaRead = null;
let agentIdRead = null;
let signer = null; // connected wallet
let arenaWrite = null;
let userAddress = null;
let myAgentId = null; // BigInt tokenId, verified on-chain
let myAgentName = null;
let currentEpoch = 0n;
let epochEnd = 0n;
let grid = []; // grid[y][x] = { owner: BigInt, hp: Number, lastActionAt: BigInt }
let selected = null; // {x, y}
const nameCache = new Map(); // tokenId string -> display name

const $ = (id) => document.getElementById(id);

function fmtTimeLeft(ms) {
  if (ms <= 0) return "epoch ended — settle it!";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${d}d ${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s left`;
}

function colorFor(agentId) {
  // Stable hue from the tokenId — same name, same color everywhere.
  let h = 0;
  const s = agentId.toString();
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h}, 75%, 55%)`;
}

function shortAddr(a) {
  return a ? a.slice(0, 6) + "…" + a.slice(-4) : "";
}

async function resolveName(agentId) {
  const key = agentId.toString();
  if (nameCache.has(key)) return nameCache.get(key);
  let display = "#" + key;
  try {
    const uri = await agentIdRead.tokenURI(agentId);
    const url = uri.startsWith("ipfs://")
      ? "https://ipfs.io/ipfs/" + uri.slice(7)
      : uri;
    const res = await fetch(url);
    const meta = await res.json();
    if (meta && typeof meta.name === "string" && meta.name.trim()) {
      display = meta.name.trim();
    }
  } catch (e) {
    // tokenURI / metadata unreachable — fall back to #tokenId.
  }
  nameCache.set(key, display);
  return display;
}

async function loadGrid() {
  if (!arenaRead) return;
  let results;
  try {
    const calls = [];
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        calls.push(arenaRead.getCell(currentEpoch, x, y));
      }
    }
    results = await Promise.all(calls);
  } catch (e) {
    // I-2 (audit 2026-11-23): a rate-limited / flaky public RPC used to
    // kill the 30s refresh silently (unhandled rejection in setInterval).
    // Keep the last good grid and show a transient failure state instead.
    $("gridStatus").textContent =
      "Grid refresh failed (RPC error) — showing last good data. Retrying in 30s.";
    return;
  }
  grid = [];
  let i = 0;
  for (let y = 0; y < GRID; y++) {
    const row = [];
    for (let x = 0; x < GRID; x++) {
      const [owner, hp, lastActionAt] = results[i++];
      row.push({ owner, hp: Number(hp), lastActionAt });
    }
    grid.push(row);
  }
  drawGrid();
  renderLeaderboard();
  $("gridStatus").textContent = `Epoch ${currentEpoch} — ${countClaimed()} of 256 cells claimed.`;
  if (selected) renderCellPanel();
}

function countClaimed() {
  let n = 0;
  for (const row of grid) for (const c of row) if (c.owner !== 0n) n++;
  return n;
}

function drawGrid() {
  const canvas = $("grid");
  const ctx = canvas.getContext("2d");
  const cell = canvas.width / GRID;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const c = grid[y][x];
      if (c.owner === 0n) {
        ctx.fillStyle = "#1c2433";
      } else {
        ctx.fillStyle = colorFor(c.owner);
        ctx.globalAlpha = 0.45 + (c.hp / 3) * 0.55;
      }
      ctx.fillRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
      ctx.globalAlpha = 1;
      // HP pips
      if (c.owner !== 0n) {
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        for (let p = 0; p < c.hp; p++) {
          ctx.fillRect(x * cell + 4 + p * 6, y * cell + cell - 8, 4, 4);
        }
      }
      if (selected && selected.x === x && selected.y === y) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 3;
        ctx.strokeRect(x * cell + 2, y * cell + 2, cell - 4, cell - 4);
      }
    }
  }
}

async function renderLeaderboard() {
  const counts = new Map();
  for (const row of grid) {
    for (const c of row) {
      if (c.owner !== 0n) counts.set(c.owner, (counts.get(c.owner) || 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const ol = $("leaderboard");
  ol.innerHTML = "";
  if (!sorted.length) {
    ol.innerHTML = "<li>No cells claimed yet this epoch.</li>";
    return;
  }
  for (const [agentId, count] of sorted) {
    const name = await resolveName(agentId);
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = colorFor(agentId);
    li.appendChild(dot);
    li.appendChild(document.createTextNode(` ${name} — ${count} cell${count > 1 ? "s" : ""}`));
    ol.appendChild(li);
  }
}

function isAdjacentToMine(x, y) {
  if (myAgentId === null) return false;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dy] of dirs) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
    if (grid[ny][nx].owner === myAgentId) return true;
  }
  return false;
}

function cooldownLeft(cell) {
  const now = Math.floor(Date.now() / 1000);
  const until = Number(cell.lastActionAt) + COOLDOWN_S;
  return Math.max(0, until - now);
}

async function renderCellPanel() {
  const { x, y } = selected;
  const cell = grid[y][x];
  const info = $("cellInfo");
  const actions = $("cellActions");
  const hint = $("actionHint");
  const now = Math.floor(Date.now() / 1000);
  const epochOver = now >= Number(epochEnd);

  // L-2 (audit 2026-11-23): build the panel with textContent / DOM nodes,
  // never innerHTML — `name` comes from token metadata and must never be
  // parsed as HTML.
  info.textContent = "";
  const title = document.createElement("b");
  title.textContent = `Cell (${x}, ${y})`;
  info.appendChild(title);
  info.appendChild(document.createElement("br"));
  if (cell.owner === 0n) {
    info.appendChild(document.createTextNode("Unclaimed."));
    info.appendChild(document.createElement("br"));
    info.appendChild(document.createTextNode("HP: —"));
  } else {
    const name = await resolveName(cell.owner);
    info.appendChild(document.createTextNode("Owner: "));
    const nameEl = document.createElement("b");
    nameEl.textContent = name;
    info.appendChild(nameEl);
    info.appendChild(document.createElement("br"));
    info.appendChild(
      document.createTextNode(
        `HP: ${"♥".repeat(cell.hp)}${"♡".repeat(3 - cell.hp)} (${cell.hp}/3)`
      )
    );
    const cd = cooldownLeft(cell);
    if (cd > 0) {
      info.appendChild(document.createElement("br"));
      info.appendChild(
        document.createTextNode(`Cooldown: ${Math.floor(cd / 60)}m ${cd % 60}s`)
      );
    }
  }
  actions.classList.remove("hidden");

  const claimBtn = $("claimBtn");
  const raidBtn = $("raidBtn");
  const reinforceBtn = $("reinforceBtn");
  claimBtn.disabled = raidBtn.disabled = reinforceBtn.disabled = true;
  hint.textContent = "";

  if (!signer) {
    hint.textContent = "Connect your wallet to play.";
    return;
  }
  if (myAgentId === null) {
    hint.textContent = "Enter your Agent ID tokenId above first.";
    return;
  }
  if (epochOver) {
    hint.textContent = "Epoch ended — settle it to start the next one.";
    return;
  }
  if (cell.owner === 0n) {
    const claimed = await arenaRead.hasClaimed(currentEpoch, myAgentId);
    if (claimed) {
      hint.textContent = "You already used your one free claim this epoch. Win more cells by raiding.";
    } else {
      claimBtn.disabled = false;
    }
  } else if (cell.owner === myAgentId) {
    if (cell.hp >= 3) {
      hint.textContent = "Already at full HP.";
    } else if (cooldownLeft(cell) > 0) {
      hint.textContent = `Cooling down — ${cooldownLeft(cell)}s left.`;
    } else {
      reinforceBtn.disabled = false;
    }
  } else {
    if (!isAdjacentToMine(x, y)) {
      hint.textContent = "Raid needs one of your cells next to this one.";
    } else if (cooldownLeft(cell) > 0) {
      hint.textContent = `Target cooling down — ${cooldownLeft(cell)}s left.`;
    } else {
      raidBtn.disabled = false;
      hint.textContent = "Damage 1, 25% crit for 2. If it hits 0 HP, the cell flips to you with 1 HP.";
    }
  }
}

async function sendTx(promise, label) {
  const status = $("txStatus");
  try {
    status.textContent = `${label} — waiting for wallet confirmation…`;
    const tx = await promise;
    status.innerHTML = `${label} sent: <a target="_blank" href="${CONFIG.BSCSCAN}/tx/${tx.hash}">${shortAddr(tx.hash)}</a> — waiting for confirmation…`;
    await tx.wait();
    status.textContent = `${label} confirmed! Reloading grid…`;
    await loadGrid();
  } catch (e) {
    status.textContent = `${label} failed: ${(e.reason || e.message || e).toString().slice(0, 160)}`;
  }
}

async function refreshEpoch() {
  const [start, end, settled, winner] = await arenaRead.epochInfo(currentEpoch);
  epochEnd = end;
  $("epochLabel").textContent = `Epoch ${currentEpoch}${settled ? ` — settled, winner: ${winner === 0n ? "none" : await resolveName(winner)}` : ""}`;
  const ms = Number(end) * 1000 - Date.now();
  $("epochTimer").textContent = fmtTimeLeft(ms);
  $("settleBtn").classList.toggle("hidden", ms > 0);
}

async function init() {
  if (typeof ethers === "undefined") {
    $("gridStatus").textContent = "Failed to load ethers.js (vendor/ethers.umd.min.js) — check the file exists and reload.";
    return;
  }
  readProvider = new ethers.JsonRpcProvider(CONFIG.PUBLIC_RPC);
  if (CONFIG.ARENA_ADDRESS === "0x0000000000000000000000000000000000000000") {
    $("deployNotice").classList.remove("hidden");
    $("gridStatus").textContent = "Arena contract not deployed yet.";
    return;
  }
  arenaRead = new ethers.Contract(CONFIG.ARENA_ADDRESS, ARENA_ABI, readProvider);
  agentIdRead = new ethers.Contract(CONFIG.AGENT_ID_ADDRESS, AGENT_ID_ABI, readProvider);
  currentEpoch = await arenaRead.currentEpoch();
  $("contractLinks").innerHTML =
    `Arena: <a target="_blank" href="${CONFIG.BSCSCAN}/address/${CONFIG.ARENA_ADDRESS}">${shortAddr(CONFIG.ARENA_ADDRESS)}</a>`;

  await loadGrid();
  await refreshEpoch();
  setInterval(refreshEpoch, 1000);
  setInterval(loadGrid, 30000); // refresh grid every 30s

  $("grid").addEventListener("click", (ev) => {
    const rect = ev.target.getBoundingClientRect();
    const x = Math.floor(((ev.clientX - rect.left) / rect.width) * GRID);
    const y = Math.floor(((ev.clientY - rect.top) / rect.height) * GRID);
    if (x >= 0 && y >= 0 && x < GRID && y < GRID) {
      selected = { x, y };
      drawGrid();
      renderCellPanel();
    }
  });

  $("connectBtn").addEventListener("click", async () => {
    if (!window.ethereum) {
      $("walletStatus").textContent = "No injected wallet found — install Binance Wallet or MetaMask.";
      return;
    }
    try {
      const browserProvider = new ethers.BrowserProvider(window.ethereum);
      await browserProvider.send("eth_requestAccounts", []);
      const network = await browserProvider.getNetwork();
      if (Number(network.chainId) !== CONFIG.CHAIN_ID) {
        $("walletStatus").textContent = `Wrong network — switch your wallet to ${CONFIG.CHAIN_NAME} (chain ${CONFIG.CHAIN_ID}).`;
        return;
      }
      signer = await browserProvider.getSigner();
      userAddress = await signer.getAddress();
      arenaWrite = new ethers.Contract(CONFIG.ARENA_ADDRESS, ARENA_ABI, signer);
      $("walletStatus").textContent = `Connected: ${shortAddr(userAddress)}`;
      $("connectBtn").textContent = "Connected";
      $("agentIdRow").classList.remove("hidden");
      const saved = localStorage.getItem("agentArenaAgentId");
      if (saved) {
        $("agentIdInput").value = saved;
        verifyAgentId(saved);
      }
      if (selected) renderCellPanel();
    } catch (e) {
      $("walletStatus").textContent = "Connection failed: " + (e.message || e).toString().slice(0, 120);
    }
  });

  $("useAgentIdBtn").addEventListener("click", () => {
    verifyAgentId($("agentIdInput").value.trim());
  });

  $("claimBtn").addEventListener("click", () => {
    if (!selected || myAgentId === null) return;
    sendTx(arenaWrite.claimCell(selected.x, selected.y, myAgentId), "Claim");
  });
  $("raidBtn").addEventListener("click", () => {
    if (!selected || myAgentId === null) return;
    sendTx(arenaWrite.raid(selected.x, selected.y, myAgentId), "Raid");
  });
  $("reinforceBtn").addEventListener("click", () => {
    if (!selected || myAgentId === null) return;
    sendTx(arenaWrite.reinforce(selected.x, selected.y, myAgentId), "Reinforce");
  });
  $("settleBtn").addEventListener("click", () => {
    sendTx(arenaWrite.settleEpoch(), "Settle epoch");
  });
}

async function verifyAgentId(value) {
  const status = $("agentIdStatus");
  // L-3 (audit 2026-11-23): validate before converting — BigInt("abc")
  // used to throw outside the try block (unhandled promise rejection, no
  // status update). Non-numeric input now shows a clear message instead.
  const trimmed = (value || "").trim();
  if (!/^\d+$/.test(trimmed)) {
    status.textContent = "Enter a tokenId (digits only).";
    myAgentId = null;
    return;
  }
  const id = BigInt(trimmed);
  if (id === 0n) {
    status.textContent = "Enter a tokenId.";
    return;
  }
  try {
    const owner = await agentIdRead.ownerOf(id);
    if (owner.toLowerCase() !== userAddress.toLowerCase()) {
      status.textContent = `Token #${id} belongs to ${shortAddr(owner)}, not you.`;
      myAgentId = null;
      return;
    }
    myAgentId = id;
    myAgentName = await resolveName(id);
    localStorage.setItem("agentArenaAgentId", id.toString());
    status.textContent = `Verified — you are ${myAgentName}.`;
    if (selected) renderCellPanel();
  } catch (e) {
    status.textContent = "Could not verify that tokenId — does it exist?";
    myAgentId = null;
  }
}

init();
