# HoneyChain

Local SIH26021 foundation for apiary records, sensor ingestion, harvest traceability and blockchain verification.

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

AI is represented by an interface only. Sensor values are simulated or manually submitted; no physical devices are required. Blockchain anchoring runs against the local Hardhat test chain. Verifier/admin operations and production deployment are not part of this foundation yet.