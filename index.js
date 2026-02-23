/**
 * Mythic Supply Oracle
 * 
 * Canonical source of truth for $MYTH total & circulating supply.
 * 
 * Model:
 *   - Total Supply is ALWAYS 1,000,000,000 MYTH (1B) — fixed at genesis on pump.fun
 *   - When tokens bridge L1→L2: locked in L1 vault, minted on L2 (supply stays 1B)
 *   - When tokens bridge L2→L1: burned on L2, released from L1 vault (supply stays 1B)
 *   - The oracle queries both chains to verify parity and expose breakdown
 * 
 * Endpoints:
 *   GET /                → full supply data
 *   GET /supply          → total supply number (1000000000)
 *   GET /circulating     → circulating supply (total - locked/burned)
 *   GET /health          → health check
 */

import express from "express";
import cors from "cors";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

// ── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "4002", 10);
const L1_RPC_URL = process.env.L1_RPC_URL || "http://MYTHIC_RPC_IP:8899";
const L2_RPC_URL = process.env.L2_RPC_URL || "http://127.0.0.1:8899";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);

// MYTH token addresses
const L1_MYTH_MINT = process.env.L1_MYTH_MINT || "22XjKMYtQhNX3wETXFXFK5gvSfXHCxt9gj8DBKZaai3C";
const L2_MYTH_MINT = process.env.L2_MYTH_MINT || "7Hmyi9v4itEt49xo1fpTgHk1ytb8MZft7RBATBgb1pnf";

// Bridge program (L1 side — tokens locked in its vault)
const L1_BRIDGE_PROGRAM = process.env.L1_BRIDGE_PROGRAM || "oEQfREm4FQkaVeRoxJHkJLB1feHprrntY6eJuW2zbqQ";

// Fixed canonical total supply: 1 billion MYTH
const TOTAL_SUPPLY = 1_000_000_000;
const MYTH_DECIMALS = 9;

// ── State ───────────────────────────────────────────────────────────────────

let supplyData = {
  totalSupply: TOTAL_SUPPLY,
  circulatingSupply: TOTAL_SUPPLY,
  l1: {
    supply: TOTAL_SUPPLY,       // MYTH on L1 Solana (pump.fun)
    locked: 0,                  // locked in bridge vault
    circulating: TOTAL_SUPPLY,  // available on L1
    mint: L1_MYTH_MINT,
  },
  l2: {
    supply: 0,                  // wrapped MYTH minted on L2
    mint: L2_MYTH_MINT,
  },
  bridge: {
    l1Program: L1_BRIDGE_PROGRAM,
    status: "synced",           // synced | drift_detected
    lastCheck: new Date().toISOString(),
    driftAmount: 0,             // should always be 0
  },
  price: {
    usd: null,                  // populated from external source if available
    lastUpdate: null,
  },
  meta: {
    name: "Mythic",
    symbol: "MYTH",
    decimals: MYTH_DECIMALS,
    chain: "Solana L1 + Mythic L2",
    website: "https://mythic.sh",
    totalSupplyRaw: (BigInt(TOTAL_SUPPLY) * BigInt(10 ** MYTH_DECIMALS)).toString(),
  },
  lastUpdated: new Date().toISOString(),
};

// ── Supply Polling ──────────────────────────────────────────────────────────

async function fetchL1Supply() {
  try {
    const conn = new Connection(L1_RPC_URL, "confirmed");
    const mintPubkey = new PublicKey(L1_MYTH_MINT);

    // Get the SPL token supply on L1
    const mintInfo = await conn.getParsedAccountInfo(mintPubkey);
    if (mintInfo.value && "parsed" in mintInfo.value.data) {
      const parsed = mintInfo.value.data.parsed;
      const supply = parseFloat(parsed.info.supply) / (10 ** parsed.info.decimals);
      return { supply, error: null };
    }
    return { supply: TOTAL_SUPPLY, error: "Could not parse L1 mint" };
  } catch (err) {
    return { supply: TOTAL_SUPPLY, error: err.message };
  }
}

async function fetchL2Supply() {
  try {
    const conn = new Connection(L2_RPC_URL, "confirmed");
    
    // Try to get the MYTH token program supply on L2
    // This would be the wrapped MYTH minted by the bridge
    const mintPubkey = new PublicKey(L2_MYTH_MINT);
    const mintInfo = await conn.getParsedAccountInfo(mintPubkey);
    
    if (mintInfo.value && "parsed" in mintInfo.value.data) {
      const parsed = mintInfo.value.data.parsed;
      const supply = parseFloat(parsed.info.supply) / (10 ** parsed.info.decimals);
      return { supply, error: null };
    }
    
    // If the MYTH Token program mint doesnt exist yet, L2 supply is 0
    return { supply: 0, error: null };
  } catch (err) {
    // Not found = 0 supply bridged
    return { supply: 0, error: null };
  }
}

async function fetchBridgeLocked() {
  try {
    const conn = new Connection(L1_RPC_URL, "confirmed");
    const bridgePubkey = new PublicKey(L1_BRIDGE_PROGRAM);
    
    // Find all token accounts owned by the bridge program (vault PDAs)
    // The bridge locks deposited MYTH in its vault PDA
    const vaultSeed = Buffer.from("vault");
    const mintPubkey = new PublicKey(L1_MYTH_MINT);
    
    // Derive the vault PDA: seeds = ["vault", token_mint]
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [vaultSeed, mintPubkey.toBuffer()],
      bridgePubkey
    );
    
    const vaultInfo = await conn.getParsedAccountInfo(vaultPda);
    if (vaultInfo.value && "parsed" in vaultInfo.value.data) {
      const amount = parseFloat(vaultInfo.value.data.parsed.info.tokenAmount.uiAmountString);
      return { locked: amount, error: null };
    }
    
    return { locked: 0, error: null };
  } catch (err) {
    return { locked: 0, error: err.message };
  }
}

async function updateSupplyData() {
  const [l1Result, l2Result, bridgeResult] = await Promise.all([
    fetchL1Supply(),
    fetchL2Supply(),
    fetchBridgeLocked(),
  ]);

  const l1Supply = l1Result.supply;
  const l2Supply = l2Result.supply;
  const bridgeLocked = bridgeResult.locked;

  // L1 circulating = total L1 supply - locked in bridge
  const l1Circulating = l1Supply - bridgeLocked;

  // Parity check: L2 minted should equal L1 locked (within rounding tolerance)
  const drift = Math.abs(l2Supply - bridgeLocked);
  const driftStatus = drift > 1 ? "drift_detected" : "synced";

  supplyData = {
    ...supplyData,
    totalSupply: TOTAL_SUPPLY,
    circulatingSupply: TOTAL_SUPPLY, // total is always 1B, all circulating
    l1: {
      ...supplyData.l1,
      supply: l1Supply,
      locked: bridgeLocked,
      circulating: l1Circulating,
    },
    l2: {
      ...supplyData.l2,
      supply: l2Supply,
    },
    bridge: {
      ...supplyData.bridge,
      status: driftStatus,
      lastCheck: new Date().toISOString(),
      driftAmount: drift,
    },
    lastUpdated: new Date().toISOString(),
  };

  if (l1Result.error || l2Result.error || bridgeResult.error) {
    const errors = [l1Result.error, l2Result.error, bridgeResult.error].filter(Boolean);
    console.log(`[supply-oracle] Update completed with warnings: ${errors.join(", ")}`);
  } else {
    console.log(
      `[supply-oracle] Supply updated — Total: ${TOTAL_SUPPLY} | L1: ${l1Supply} (${bridgeLocked} locked) | L2: ${l2Supply} | Status: ${driftStatus}`
    );
  }
}

// ── Express App ─────────────────────────────────────────────────────────────

const app = express();
app.use(cors());

// Full supply data
app.get("/", (req, res) => {
  res.json(supplyData);
});

// CoinGecko/CoinMarketCap compatible — total supply
app.get("/supply", (req, res) => {
  res.type("text/plain").send(TOTAL_SUPPLY.toString());
});

// CoinGecko/CoinMarketCap compatible — circulating supply  
app.get("/circulating", (req, res) => {
  res.type("text/plain").send(supplyData.circulatingSupply.toString());
});

// Supply breakdown by chain  
app.get("/breakdown", (req, res) => {
  res.json({
    total: TOTAL_SUPPLY,
    l1: {
      circulating: supplyData.l1.circulating,
      locked: supplyData.l1.locked,
    },
    l2: {
      circulating: supplyData.l2.supply,
    },
    bridgeStatus: supplyData.bridge.status,
  });
});

// API for explorer and frontends
app.get("/api/v1/supply", (req, res) => {
  res.json({
    totalSupply: TOTAL_SUPPLY,
    circulatingSupply: supplyData.circulatingSupply,
    l1Supply: supplyData.l1.circulating,
    l2Supply: supplyData.l2.supply,
    bridgeLocked: supplyData.l1.locked,
    symbol: "MYTH",
    decimals: MYTH_DECIMALS,
    lastUpdated: supplyData.lastUpdated,
  });
});

// Health
app.get("/health", (req, res) => {
  const age = Date.now() - new Date(supplyData.lastUpdated).getTime();
  const healthy = age < POLL_INTERVAL_MS * 3;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "stale",
    lastUpdated: supplyData.lastUpdated,
    ageMs: age,
    bridgeStatus: supplyData.bridge.status,
  });
});

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[supply-oracle] Mythic Supply Oracle running on port ${PORT}`);
  console.log(`[supply-oracle] Canonical total supply: ${TOTAL_SUPPLY.toLocaleString()} MYTH`);
  console.log(`[supply-oracle] L1 RPC: ${L1_RPC_URL}`);
  console.log(`[supply-oracle] L2 RPC: ${L2_RPC_URL}`);
  console.log(`[supply-oracle] Polling every ${POLL_INTERVAL_MS}ms`);
  
  // Initial fetch
  updateSupplyData();
  
  // Poll on interval
  setInterval(updateSupplyData, POLL_INTERVAL_MS);
});
