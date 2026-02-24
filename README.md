# Mythic Supply Oracle

Real-time MYTH token supply tracking API. Reads on-chain mint supply, tracks burn events, computes circulating supply, and serves canonical supply data for CoinGecko/CMC integration.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /supply` | Total supply (raw number) |
| `GET /circulating` | Circulating supply (raw number) |
| `GET /api/supply` | Full supply breakdown (JSON) |
| `GET /api/supply/stats` | Supply statistics with burn tracking |
| `GET /api/supply/validators` | Validator-staked supply |
| `GET /api/supply/history` | Historical supply snapshots |
| `GET /api/v1/supply` | CoinGecko-compatible format |

## Supply Model

- **Max Supply**: 1,000,000,000 MYTH (1 billion)
- **Decimals**: 6
- **Burn Mechanism**: 40% of all protocol fees are burned permanently via `spl_token::burn`
- **Fee Split**: 50% validators / 10% foundation / 40% burn

## How Parity Works

The oracle reads the on-chain mint supply from the MYTH token mint account (`7sfazeMxmuoDkuU5fHkDGin8uYuaTkZrRSwJM1CHXvDq`) and reconciles it against the canonical 1B max supply. Burned tokens are subtracted from total supply in real time.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `RPC_URL` | Mythic L2 RPC endpoint |
| `MYTH_MINT` | MYTH token mint address |
| `PORT` | Server port (default: 4002) |

## Setup

```bash
npm install
cp .env.example .env
npm start
```

## License

Proprietary - Mythic Labs
