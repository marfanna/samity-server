# samity-server

Express + TypeScript API for Samity. **Record-keeper, not a bank** — no payment gateway; cash is offline (bank transfer + screenshot). All money is integer paisa. **No Redis** — locks / OTP / blacklist / rate-limits run on Mongo TTL collections.

## Run

```bash
cp .env.example .env        # fill MONGO_URI + JWT secrets
npm install
npm run dev                 # boots, verifies Mongo txns, syncs TTL indexes, serves :4000
curl http://localhost:4000/api/health
```

Generate JWT secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## Layout (Phase 01 scaffold)

```
src/
  server.ts                 boot: connectDb -> dbInit -> listen
  app.ts                    express app (helmet, cors, json, rate limit, routes, errors)
  config/
    env.ts                  zod-validated environment (fail-fast)
    db.ts                   mongoose connect + transaction/replica-set verification
    dbInit.ts               explicit index creation (autoIndex off)
  app/
    routes/index.ts         /api router (health now; modules mount here in Phase 03+)
    modules/_infra/         TTL collections that replace Redis:
                            lock, otp, tokenBlacklist, refreshToken, rateLimit
  middleware/               errorHandler, notFound  (authGuard + fundRole = Phase 03)
  shared/
    money.ts                paisa helpers + largest-remainder split
    fundLock.ts             per-fund Mongo advisory lock (withFundLock)
  utils/                    ApiError, catchAsync, sendResponse
```

## Next (per context/build-plan.md)

- **02** Schema — domain collections (users, funds, memberships, deposits, ledgerEntries, navSnapshots, …) + indexes, registered in `dbInit`.
- **03** Core API — auth (OTP via `otps`, JWT + refresh rotation, blacklist on logout), `authGuard`, per-fund `fundRole` resolver, `shared/nav.ts` + `shared/ledger.ts`.
- **08** Money engine — test-first: paisa math + concurrency (double-verify, simultaneous buy-in + transfer) before any screen trusts it.

## Invariants (never violate)

Ledger is truth · NAV derived, never stored · integer paisa only · per-fund Mongo lock + transaction + compare-and-set on every money mutation · self-deal guard · append-only audit. See `../../context/architecture.md`.
