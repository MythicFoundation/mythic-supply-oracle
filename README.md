<div align="center">

# Mythic Supply Oracle

[![API](https://img.shields.io/badge/oracle-mythic.sh:4002-39FF14?style=flat-square)](https://mythic.sh)
[![Built by](https://img.shields.io/badge/built%20by-MythicLabs-7B2FFF?style=flat-square)](https://mythiclabs.io)
![License: BUSL-1.1](https://img.shields.io/badge/License-BUSL_1.1-blue.svg)
[![Node.js](https://img.shields.io/badge/node.js-18+-339933?style=flat-square&logo=node.js)](https://nodejs.org)

**Canonical source of truth for $MYTH total supply, circulating supply, burn tracking, and fee distribution.**

[Supply API](https://mythic.sh) &middot; [Tokenomics](https://mythic.sh/tokenomics) &middot; [Documentation](https://mythic.sh/docs)

</div>

---

## Overview

Mythic Supply Oracle is the authoritative supply tracking service for the $MYTH token. It polls both Solana L1 mainnet and the Mythic L2 network in real time, computes circulating supply by subtracting foundation reserves, bridge-locked funds, and burned tokens, and exposes the data through CoinGecko-compatible endpoints and a structured API for the explorer, dashboards, and third-party integrations.

## Supply Model

```
CANONICAL_TOTAL  = 1,000,000,000 MYTH

l2Supply         = getSupply() on Mythic L2 RPC
l1Supply         = getTokenSupply() on Solana mainnet (fallback: CANONICAL - l2)
totalSupply      = l1Supply + l2Supply
circulatingSupply = totalSupply - foundationBalance - bridgeLocked - burned
```

### Fee Burn Mechanics

Every transaction on Mythic L2 generates fees that are split deterministically:

| Destination | Share |
|-------------|-------|
| Validators | 50% |
| Foundation | 10% |
| **Burn** | **40%** |

Burns are real `spl_token::burn` instructions -- tokens are permanently removed from the supply. The oracle reads the on-chain `FeeConfig` account (235 bytes, borsh-serialized) and tracks per-fee-type burn totals across gas, compute, inference, bridge, and subnet categories.

## MYTH Token

| Property | Value |
|----------|-------|
| Mint | `7sfazeMxmuoDkuU5fHkDGin8uYuaTkZrRSwJM1CHXvDq` |
| Decimals | 6 (L2) / 9 (L1) |
| Total Supply | 1,000,000,000 MYTH |
| Circulating | Dynamic (query `/circulating`) |
| Foundation Wallet | `AnVqSYE3ArJX9ZCbiReFcNa2JdLyri3GGGt34j63hT9e` |

## API Endpoints

### CoinGecko-Compatible

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/supply` | Total supply as a plain number |
| `GET` | `/circulating` | Circulating supply as a plain number |
| `GET` | `/price` | Current price data |

### Structured API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Full supply breakdown with price data |
| `GET` | `/breakdown` | Supply split by chain (L1 vs L2) |
| `GET` | `/api/v1/supply` | Structured supply object for frontends |
| `GET` | `/api/supply` | Backward-compatible alias |
| `GET` | `/api/supply/stats` | Fee breakdown, validator rewards, foundation allocation |
| `GET` | `/api/supply/history` | Burn history over time (up to 8,640 data points) |
| `GET` | `/api/supply/validators` | Validator information and reward distribution |
| `GET` | `/health` | Service health check |

### Example Response -- `/api/v1/supply`

```json
{
  "totalSupply": 1000000000,
  "circulatingSupply": 487320000,
  "burned": 12680000,
  "l1Supply": 497000000,
  "l2Supply": 503000000,
  "foundationBalance": 500000000,
  "bridgeLocked": 0,
  "lastUpdated": "2026-02-25T12:00:00.000Z"
}
```

### Example Response -- `/api/supply/stats`

```json
{
  "fees": {
    "totalCollected": 4250000,
    "validatorShare": 2125000,
    "foundationShare": 425000,
    "burned": 1700000,
    "breakdown": {
      "gas": { "collected": 2000000, "burned": 800000 },
      "compute": { "collected": 1500000, "burned": 600000 },
      "inference": { "collected": 500000, "burned": 200000 },
      "bridge": { "collected": 200000, "burned": 80000 },
      "subnet": { "collected": 50000, "burned": 20000 }
    }
  }
}
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org) >= 18
- Access to a Mythic L2 RPC node
- Access to a Solana mainnet RPC endpoint

### Installation

```bash
git clone https://github.com/MythicFoundation/mythic-supply-oracle.git
cd mythic-supply-oracle
npm install
```

### Configuration

Create a `.env` file in the project root:

```env
PORT=4002
L1_RPC_URL=https://api.mainnet-beta.solana.com
L2_RPC_URL=http://127.0.0.1:8899
POLL_INTERVAL_MS=15000
CANONICAL_SUPPLY=1000000000
MYTH_DECIMALS=9
L1_MYTH_MINT=5UP2iL9DefXC3yovX9b4XG2EiCnyxuVo3S2F6ik5pump
FOUNDATION_WALLET=AnVqSYE3ArJX9ZCbiReFcNa2JdLyri3GGGt34j63hT9e
```

### Run

```bash
npm start
```

The oracle will be available at [http://localhost:4002](http://localhost:4002).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Node.js 18+](https://nodejs.org) (ES modules) |
| HTTP | [Express 4](https://expressjs.com) |
| Blockchain | [@solana/web3.js 1.98](https://solana-labs.github.io/solana-web3.js/) |
| Serialization | [Borsh 2.0](https://github.com/nicedelo/borsh-js) (FeeConfig deserialization) |
| CORS | [cors](https://github.com/expressjs/cors) |
| Data | Local JSON file for burn history persistence |

## Architecture

```
mythic-supply-oracle/
├── index.js              # Server, RPC polling, all endpoints
├── data/
│   └── burn_history.json # Persisted burn history (up to 8,640 entries)
├── .env                  # Environment configuration
├── .gitignore
└── package.json
```

### Polling Loop

The oracle runs a continuous polling loop (default: every 15 seconds) that:

1. Queries L2 RPC for native MYTH supply via `getSupply()`
2. Queries L1 RPC for SPL token supply via `getTokenSupply()`
3. Reads the on-chain `FeeConfig` account for burn totals
4. Fetches the foundation wallet balance
5. Computes circulating supply and caches the result
6. Appends a timestamped entry to burn history

All RPC calls use a 10-second timeout to prevent stalls.

## On-Chain Data Sources

| Data | Source | Method |
|------|--------|--------|
| L2 native supply | Mythic L2 RPC | `getSupply()` |
| L1 token supply | Solana mainnet RPC | `getTokenSupply()` |
| Fee config & burns | MYTH Token program | `getAccountInfo()` + borsh deserialize |
| Foundation balance | L2 RPC | `getBalance()` |
| Bridge locked | L1 Bridge PDA | `getBalance()` |

## Related Projects

- [mythic-mainnet-beta](https://github.com/MythicFoundation/mythic-mainnet-beta) -- Mythic L2 validator and on-chain programs
- [mythic-explorer-api](https://github.com/MythicFoundation/mythic-explorer-api) -- Block explorer REST API
- [mythic-swap](https://github.com/MythicFoundation/mythic-swap) -- MythicSwap decentralized exchange

## License


This project is licensed under the [Business Source License 1.1](./LICENSE). The Licensed Work will convert to MIT License on February 25, 2028.
