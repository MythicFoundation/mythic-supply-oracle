/**
 * Mythic Supply Oracle v2
 *
 * Canonical source of truth for $MYTH total & circulating supply,
 * real-time burn tracking, fee breakdown, and live price.
 *
 * Reads the on-chain FeeConfig PDA from the myth-token program to get
 * actual burn stats, fee splits, and distribution data.
 *
 * Endpoints:
 *   GET /                    -> full supply + price data (v1 compat)
 *   GET /supply              -> total supply number (CoinGecko compat)
 *   GET /circulating         -> circulating supply (CoinGecko compat)
 *   GET /price               -> current price data
 *   GET /breakdown           -> supply breakdown by chain
 *   GET /api/v1/supply       -> structured API for explorer/frontends
 *   GET /api/supply          -> {totalSupply, burned, circulating, burnRate24h}
 *   GET /api/supply/stats    -> {feeBreakdown, validatorRewards, foundationTreasury}
 *   GET /api/supply/history  -> burn history over time
 *   GET /health              -> health check
 */

import express from "express";
import cors from "cors";
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// -- Timeout helper -----------------------------------------------------------

function withTimeout(promise, ms = 10000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

// -- Config -------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "4002", 10);
const L1_RPC_URL = process.env.L1_RPC_URL || "http://MYTHIC_RPC_IP:8899";
const L2_RPC_URL = process.env.L2_RPC_URL || "http://127.0.0.1:8899";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "10000", 10);

// MYTH token addresses
const L1_MYTH_MINT = process.env.L1_MYTH_MINT || "5UP2iL9DefXC3yovX9b4XG2EiCnyxuVo3S2F6ik5pump";
// L2 MYTH is the NATIVE chain token (like SOL), not an SPL mint
// This variable is kept for backwards compat but L2 supply is fetched via getSupply RPC
const L2_MYTH_MINT = process.env.L2_MYTH_MINT || "native";

// Programs
const L1_BRIDGE_PROGRAM = process.env.L1_BRIDGE_PROGRAM || "oEQfREm4FQkaVeRoxJHkJLB1feHprrntY6eJuW2zbqQ";
const MYTH_TOKEN_PROGRAM = process.env.MYTH_TOKEN_PROGRAM || "7Hmyi9v4itEt49xo1fpTgHk1ytb8MZft7RBATBgb1pnf";

// Fixed canonical total supply: 1 billion MYTH
const TOTAL_SUPPLY = 1_000_000_000;
const MYTH_DECIMALS = 9;

// Foundation wallet
const FOUNDATION_WALLET = process.env.FOUNDATION_WALLET || "AnVqSYE3ArJX9ZCbiReFcNa2JdLyri3GGGt34j63hT9e";

// History config
const HISTORY_FILE = path.join(__dirname, "data", "burn_history.json");
const MAX_HISTORY_ENTRIES = 8640; // ~24h at 10s intervals

// -- FeeConfig deserialization ------------------------------------------------
// Must match the Borsh layout from programs/myth-token/src/lib.rs

/**
 * FeeConfig on-chain layout (Borsh, 235 bytes):
 *   is_initialized: bool (1)
 *   admin: Pubkey (32)
 *   foundation_wallet: Pubkey (32)
 *   burn_address: Pubkey (32)
 *   myth_mint: Pubkey (32)
 *   gas_split: FeeSplit { validator_bps: u16, foundation_bps: u16, burn_bps: u16 } (6)
 *   compute_split: FeeSplit (6)
 *   inference_split: FeeSplit (6)
 *   bridge_split: FeeSplit (6)
 *   current_epoch: u64 (8)
 *   total_burned: u64 (8)
 *   total_distributed: u64 (8)
 *   total_foundation_collected: u64 (8)
 *   is_paused: bool (1)
 *   bump: u8 (1)
 *   gas_burned: u64 (8)
 *   compute_burned: u64 (8)
 *   inference_burned: u64 (8)
 *   bridge_burned: u64 (8)
 *   subnet_burned: u64 (8)
 *   total_foundation_burned: u64 (8)
 */
function deserializeFeeConfig(data) {
  if (!data || data.length < 235) {
    return null;
  }

  const buf = Buffer.from(data);
  let offset = 0;

  const readBool = () => { const v = buf.readUInt8(offset); offset += 1; return v !== 0; };
  const readU8 = () => { const v = buf.readUInt8(offset); offset += 1; return v; };
  const readU16LE = () => { const v = buf.readUInt16LE(offset); offset += 2; return v; };
  const readU64LE = () => { const v = buf.readBigUInt64LE(offset); offset += 8; return v; };
  const readPubkey = () => { const pk = new PublicKey(buf.subarray(offset, offset + 32)); offset += 32; return pk.toBase58(); };
  const readFeeSplit = () => ({
    validatorBps: readU16LE(),
    foundationBps: readU16LE(),
    burnBps: readU16LE(),
  });

  const isInitialized = readBool();
  if (!isInitialized) return null;

  const admin = readPubkey();
  const foundationWallet = readPubkey();
  const burnAddress = readPubkey();
  const mythMint = readPubkey();
  const gasSplit = readFeeSplit();
  const computeSplit = readFeeSplit();
  const inferenceSplit = readFeeSplit();
  const bridgeSplit = readFeeSplit();
  const currentEpoch = readU64LE();
  const totalBurned = readU64LE();
  const totalDistributed = readU64LE();
  const totalFoundationCollected = readU64LE();
  const isPaused = readBool();
  const bump = readU8();
  const gasBurned = readU64LE();
  const computeBurned = readU64LE();
  const inferenceBurned = readU64LE();
  const bridgeBurned = readU64LE();
  const subnetBurned = readU64LE();
  const totalFoundationBurned = readU64LE();

  return {
    isInitialized,
    admin,
    foundationWallet,
    burnAddress,
    mythMint,
    gasSplit,
    computeSplit,
    inferenceSplit,
    bridgeSplit,
    currentEpoch: Number(currentEpoch),
    totalBurned: Number(totalBurned),
    totalDistributed: Number(totalDistributed),
    totalFoundationCollected: Number(totalFoundationCollected),
    isPaused,
    bump,
    gasBurned: Number(gasBurned),
    computeBurned: Number(computeBurned),
    inferenceBurned: Number(inferenceBurned),
    bridgeBurned: Number(bridgeBurned),
    subnetBurned: Number(subnetBurned),
    totalFoundationBurned: Number(totalFoundationBurned),
  };
}

// -- ValidatorFeeAccount deserialization --------------------------------------
// Layout (69 bytes): validator(32) + stake_amount(8) + ai_capable(1) +
//   reward_multiplier(2) + pending_rewards(8) + total_claimed(8) +
//   registered_at(8) + is_active(1) + bump(1)

function deserializeValidatorFeeAccount(data) {
  if (!data || data.length < 69) return null;
  const buf = Buffer.from(data);
  let offset = 0;
  const readPubkey = () => { const pk = new PublicKey(buf.subarray(offset, offset + 32)); offset += 32; return pk.toBase58(); };
  const readU64 = () => { const v = buf.readBigUInt64LE(offset); offset += 8; return Number(v); };
  const readI64 = () => { const v = buf.readBigInt64LE(offset); offset += 8; return Number(v); };
  const readBool = () => { const v = buf.readUInt8(offset); offset += 1; return v !== 0; };
  const readU16 = () => { const v = buf.readUInt16LE(offset); offset += 2; return v; };
  const readU8 = () => { const v = buf.readUInt8(offset); offset += 1; return v; };

  return {
    validator: readPubkey(),
    stakeAmount: readU64(),
    aiCapable: readBool(),
    rewardMultiplier: readU16(),
    pendingRewards: readU64(),
    totalClaimed: readU64(),
    registeredAt: readI64(),
    isActive: readBool(),
    bump: readU8(),
  };
}

// -- State --------------------------------------------------------------------

let supplyData = {
  totalSupply: TOTAL_SUPPLY,
  circulatingSupply: TOTAL_SUPPLY,
  burned: 0,
  l1: { supply: TOTAL_SUPPLY, locked: 0, circulating: TOTAL_SUPPLY, mint: L1_MYTH_MINT },
  l2: { supply: 0, mint: L2_MYTH_MINT },
  bridge: { l1Program: L1_BRIDGE_PROGRAM, status: "synced", lastCheck: new Date().toISOString(), driftAmount: 0 },
  feeConfig: null,
  price: {
    usd: null, sol: null, marketCap: null, volume24h: null,
    priceChange24h: null, fdv: null, liquidity: null,
    source: null, lastUpdate: null,
    pumpfun: { bondingCurveComplete: null, replyCount: null, website: null },
  },
  meta: {
    name: "Mythic", symbol: "MYTH", decimals: MYTH_DECIMALS,
    chain: "Solana L1 + Mythic L2", website: "https://mythic.sh",
    totalSupplyRaw: (BigInt(TOTAL_SUPPLY) * BigInt(10 ** MYTH_DECIMALS)).toString(),
  },
  lastUpdated: new Date().toISOString(),
};

// Burn history: array of { timestamp, totalBurned, gasBurned, computeBurned, inferenceBurned, bridgeBurned, subnetBurned }
let burnHistory = [];
let last24hBurnSnapshot = { timestamp: Date.now(), totalBurned: 0 };
let last7dBurnSnapshot = { timestamp: Date.now(), totalBurned: 0 };

// Validator cache (refreshed every 60s, not every 10s — getProgramAccounts is expensive)
let validatorCache = [];
let lastValidatorFetch = 0;
const VALIDATOR_POLL_MS = 60000;

// -- History persistence ------------------------------------------------------

function loadBurnHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        burnHistory = parsed.slice(-MAX_HISTORY_ENTRIES);
        // Set 24h snapshot from history if available
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const oldEntry = burnHistory.find((e) => e.timestamp >= cutoff);
        if (oldEntry) {
          last24hBurnSnapshot = { timestamp: oldEntry.timestamp, totalBurned: oldEntry.totalBurned };
        }
        console.log(`[supply-oracle] Loaded ${burnHistory.length} burn history entries`);
      }
    }
  } catch (err) {
    console.log(`[supply-oracle] Could not load burn history: ${err.message}`);
  }
}

function saveBurnHistory() {
  try {
    const dir = path.dirname(HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(burnHistory.slice(-MAX_HISTORY_ENTRIES)));
  } catch (err) {
    console.log(`[supply-oracle] Could not save burn history: ${err.message}`);
  }
}

// -- Price Fetching -----------------------------------------------------------

async function fetchDexScreenerPrice() {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${L1_MYTH_MINT}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.pairs || data.pairs.length === 0) return null;
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
    return { usd: parseFloat(tokenData.price) || null, sol: null, marketCap: null, volume24h: null, priceChange24h: null, fdv: null, liquidity: null, source: "jupiter" };
  } catch (err) {
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
    return null;
  }
}

async function updatePrice() {
  const [dexData, jupData, pumpData] = await Promise.all([
    fetchDexScreenerPrice(),
    fetchJupiterPrice(),
    fetchPumpFunData(),
  ]);

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
    console.log(`[supply-oracle] Price: $${primary.usd?.toFixed(8) ?? "N/A"} (${primary.source})`);
  } else if (pumpData?.usd) {
    supplyData.price = {
      ...supplyData.price,
      usd: pumpData.usd,
      marketCap: pumpData.marketCap,
      fdv: pumpData.usd * TOTAL_SUPPLY,
      source: "pumpfun",
      lastUpdate: new Date().toISOString(),
      pumpfun: { bondingCurveComplete: pumpData.bondingCurveComplete, replyCount: pumpData.replyCount, website: pumpData.website },
    };
  }
  // Silently skip if no price data — token may not be listed yet
}

// -- Supply + FeeConfig Polling -----------------------------------------------

async function fetchL1Supply() {
  try {
    const conn = new Connection(L1_RPC_URL, "confirmed");
    const mintInfo = await withTimeout(conn.getParsedAccountInfo(new PublicKey(L1_MYTH_MINT)), 8000);
    if (mintInfo.value && "parsed" in mintInfo.value.data) {
      const parsed = mintInfo.value.data.parsed;
      return { supply: parseFloat(parsed.info.supply) / (10 ** parsed.info.decimals), error: null };
    }
    return { supply: TOTAL_SUPPLY, error: "Could not parse L1 mint" };
  } catch (err) {
    return { supply: TOTAL_SUPPLY, error: err.message };
  }
}

async function fetchL2Supply() {
  // L2 MYTH is the native chain token (like SOL on Solana), not an SPL token.
  // Use getSupply RPC to get total native token supply on L2.
  try {
    const conn = new Connection(L2_RPC_URL, "confirmed");
    const supplyResp = await withTimeout(conn.getSupply(), 8000);
    if (supplyResp && supplyResp.value) {
      const totalLamports = supplyResp.value.total;
      return { supply: totalLamports / 1e9, error: null };
    }
    return { supply: 0, error: "Could not fetch L2 supply" };
  } catch (err) {
    return { supply: 0, error: err.message };
  }
}

async function fetchBridgeLocked() {
  try {
    const conn = new Connection(L1_RPC_URL, "confirmed");
    const bridgePubkey = new PublicKey(L1_BRIDGE_PROGRAM);
    const mintPubkey = new PublicKey(L1_MYTH_MINT);
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), mintPubkey.toBuffer()],
      bridgePubkey,
    );
    const vaultInfo = await withTimeout(conn.getParsedAccountInfo(vaultPda), 8000);
    if (vaultInfo.value && "parsed" in vaultInfo.value.data) {
      const amount = parseFloat(vaultInfo.value.data.parsed.info.tokenAmount.uiAmountString);
      return { locked: amount, error: null };
    }
    return { locked: 0, error: null };
  } catch (err) {
    return { locked: 0, error: err.message };
  }
}

async function fetchFeeConfig() {
  try {
    const conn = new Connection(L2_RPC_URL, "confirmed");
    const programId = new PublicKey(MYTH_TOKEN_PROGRAM);
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("fee_config")],
      programId,
    );
    const accountInfo = await withTimeout(conn.getAccountInfo(configPda), 8000);
    if (!accountInfo || !accountInfo.data) {
      return { config: null, error: "FeeConfig PDA not found" };
    }
    const config = deserializeFeeConfig(accountInfo.data);
    if (!config) {
      return { config: null, error: "FeeConfig not initialized or too small" };
    }
    return { config, error: null };
  } catch (err) {
    return { config: null, error: err.message };
  }
}

async function fetchValidators() {
  try {
    const conn = new Connection(L2_RPC_URL, "confirmed");
    const programId = new PublicKey(MYTH_TOKEN_PROGRAM);
    const accounts = await withTimeout(
      conn.getProgramAccounts(programId, {
        filters: [{ dataSize: 69 }], // ValidatorFeeAccount is exactly 69 bytes
      }),
      10000,
    );
    const validators = [];
    for (const { pubkey, account } of accounts) {
      const vfa = deserializeValidatorFeeAccount(account.data);
      if (vfa) {
        validators.push({ address: pubkey.toBase58(), ...vfa });
      }
    }
    return validators;
  } catch (err) {
    console.log(`[supply-oracle] Validator fetch failed: ${err.message}`);
    return null; // keep previous cache
  }
}

async function fetchFoundationBalance() {
  try {
    const conn = new Connection(L2_RPC_URL, "confirmed");
    const balance = await withTimeout(conn.getBalance(new PublicKey(FOUNDATION_WALLET)), 8000);
    return { balance: balance / 1e9, error: null };
  } catch (err) {
    return { balance: 0, error: err.message };
  }
}

async function updateSupplyData() {
  const [l1Result, l2Result, bridgeResult, feeConfigResult, foundationResult] = await Promise.all([
    fetchL1Supply(),
    fetchL2Supply(),
    fetchBridgeLocked(),
    fetchFeeConfig(),
    fetchFoundationBalance(),
  ]);

  const l1Supply = l1Result.supply;
  const l2Supply = l2Result.supply;
  const bridgeLocked = bridgeResult.locked;
  const l1Circulating = l1Supply - bridgeLocked;
  const drift = Math.abs(l2Supply - bridgeLocked);
  const driftStatus = drift > 1 ? "drift_detected" : "synced";

  // Burn stats from on-chain FeeConfig (in lamports, convert to MYTH)
  let totalBurnedMYTH = 0;
  let feeConfig = supplyData.feeConfig;

  if (feeConfigResult.config) {
    feeConfig = feeConfigResult.config;
    totalBurnedMYTH = feeConfig.totalBurned / 1e9;
  }

  const circulatingSupply = TOTAL_SUPPLY - totalBurnedMYTH;

  supplyData = {
    ...supplyData,
    totalSupply: TOTAL_SUPPLY,
    circulatingSupply,
    burned: totalBurnedMYTH,
    l1: { ...supplyData.l1, supply: l1Supply, locked: bridgeLocked, circulating: l1Circulating },
    l2: { ...supplyData.l2, supply: l2Supply },
    bridge: { ...supplyData.bridge, status: driftStatus, lastCheck: new Date().toISOString(), driftAmount: drift },
    feeConfig,
    foundationBalance: foundationResult.balance,
    lastUpdated: new Date().toISOString(),
  };

  // Record burn history
  const now = Date.now();
  const historyEntry = {
    timestamp: now,
    totalBurned: feeConfig ? feeConfig.totalBurned : 0,
    gasBurned: feeConfig ? feeConfig.gasBurned : 0,
    computeBurned: feeConfig ? feeConfig.computeBurned : 0,
    inferenceBurned: feeConfig ? feeConfig.inferenceBurned : 0,
    bridgeBurned: feeConfig ? feeConfig.bridgeBurned : 0,
    subnetBurned: feeConfig ? feeConfig.subnetBurned : 0,
  };
  burnHistory.push(historyEntry);
  if (burnHistory.length > MAX_HISTORY_ENTRIES) {
    burnHistory = burnHistory.slice(-MAX_HISTORY_ENTRIES);
  }

  // Update 24h burn snapshot — find the entry from ~24h ago
  const cutoff24h = now - 24 * 60 * 60 * 1000;
  const oldEntry24h = burnHistory.find((e) => e.timestamp >= cutoff24h);
  if (oldEntry24h) {
    last24hBurnSnapshot = { timestamp: oldEntry24h.timestamp, totalBurned: oldEntry24h.totalBurned };
  }

  // Update 7d burn snapshot
  const cutoff7d = now - 7 * 24 * 60 * 60 * 1000;
  const oldEntry7d = burnHistory.find((e) => e.timestamp >= cutoff7d);
  if (oldEntry7d) {
    last7dBurnSnapshot = { timestamp: oldEntry7d.timestamp, totalBurned: oldEntry7d.totalBurned };
  }

  // Refresh validator cache every VALIDATOR_POLL_MS
  if (now - lastValidatorFetch > VALIDATOR_POLL_MS) {
    const validators = await fetchValidators();
    if (validators !== null) {
      validatorCache = validators;
    }
    lastValidatorFetch = now;
  }

  // Save history every 60 entries (~10 minutes at 10s interval)
  if (burnHistory.length % 60 === 0) {
    saveBurnHistory();
  }

  // Update price
  await updatePrice();

  const errors = [l1Result.error, l2Result.error, bridgeResult.error, feeConfigResult.error, foundationResult.error].filter(Boolean);
  if (errors.length > 0) {
    console.log(`[supply-oracle] Update with warnings: ${errors.join(", ")}`);
  } else {
    console.log(
      `[supply-oracle] Total: ${TOTAL_SUPPLY} | Burned: ${totalBurnedMYTH} | Circ: ${circulatingSupply} | L1: ${l1Supply} (${bridgeLocked} locked) | L2: ${l2Supply}`,
    );
  }
}

// -- Express App --------------------------------------------------------------

const app = express();
app.use(cors());

// Full supply + price data (v1 compat)
app.get("/", (_req, res) => {
  const { feeConfig: _fc, ...safeData } = supplyData;
  res.json(safeData);
});

// CoinGecko/CoinMarketCap compatible — total supply
app.get("/supply", (_req, res) => {
  res.type("text/plain").send(TOTAL_SUPPLY.toString());
});

// CoinGecko/CoinMarketCap compatible — circulating supply
app.get("/circulating", (_req, res) => {
  res.type("text/plain").send(supplyData.circulatingSupply.toString());
});

// Price endpoint
app.get("/price", (_req, res) => {
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
app.get("/breakdown", (_req, res) => {
  res.json({
    total: TOTAL_SUPPLY,
    burned: supplyData.burned,
    circulating: supplyData.circulatingSupply,
    l1: { circulating: supplyData.l1.circulating, locked: supplyData.l1.locked },
    l2: { circulating: supplyData.l2.supply },
    bridgeStatus: supplyData.bridge.status,
    price: supplyData.price.usd,
  });
});

// API for explorer and frontends (v1 compat)
app.get("/api/v1/supply", (_req, res) => {
  res.json({
    totalSupply: TOTAL_SUPPLY,
    circulatingSupply: supplyData.circulatingSupply,
    burned: supplyData.burned,
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

// --- NEW: /api/supply --------------------------------------------------------

app.get("/api/supply", (_req, res) => {
  const fc = supplyData.feeConfig;
  const totalBurnedLamports = fc ? fc.totalBurned : 0;
  const totalBurnedMYTH = totalBurnedLamports / 1e9;

  // Compute burn rates
  const nowBurned = totalBurnedLamports;
  const burnRate24h = (nowBurned - last24hBurnSnapshot.totalBurned) / 1e9;
  const burnRateWeek = (nowBurned - last7dBurnSnapshot.totalBurned) / 1e9;

  res.json({
    totalSupply: TOTAL_SUPPLY,
    burned: totalBurnedMYTH,
    circulating: TOTAL_SUPPLY - totalBurnedMYTH,
    burnRate24h,
    burnRateWeek,
    decimals: MYTH_DECIMALS,
    lastUpdated: supplyData.lastUpdated,
  });
});

// --- NEW: /api/supply/stats --------------------------------------------------

app.get("/api/supply/stats", (_req, res) => {
  const fc = supplyData.feeConfig;

  const toMYTH = (lamports) => (lamports || 0) / 1e9;

  const feeBreakdown = {
    gas: { burned: toMYTH(fc?.gasBurned), split: fc?.gasSplit || null },
    compute: { burned: toMYTH(fc?.computeBurned), split: fc?.computeSplit || null },
    inference: { burned: toMYTH(fc?.inferenceBurned), split: fc?.inferenceSplit || null },
    bridge: { burned: toMYTH(fc?.bridgeBurned), split: fc?.bridgeSplit || null },
    subnet: { burned: toMYTH(fc?.subnetBurned) },
  };

  res.json({
    feeBreakdown,
    totalBurned: toMYTH(fc?.totalBurned),
    totalFoundationBurned: toMYTH(fc?.totalFoundationBurned),
    validatorRewards: toMYTH(fc?.totalDistributed),
    foundationTreasury: {
      collected: toMYTH(fc?.totalFoundationCollected),
      balance: supplyData.foundationBalance || 0,
      wallet: FOUNDATION_WALLET,
    },
    currentEpoch: fc?.currentEpoch || 0,
    isPaused: fc?.isPaused || false,
    lastUpdated: supplyData.lastUpdated,
  });
});

// --- NEW: /api/supply/history ------------------------------------------------

app.get("/api/supply/history", (req, res) => {
  // Optional query params: ?period=1h|6h|24h (default 24h), ?limit=100
  const period = req.query.period || "24h";
  const limit = Math.min(parseInt(req.query.limit || "500", 10), MAX_HISTORY_ENTRIES);

  const periodMs = {
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
  };
  const cutoff = Date.now() - (periodMs[period] || periodMs["24h"]);

  const filtered = burnHistory
    .filter((e) => e.timestamp >= cutoff)
    .slice(-limit)
    .map((e) => ({
      timestamp: new Date(e.timestamp).toISOString(),
      totalBurned: e.totalBurned / 1e9,
      gasBurned: e.gasBurned / 1e9,
      computeBurned: e.computeBurned / 1e9,
      inferenceBurned: e.inferenceBurned / 1e9,
      bridgeBurned: e.bridgeBurned / 1e9,
      subnetBurned: e.subnetBurned / 1e9,
    }));

  res.json({
    period,
    entries: filtered.length,
    history: filtered,
  });
});

// --- NEW: /api/supply/validators ---------------------------------------------

app.get("/api/supply/validators", (_req, res) => {
  const toMYTH = (lamports) => (lamports || 0) / 1e9;

  const validators = validatorCache.map((v) => ({
    address: v.address,
    validator: v.validator,
    stakeAmount: toMYTH(v.stakeAmount),
    aiCapable: v.aiCapable,
    rewardMultiplier: v.rewardMultiplier,
    pendingRewards: toMYTH(v.pendingRewards),
    totalClaimed: toMYTH(v.totalClaimed),
    registeredAt: new Date(v.registeredAt * 1000).toISOString(),
    isActive: v.isActive,
  }));

  const active = validators.filter((v) => v.isActive);
  const totalStake = active.reduce((s, v) => s + v.stakeAmount, 0);
  const totalPending = active.reduce((s, v) => s + v.pendingRewards, 0);
  const totalClaimed = validators.reduce((s, v) => s + v.totalClaimed, 0);

  res.json({
    count: validators.length,
    active: active.length,
    totalStake,
    totalPendingRewards: totalPending,
    totalClaimedRewards: totalClaimed,
    validators,
    lastUpdated: supplyData.lastUpdated,
  });
});

// Health check
app.get("/health", (_req, res) => {
  const age = Date.now() - new Date(supplyData.lastUpdated).getTime();
  const healthy = age < POLL_INTERVAL_MS * 3;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "stale",
    lastUpdated: supplyData.lastUpdated,
    ageMs: age,
    bridgeStatus: supplyData.bridge.status,
    priceSource: supplyData.price.source,
    feeConfigLoaded: supplyData.feeConfig !== null,
    pollIntervalMs: POLL_INTERVAL_MS,
  });
});

// -- Start --------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[supply-oracle] Mythic Supply Oracle v2 on port ${PORT}`);
  console.log(`[supply-oracle] Total supply: ${TOTAL_SUPPLY.toLocaleString()} MYTH`);
  console.log(`[supply-oracle] L1 RPC: ${L1_RPC_URL}`);
  console.log(`[supply-oracle] L2 RPC: ${L2_RPC_URL}`);
  console.log(`[supply-oracle] MYTH Token Program: ${MYTH_TOKEN_PROGRAM}`);
  console.log(`[supply-oracle] Polling every ${POLL_INTERVAL_MS}ms`);

  loadBurnHistory();
  updateSupplyData();
  setInterval(updateSupplyData, POLL_INTERVAL_MS);
});
