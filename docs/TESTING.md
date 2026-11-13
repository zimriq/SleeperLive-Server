# Testing

[Back to README](../README.md)

## Local checks and GitHub Actions

Use Node.js 24.22.3, matching the Docker image and CI.

```bash
npm ci
npm run lint
npm test
npm audit --audit-level=high
```

The [Server tests workflow](../.github/workflows/server-tests.yml) runs on pushes
and pull requests targeting `main` or `develop`, and on manual dispatch.
Check the [GitHub Actions runs](https://github.com/zimriq/SleeperLive-Server/actions/workflows/server-tests.yml)
for results by commit. The audit reports known vulnerabilities and fails on high
or critical findings.

The suite covers enrollment and authentication, activity ownership, rate limits,
SQLite persistence, retries, token recovery, push batching, shutdown, deletion,
and backups. The [iPhone app](https://github.com/zimriq/SleeperLive) has separate
simulator checks. Use a signed iPhone on the development server to verify App
Attest and real push delivery before a coordinated release.

## Load and storage benchmarks

- `npm run test:load` runs idle, shared-league, twelve-league, and outage
  scenarios. Active scenarios simulate 360 cycles of 75 seconds with 12 devices.
  Results are written to `data/load-test-results.json`.
- `npm run test:load -- --scale` prints JSON for 100 and 300 devices over 20
  cycles across 12 leagues. Both API and simulated push counts are checked.
- `node scripts/benchmark-store.mjs` measures SQLite and poller costs at 100,
  300, and 1,000 activities with an instant simulated push transport.

These local runs use temporary databases and simulated Sleeper feeds and APNs.
They measure accelerated workloads. Local timing includes the HTTP load
generator and excludes real network latency, push throttling, and Railway load.

### Historical measurements (October 21, 2026)

[Archived results](load-test-results-2026-10-21.json) from the original 12-device run.

- Idle: mean resident memory 59.6 MiB, peak 59.7 MiB; 0.072 CPU seconds over 10 wall-clock seconds.
- Shared league: mean 160.5 MiB, peak 191.3 MiB; 1.134 CPU seconds for 360 cycles. 4,344 HTTP requests, no errors, 4,320 simulated push attempts, 635 simulated upstream fetches. Local HTTP p95 2.88 ms.
- Twelve leagues: mean 161.5 MiB, peak 188.9 MiB; 1.319 CPU seconds for 360 cycles. 4,344 HTTP requests, no errors, 4,320 simulated push attempts, 7,608 simulated upstream fetches. Local HTTP p95 3.32 ms.
- Outages: mean 161.9 MiB, peak 189.9 MiB. Five consecutive polling cycles failed upstream; exactly 60 foreground requests returned expected errors. Every tenth simulated push failed (426 failures). All 12 registrations remained active and resumed successful sends. No unexpected HTTP failures.
- Database plus SQLite WAL/SHM files: approximately 4.01 MiB at the end of each active run. This is an end-of-run footprint, not indefinite growth of 4 MiB per session. This test does not characterize long-term device-record retention or backups.

The 12-league scenario modeled 10.1 MB of outbound traffic from serialized
push and API bodies, simulated upstream requests, and fixed header allowances.
Use measured Railway traffic for budgeting.
