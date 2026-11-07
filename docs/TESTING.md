# Testing

[Back to README](../README.md)

## Automated testing with GitHub Actions

The [Server tests workflow](../.github/workflows/server-tests.yml) installs locked dependencies with `npm ci` and runs `npm test` on an Ubuntu runner using **Node.js 24**, matching the supported production runtime major version. It runs on pushes to `main` and `develop`, pull requests targeting `main`, and manual dispatches.

Check [server Actions runs](https://github.com/zimriq/SleeperLive-Server/actions/workflows/server-tests.yml) for the current branch, commit, logs, and pass/fail result. This workflow runs tests only; it does not deploy or require production APNs credentials.

The suite covers authentication and enrollment, ownership and capacity limits, persistence, token rotation, retry and manual-refresh recovery, concurrent push workers, upstream failures, deletion, and backups. Tests use isolated fixtures and simulated external services. A local sweep on November 7, 2026 passed 101 tests; this is distinct from a confirmed GitHub-hosted run.

The twelve-user load simulation is a separate command, `npm run test:load`; it is not part of the automatic workflow. See **Testing** below for its scenarios and limits. Neither the automated suite nor the simulation proves real Apple push delivery or production capacity.

The companion [iPhone app](https://github.com/zimriq/SleeperLive) also has an Xcode 27 simulator build-and-test workflow. App and server checks validate different parts of the integration and should both pass before a coordinated release.

## Testing

Run `npm test` for the server regression suite. It covers authentication, activity
ownership and rotation, polling/retries, enrollment/replay, and compressed-body
rejection. General JSON bodies are limited to 8 KiB; enrollment bodies to 32 KiB.
Both parsers reject compressed request bodies. Mocked tests do not prove Apple
acceptance, device delivery timing, or immunity to all attacks.

Run `npm run test:load` for the synthetic twelve-user benchmark; results are written
to `load-test-results.json`. The measurements below are historical, not a fresh run
or a capacity guarantee for the current code.

Four separate Node processes were tested: idle, 12 users sharing a league, 12 users in separate leagues, and separate leagues with failures. Active scenarios each advanced a simulated clock through 360 polling cycles (7.5 hours at 75 seconds/cycle), with every user refreshing through the real authenticated HTTP API every cycle and every score changing. The real caching, matchup calculation, poller, ownership checks, and disk-backed SQLite transaction code ran. The HTTP load generator ran inside the measured process, so its overhead is included.

This is an accelerated workload, NOT a 7.5-hour wall-clock soak. Each active run finished in about 1.4–1.6 seconds; this does not measure real internet latency, a full game's memory behavior, or phone delivery. The idle baseline lasted 10 seconds and includes a frequent measurement timer.

### Historical measurements (October 21, 2026)

- Idle: mean resident memory 59.6 MiB, peak 59.7 MiB; 0.072 CPU seconds over 10 wall-clock seconds.
- Shared league: mean 160.5 MiB, peak 191.3 MiB; 1.134 CPU seconds for 360 cycles. 4,344 HTTP requests, no errors, 4,320 simulated push attempts, 635 simulated upstream fetches. Local HTTP p95 2.88 ms.
- Twelve leagues: mean 161.5 MiB, peak 188.9 MiB; 1.319 CPU seconds for 360 cycles. 4,344 HTTP requests, no errors, 4,320 simulated push attempts, 7,608 simulated upstream fetches. Local HTTP p95 3.32 ms.
- Outages: mean 161.9 MiB, peak 189.9 MiB. Five consecutive polling cycles failed upstream; exactly 60 foreground requests returned expected errors. Every tenth simulated push failed (426 failures). All 12 registrations remained active and resumed successful sends. No unexpected HTTP failures.
- Database plus SQLite WAL/SHM files: approximately 4.01 MiB at the end of each active run. This is an end-of-run footprint, not indefinite growth of 4 MiB per session. This test does not characterize long-term device-record retention or backups.

The 12-league scenario's modeled outbound bytes were 10.1 MB for the simulated 7.5 hours. This counts serialized push/API response bodies, synthetic upstream request sizes, and fixed header allowances. It is NOT packet-level network measurement; no TLS handshakes, compression, real header sizes, or retransmissions were captured. Extrapolation to 80 active hours/month is about 108 MB; 720 continuously active hours would be about 971 MB. Use a larger allowance in budgeting.

No real APNs keys, tokens, invitations, or production databases are read by the harness. Push delivery and Sleeper responses are mocked; projections are disabled. No phone notification is sent. Temporary databases are removed after each scenario.
