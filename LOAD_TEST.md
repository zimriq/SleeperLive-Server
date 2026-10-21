# Twelve-user load test and hosting estimate

Run: `npm run test:load`. Raw results: `load-test-results.json`.

## Outcome — October 21, 2026

The local test supports trying one small Railway service for 12 users. A $5/month Hobby bill is plausible for the current scores-only configuration; this is not a measured Railway bill or a guarantee of a $10 ceiling.

Four separate Node processes were tested: idle, 12 users sharing a league, 12 users in separate leagues, and separate leagues with failures. Active scenarios each advanced a simulated clock through 360 polling cycles (7.5 hours at 75 seconds/cycle), with every user refreshing through the real authenticated HTTP API every cycle and every score changing. The real caching, matchup calculation, poller, ownership checks, and disk-backed SQLite transaction code ran. The HTTP load generator ran inside the measured process, so its overhead is included.

This is an accelerated workload, NOT a 7.5-hour wall-clock soak. Each active run finished in about 1.4–1.6 seconds; this does not measure real internet latency, a full game's memory behavior, or phone delivery. The idle baseline lasted 10 seconds and includes a frequent measurement timer.

## Measurements

- Idle: mean resident memory 59.6 MiB, peak 59.7 MiB; 0.072 CPU seconds over 10 wall-clock seconds.
- Shared league: mean 160.5 MiB, peak 191.3 MiB; 1.134 CPU seconds for 360 cycles. 4,344 HTTP requests, no errors, 4,320 simulated push attempts, 635 simulated upstream fetches. Local HTTP p95 2.88 ms.
- Twelve leagues: mean 161.5 MiB, peak 188.9 MiB; 1.319 CPU seconds for 360 cycles. 4,344 HTTP requests, no errors, 4,320 simulated push attempts, 7,608 simulated upstream fetches. Local HTTP p95 3.32 ms.
- Outages: mean 161.9 MiB, peak 189.9 MiB. Five consecutive polling cycles failed upstream; exactly 60 foreground requests returned expected errors. Every tenth simulated push failed (426 failures). All 12 registrations remained active and resumed successful sends. No unexpected HTTP failures.
- Database plus SQLite WAL/SHM files: approximately 4.01 MiB at the end of each active run. This is an end-of-run footprint, not indefinite growth of 4 MiB per session. This test does not characterize long-term device-record retention or backups.

The 12-league scenario's modeled outbound bytes were 10.1 MB for the simulated 7.5 hours. This counts serialized push/API response bodies, synthetic upstream request sizes, and fixed header allowances. It is NOT packet-level network measurement; no TLS handshakes, compression, real header sizes, or retransmissions were captured. Extrapolation to 80 active hours/month is about 108 MB; 720 continuously active hours would be about 971 MB. Use a larger allowance in budgeting.

No real APNs keys, tokens, invitations, or production databases are read by the harness. Push delivery and Sleeper responses are mocked; projections are disabled. No phone notification is sent. Temporary databases are removed after each scenario.

## Monthly cost model

Railway container rates checked October 21, 2026: approximately $10/GB-month RAM, $20/vCPU-month, $0.15/GB-month volume, and $0.05/GB outbound. Hobby includes $5 of usage: total before tax is max($5, resource usage), not $5 plus all usage. These are container rates, not Railway VM/sandbox rates.

The following are explicit planning assumptions, NOT measured Railway allocations. Both assume the service stays up for the entire 30-day month, so idle memory is billed too.

- Baseline allowance: 0.20 GB average RAM ($2), 0.01 average vCPU ($0.20), 0.5 GB volume ($0.075), 1 GB outbound ($0.05). Resource subtotal about $2.33; Hobby total about **$5/month before tax**.
- Larger allowance: 0.50 GB average RAM ($5), 0.10 average vCPU ($2), 1 GB volume ($0.15), 5 GB outbound ($0.25). Subtotal and Hobby total about **$7.40/month before tax**.
- Over-budget example: 0.75 GB average RAM ($7.50), 0.15 average vCPU ($3), 1 GB volume and 5 GB outbound ($0.40). About **$10.90/month before tax**. More memory/CPU or other services can break the desired ceiling.

CPU allowances above deliberately exceed the short synthetic workload's normalized CPU use. Do not divide accelerated CPU seconds by its wall time and assume that utilization persists all month. Likewise, do not treat these synthetic CPU numbers as Linux container measurements. The test excludes actual HTTPS/APNs connections and projection feeds; enabling experimental projections requires another test, especially their cached player dataset.

## Before paying for hosting

1. Use Railway's available trial, one replica, a persistent SQLite volume, and no extra database service. Do not use auto-sleep for the polling worker.
2. Run the real workload on Railway for 24–48 hours, including an active game window. Inspect billed memory/CPU/egress/storage and include any other workspace services or backups.
3. Configure a Compute Usage hard limit and warning below the desired ceiling; leave room for taxes and check the account's actual billing terms. A hard limit takes workloads offline when reached, so protecting spend trades off uninterrupted updates. No spending controls have been configured by this local test.
4. Start with score-only operation. Re-measure before enabling experimental projections, increasing users, or adding replicas.

Sources:
- https://railway.com/pricing
- https://docs.railway.com/pricing/plans
- https://docs.railway.com/pricing/cost-control

Still separate work: implement high-priority score-change delivery and validate Apple's real device delivery budget. This benchmark does not establish APNs timing or reliability.
