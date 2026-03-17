# Polymarket Copy Trading Bot

Copies Polymarket trades from a target wallet while preserving the existing detection flow and adding dual execution modes:

- `EOA` mode for the original signer-is-funder flow.
- `PROXY` mode for signer + separate funder/proxy wallet execution.

Trade monitoring stays the same: the bot still watches the target wallet, detects BUY/SELL activity, applies the existing sizing and risk rules, and then places the copy order through the configured execution context.

## What Changed

The original project assumed:

- the signer private key wallet was also the funder wallet,
- signature type was always `0`,
- balance, allowance, and position checks should always hit the signer address.

That works only for plain EOA Polymarket accounts. Many Polymarket accounts instead sign with one wallet and trade from a different proxy/funder wallet. This fork separates those concerns.

## Execution Modes

### EOA mode

- `AUTH_MODE=EOA` or omit `AUTH_MODE` entirely.
- `SIGNER_PRIVATE_KEY` or legacy `PRIVATE_KEY` is both the signer and the funder.
- `SIGNATURE_TYPE` defaults to `0`.
- The bot keeps the original approval behavior and can auto-submit approvals from the EOA.

### PROXY mode

- `AUTH_MODE=PROXY`
- `SIGNER_PRIVATE_KEY` is the wallet used to sign/authenticate with Polymarket.
- `FUNDER_ADDRESS` is the wallet that actually holds collateral, allowances, and positions.
- `SIGNATURE_TYPE` must be set explicitly:
  - `1` = `POLY_PROXY`
  - `2` = `GNOSIS_SAFE`

In proxy mode, the bot:

- signs orders with the signer wallet,
- initializes the authenticated CLOB client with the configured `signatureType` and `funderAddress`,
- checks USDC.e balances against `FUNDER_ADDRESS`,
- checks on-chain allowances against `FUNDER_ADDRESS`,
- fetches sellable positions against `FUNDER_ADDRESS`.

## Prerequisites

- Node.js 18+
- npm
- Polygon RPC URL
- Polymarket access from your region/network
- A signer private key for API auth
- For live trading:
  - EOA mode: the same wallet must hold USDC.e and POL
  - PROXY mode: the proxy/funder wallet must hold USDC.e and the required approvals

## Install

```bash
npm install
cp .env.example .env
```

## Required Environment Variables

Always required:

- `TARGET_WALLET`
- `RPC_URL`
- `SIGNER_PRIVATE_KEY` or legacy `PRIVATE_KEY`

EOA mode:

- `AUTH_MODE=EOA` or omit it
- `SIGNATURE_TYPE` optional, defaults to `0`

PROXY mode:

- `AUTH_MODE=PROXY`
- `SIGNER_PRIVATE_KEY`
- `FUNDER_ADDRESS`
- `SIGNATURE_TYPE=1` or `SIGNATURE_TYPE=2`

Legacy compatibility:

- `PRIVATE_KEY` still works
- `EXECUTION_WALLET_PRIVATE_KEY` is also accepted as an alias
- when `AUTH_MODE` is omitted, the bot behaves like the original EOA-only version

## Example `.env`

### EOA mode

```bash
TARGET_WALLET=0xTARGET_WALLET_TO_COPY
AUTH_MODE=EOA
SIGNER_PRIVATE_KEY=0xYOUR_EOA_PRIVATE_KEY
RPC_URL=https://polygon-rpc.example
SIGNATURE_TYPE=0
COPY_SELLS=true
POSITION_MULTIPLIER=0.1
MAX_TRADE_SIZE=100
ORDER_TYPE=FOK
```

### PROXY mode

```bash
TARGET_WALLET=0xTARGET_WALLET_TO_COPY
AUTH_MODE=PROXY
SIGNER_PRIVATE_KEY=0xYOUR_SIGNER_PRIVATE_KEY
FUNDER_ADDRESS=0xYOUR_PROXY_OR_SAFE_ADDRESS
SIGNATURE_TYPE=2
RPC_URL=https://polygon-rpc.example
COPY_SELLS=true
POSITION_MULTIPLIER=0.1
MAX_TRADE_SIZE=100
ORDER_TYPE=FOK
```

## Signer vs Funder

- `SIGNER_PRIVATE_KEY`: signs CLOB auth and order payloads.
- `FUNDER_ADDRESS`: the account Polymarket uses for collateral, allowances, and positions.

In `EOA` mode these resolve to the same address.
In `PROXY` mode they are intentionally different.

## How To Set `FUNDER_ADDRESS`

Use the Polymarket wallet that actually holds:

- your USDC.e balance,
- the relevant CTF / exchange allowances,
- the positions you expect the bot to sell from.

This is the trading account behind your Polymarket setup, not necessarily the signer EOA. If you are unsure, compare the address that shows USDC.e and positions on Polygon with the address Polymarket trades from.

## API Credentials

The bot derives or creates user CLOB credentials from the signer private key at startup.

Optional helpers:

```bash
npm run generate-api-creds
npm run test-api-creds
```

`test-api-creds` now validates credentials against the configured auth mode, signer, funder, and signature type.

## Run

Start the bot:

```bash
npm start
```

Development watch mode:

```bash
npm run dev
```

Build and run compiled output:

```bash
npm run build
npm run start:prod
```

Run tests:

```bash
npm test
```

## How to run in simulation mode

Use simulation mode when you want to reverse-engineer a target wallet without placing any real orders.

What happens in this mode:

- the bot still detects target wallet trades through REST/WebSocket
- no live `createAndPostOrder` or `createAndPostMarketOrder` call is sent to Polymarket
- every detected target trade is appended to `logs/trades_YYYY-MM-DD.jsonl`
- each JSONL record includes the target trade metadata, crypto spot context from Binance 1m candles, and the current local unrealized PnL snapshot
- if no live signer key is configured, the bot falls back to an ephemeral local signer because simulation mode is read-only

Example:

```bash
SIMULATION_MODE=true
TARGET_WALLET=0x70ec235a31eb35f243e2618d6ea3b5b8962bbb5d
```

Start it:

```bash
npm start
```

Expected output:

- console banner `SIMULATION MODE ACTIVE — no real trades`
- append-only trade logs inside `logs/`
- no real on-chain or CLOB order submission

## Авто-погашення та фіксація прибутку

Бот підтримує фоновий цикл керування вже відкритими позиціями.

Що він робить:

- кожні `REDEEM_INTERVAL_MS` мс перевіряє всі open positions із локального `PositionTracker`
- якщо market уже resolved, викликає `redeem`
- якщо market ще не resolved і `best bid` вищий за `AUTO_SELL_THRESHOLD`, продає всю tracked position

Як увімкнути:

```bash
AUTO_REDEEM=true
AUTO_SELL_THRESHOLD=0.92
REDEEM_INTERVAL_MS=30000
```

Нотатки:

- background task стартує через `trader.startAutoRedeemAndSell()`
- у поточній реалізації auto-redeem працює напряму on-chain через `redeemPositions`
- для `PROXY` mode auto-sell продовжує працювати, але auto-redeem потребує прямого контролю над funder wallet, який реально тримає позиції
- у логах ти побачиш повідомлення на кшталт `Auto-redeem executed +$X.XX` або `Auto-sold winning position at 0.94`

## Startup Logging

At startup the bot prints:

- auth mode
- signer address
- funder address
- signature type
- balance check address
- allowance check address

This makes it obvious which execution context is active before the bot starts placing orders.

## Approvals

EOA mode:

- the bot keeps the original auto-approval flow for USDC.e and CTF approvals.

PROXY mode:

- the bot does not try to submit approval transactions from the signer for the funder,
- it logs the current funder balance and approval state instead,
- buy/sell validation still checks the funder/proxy address correctly.

That behavior is intentional: a signer private key cannot safely approve tokens on behalf of a different wallet address.

## Troubleshooting

### `balance 0.0`

If you see a balance error in proxy mode:

- confirm `AUTH_MODE=PROXY`,
- confirm `FUNDER_ADDRESS` is the wallet holding USDC.e,
- check the startup log and verify the `Balance check address` matches the expected funder address.

### Allowance failures

If you see allowance errors:

- confirm the logged checked address is the correct funder,
- verify USDC.e allowance exists for CTF and the relevant exchange contract,
- in proxy mode, set those approvals on the funder/proxy account before running the bot.

### Wrong funder address

Symptoms:

- BUY orders fail even though your signer looks correct,
- SELL checks report zero positions,
- startup logs show a funder address that does not match your funded account.

Fix the `FUNDER_ADDRESS` value and restart.

### Signature type mismatch

Symptoms:

- API credential validation fails,
- order posting fails despite correct signer and funder,
- Polymarket rejects auth unexpectedly.

Set `SIGNATURE_TYPE` to the mode that matches your Polymarket account:

- `0` for EOA
- `1` for POLY_PROXY
- `2` for GNOSIS_SAFE

The bot intentionally requires an explicit `SIGNATURE_TYPE` in `PROXY` mode so it never guesses the wrong proxy auth flow.

### `invalid user provided fee rate`

Some Polymarket markets are fee-enabled and reject orders that send `feeRateBps=0`.

This bot now fetches `feeRateBps` dynamically per token/market before signing and posting each order. If you still see this error:

- update to the latest code from this fork,
- restart the bot so it uses the patched order flow,
- check the runtime logs for the printed `Fee rate bps` value on the failing order.

## Notes

- Trade detection logic is unchanged.
- REST polling and WebSocket monitoring are still supported.
- The bot starts copying only trades that occur after startup.
- If WebSocket auth is enabled with `USE_USER_CHANNEL=true`, the bot uses the same generated user credentials from the configured signer.

## Security

- Never commit `.env`
- Use a dedicated signer wallet when possible
- Start with small limits
- Double-check signer/funder logs before enabling live trading
