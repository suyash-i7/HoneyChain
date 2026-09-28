# HoneyChain

Local SIH26021 foundation for apiary records, sensor ingestion, harvest traceability and blockchain verification.

Network: http://10.12.1.105:5173/

## Run

```powershell
npm install
npm run dev
```

Open http://localhost:5173. The first launch creates an ignored `.env`, prepares SQLite, starts a local Hardhat chain, deploys the batch registry and starts the API. Register a beekeeper, add a hive, sample sensor data, then record a harvest. Use the batch QR action to open its public provenance page. Stop all services with `Ctrl+C`.

## Checks

```powershell
npm run build
npm test
npm run chain:compile
```

The API health endpoint is http://localhost:3001/api/health. `DATABASE_URL`, API/UI ports and local-chain settings can be changed in `.env`; `.env.example` lists the variables.

To enable laboratory review, set `BOOTSTRAP_VERIFIER_NAME`, `BOOTSTRAP_VERIFIER_EMAIL` and a 12+ character `BOOTSTRAP_VERIFIER_PASSWORD` in `.env`, then run `npm run users:bootstrap`. The verifier signs in through the same screen; beekeepers move their batches from `CREATED` to `PROCESSING` and then submit them for review.

AI is represented by an interface only. Sensor values are simulated or manually submitted; no physical devices are required. Blockchain anchoring runs against the local Hardhat test chain. Verifier/admin operations and production deployment are not part of this foundation yet.