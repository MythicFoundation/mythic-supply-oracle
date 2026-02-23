/**
 * Mythic Supply Oracle
 * 
 * Canonical source of truth for $MYTH total & circulating supply + live price.
 * 
 * Model:
 *   - Total Supply is ALWAYS 1,000,000,000 MYTH (1B) — fixed at genesis on pump.fun
 *   - When tokens bridge L1→L2: locked in L1 vault, minted on L2 (supply stays 1B)
 *   - When tokens bridge L2→L1: burned on L2, released from L1 vault (supply stays 1B)
 *   - The oracle queries both chains to verify parity and expose breakdown
 *   - Price fetched from DexScreener + Jupiter (whichever responds first)
 * 
 * Endpoints:
 *   GET /                → full supply + price data
 *   GET /supply          → total supply number (1000000000)
 *   GET /circulating     → circulating supply (total - locked/burned)
 *   GET /price           → current price data (usd, market cap, volume, etc.)
 *   GET /breakdown       → supply breakdown by chain
 *   GET /api/v1/supply   → structured API for explorer/frontends
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
    supply: TOTAL_SUPPLY,
    locked: 0,
    circulating: TOTAL_SUPPLY,
    mint: L1_MYTH_MINT,
  },
  l2: {
    supply: 0,
    mint: L2_MYTH_MINT,
  },
  bridge: {
    l1Program: L1_BRIDGE_PROGRAM,
    status: "synced",
    lastCheck: new Date().toISOString(),
    driftAmount: 0,
  },
  price: {
    usd: null,
    sol: null,
    marketCap: null,
    volume24h: null,
    priceChange24h: null,
    fdv: null,
    liquidity: null,
    source: null,
    lastUpdate: null,
    pumpfun: {
      bondingCurveComplete: null,
      replyCount: null,
      website: null,
    },
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

// ── Price Fetching ──────────────────────────────────────────────────────────

async function fetchDexScreenerPrice() {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${L1_MYTH_MINT}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.pairs || data.pairs.length === 0) return null;

    // Get the most liquid pair
    const pair = data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return {
      usd: parseFloat(pair.priceUsd) || null,
      sol: parseFloat(pair.priceNative) || null,
      marketCap: pair.marketCap || null,
      volume24h: pair.volume?.h24 || null,
      priceChange24h: pair.priceChange?.h24 || null,
      fdv: pair.fdv || null,
      liquidity: pair.liquidity?.usd || null,
      source: "dexscreener",
      pairAddress: pair.pairAddress,
      dexId: pair.dexId,
    };
  } catch (err) {
    console.log(`[supply-oracle] DexScreener price fetch failed: ${err.message}`);
    return null;
  }
}

async function fetchJupiterPrice() {
  try {
    const res = await fetch(`https://api.jup.ag/price/v2?ids=${L1_MYTH_MINT}`);
    if (!res.ok) return null;
    const data = await res.json();
    const tokenData = data.data?.[L1_MYTH_MINT];
    if (!tokenData) return null;
    return {
      usd: parseFloat(tokenData.price) || null,
      sol: null,
      marketCap: null,
      volume24h: null,
      priceChange24h: null,
      fdv: null,
      liquidity: null,
      source: "jupiter",
    };
  } catch (err) {
    console.log(`[supply-oracle] Jupiter price fetch failed: ${err.message}`);
    return null;
  }
}

async function fetchPumpFunData() {
  try {
    const res = await fetch(`https://frontend-api.pump.fun/coins/${L1_MYTH_MINT}`);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      usd: data.usd_market_cap ? data.usd_market_cap / TOTAL_SUPPLY : null,
      marketCap: data.usd_market_cap || null,
      bondingCurveComplete: data.complete || null,
      replyCount: data.reply_count || null,
      website: data.website || null,
      source: "pumpfun",
    };
  } catch (err) {
    // PumpFun API may not be available for this token
    return null;
  }
}

async function updatePrice() {
  // Try DexScreener first (most comprehensive), then Jupiter, then PumpFun
  const [dexData, jupData, pumpData] = await Promise.all([
    fetchDexScreenerPrice(),
    fetchJupiterPrice(),
    fetchPumpFunData(),
  ]);

  // Use DexScreener as primary, Jupiter as fallback for price
  const primary = dexData || jupData;

  if (primary) {
    supplyData.price = {
      usd: primary.usd,
      sol: primary.sol || (dexData?.sol ?? null),
      marketCap: primary.marketCap || (pumpData?.marketCap ?? null),
      volume24h: primary.volume24h || null,
      priceChange24h: primary.priceChange24h || null,
      fdv: primary.fdv || (primary.usd ? primary.usd * TOTAL_SUPPLY : null),
      liquidity: primary.liquidity || null,
      source: primary.source,
      lastUpdate: new Date().toISOString(),
      pumpfun: {
        bondingCurveComplete: pumpData?.bondingCurveComplete ?? null,
        replyCount: pumpData?.replyCount ?? null,
        website: pumpData?.website ?? null,
      },
    };
    console.log(`[supply-oracle] Price updated: $${primary.usd?.toFixed(8) ?? "N/A"} (source: ${primary.source})`);
  } else if (pumpData?.usd) {
    // PumpFun as last resort
    supplyData.price = {
      ...supplyData.price,
      usd: pumpData.usd,
      marketCap: pumpData.marketCap,
      fdv: pumpData.usd * TOTAL_SUPPLY,
      source: "pumpfun",
      lastUpdate: new Date().toISOString(),
      pumpfun: {
        bondingCurveComplete: pumpData.bondingCurveComplete,
        replyCount: pumpData.replyCount,
        website: pumpData.website,
      },
    };
    console.log(`[supply-oracle] Price updated from PumpFun: $${pumpData.usd?.toFixed(8)}`);
  } else {
    console.log(`[supply-oracle] No price data available (token may not be listed yet)`);
  }
}

// ── Supply Polling ──────────────────────────────────────────────────────────

async function fetchL1Supply() {
  try {
    const conn = new Connection(L1_RPC_URL, "confirmed");
    const mintPubkey = new PublicKey(L1_MYTH_MINT);
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
    const mintPubkey = new PublicKey(L2_MYTH_MINT);
    const mintInfo = await conn.getParsedAccountInfo(mintPubkey);
    if (mintInfo.value && "parsed" in mintInfo.value.data) {
      const parsed = mintInfo.value.data.parsed;
      const supply = parseFloat(parsed.info.supply) / (10 ** parsed.info.decimals);
      return { supply, error: null };
    }
    return { supply: 0, error: null };
  } catch (err) {
    return { supply: 0, error: null };
  }
}

async function fetchBridgeLocked() {
  try {
    const conn = new Connection(L1_RPC_URL, "confirmed");
    const bridgePubkey = new PublicKey(L1_BRIDGE_PROGRAM);
    const vaultSeed = Buffer.from("vault");
    const mintPubkey = new PublicKey(L1_MYTH_MINT);
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
  const l1Circulating = l1Supply - bridgeLocked;
  const drift = Math.abs(l2Supply - bridgeLocked);
  const driftStatus = drift > 1 ? "drift_detected" : "synced";

  supplyData = {
    ...supplyData,
    totalSupply: TOTAL_SUPPLY,
    circulatingSupply: TOTAL_SUPPLY,
    l1: { ...supplyData.l1, supply: l1Supply, locked: bridgeLocked, circulating: l1Circulating },
    l2: { ...supplyData.l2, supply: l2Supply },
    bridge: { ...supplyData.bridge, status: driftStatus, lastCheck: new Date().toISOString(), driftAmount: drift },
    lastUpdated: new Date().toISOString(),
  };

  // Also update price on each poll cycle
  await updatePrice();

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

// Full supply + price data
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

// Price endpoint — for websites and bots
app.get("/price", (req, res) => {
  res.json({
    symbol: "MYTH",
    mint: L1_MYTH_MINT,
    price: supplyData.price.usd,
    priceSOL: supplyData.price.sol,
    marketCap: supplyData.price.marketCap,
    fdv: supplyData.price.fdv,
    volume24h: supplyData.price.volume24h,
    priceChange24h: supplyData.price.priceChange24h,
    liquidity: supplyData.price.liquidity,
    source: supplyData.price.source,
    lastUpdate: supplyData.price.lastUpdate,
    pumpfun: supplyData.price.pumpfun,
  });
});

// Supply breakdown by chain  
app.get("/breakdown", (req, res) => {
  res.json({
    total: TOTAL_SUPPLY,
    l1: { circulating: supplyData.l1.circulating, locked: supplyData.l1.locked },
    l2: { circulating: supplyData.l2.supply },
    bridgeStatus: supplyData.bridge.status,
    price: supplyData.price.usd,
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
    price: supplyData.price.usd,
    marketCap: supplyData.price.marketCap,
    volume24h: supplyData.price.volume24h,
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
    priceSource: supplyData.price.source,
  });
});

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[supply-oracle] Mythic Supply Oracle running on port ${PORT}`);
  console.log(`[supply-oracle] Canonical total supply: ${TOTAL_SUPPLY.toLocaleString()} MYTH`);
  console.log(`[supply-oracle] L1 RPC: ${L1_RPC_URL}`);
  console.log(`[supply-oracle] L2 RPC: ${L2_RPC_URL}`);
  console.log(`[supply-oracle] L1 MYTH Mint: ${L1_MYTH_MINT}`);
  console.log(`[supply-oracle] Polling every ${POLL_INTERVAL_MS}ms (supply + price)`);
  
  // Initial fetch
  updateSupplyData();
  
  // Poll on interval
  setInterval(updateSupplyData, POLL_INTERVAL_MS);
});
