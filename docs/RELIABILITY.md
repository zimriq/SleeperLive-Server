# Reliability and safeguards

[Back to README](../README.md)

## Estimates

Off by default. Set `ENABLE_ESTIMATES=true` only for evaluation. UI must label values
**Est.**, not official Sleeper/Yahoo projections. Source: undocumented Sleeper weekly
projection feed plus undocumented ESPN game status; Sleeper players data maps bye
players to teams. Responses were checked on October 13, 2026, but may change.

For offensive players/kickers: actual team points plus each unfinished starter's
pregame projected points multiplied by remaining regulation game time. D/ST uses a
blend of its actual points and pregame projection to avoid double-counting starting
points-allowed credit. Explicit scoreboard byes have no remaining contribution.
Final teams use actual points. League scoring weights apply to supported stats.
Unknown scoring keys (including yardage bonus rules), missing data, suspended games,
or overtime produce `null`, never a fake zero or a partial team total.

This is a rough time-based estimate, not a calibrated prediction. Injuries, game
script, possession, delayed stats, current-team metadata for old weeks, sparse feed
stats and defensive scoring buckets limit accuracy. Projection feed revisions may
also change the baseline. Do not present it as injury-aware or promise Yahoo parity.
Real-game testing has been reported successful, but does not establish prediction
accuracy. Feed failure hides projections while actual scores keep updating.

Projection feed failures or invalid responses trigger a shared 60-second retry
cooldown, starting when all requests in the failed batch settle. During that time,
requests needing new feed data return unavailable estimates without fetching again;
a still-fresh cached snapshot can continue serving its matching season/week.
Expired estimates are not reused. Only one feed batch runs at a time, and the
cooldown applies across leagues and weeks to prevent repeated failed fetches.
The next request after the cooldown can retry automatically; no background retry
is scheduled. Actual scores remain available even when estimates are unavailable.
The cooldown is in memory and resets if the process restarts.

## Incoming HTTP safeguards

The HTTP listener accepts at most 16 KiB of request headers, allows 15 seconds to
receive headers and 30 seconds to receive the entire request, and checks stalled
connections every second. Oversized headers receive 431; expired uploads receive
408 and the connection closes. Deadline enforcement may lag by the check interval
and event-loop scheduling. Idle keep-alive connections close after five seconds.
These are request-receiving limits, not deadlines for computing a response after
an upload completes. Existing 8 KiB JSON and 32 KiB attestation body limits remain.
The socket tests exercise the actual production header and upload deadlines.

## Upstream response safeguards

Sleeper and projection HTTP requests retain a 12-second timeout. JSON response
bodies are limited to 8 MiB of streamed bytes, except the exact Sleeper all-player
catalog endpoint, which allows 32 MiB. Limits apply to the decoded fetch body;
Content-Length is not trusted. Oversized responses are cancelled before JSON
parsing; HTTP error bodies are cancelled without parsing. Malformed or interrupted
responses fail normally, allowing existing score-retention and estimate-cooldown
behavior to apply. These are body-size limits, not total process-memory limits:
JSON parsing and cached objects require additional memory. If a legitimate feed
outgrows its limit, inspect its size and adjust deliberately.

## Reliability and limits

- Poll interval is 60–90 seconds (75 default), measured after each run finishes.
  Requests and Apple delivery add delay. Polling runs for active activities, even
  before kickoff; no active activities means no Sleeper polling.
- Scores push on change. Unchanged healthy data gets a heartbeat after 180 seconds;
  stale-date is the score fetch time + 360 seconds. Show stale state in the widget.
- Actual score changes (either team, including corrections) use priority 10.
  Projection-only changes use priority 5. Initial/recovery pushes use 10.
  Unchanged-score heartbeats default to 5; end pushes use 10. No alerts/sounds. Failed sends do not
  advance the accepted-score baseline. iOS delivery budgets still apply.
- APNs 410 Unregistered or ExpiredToken clears the invalid token and pauses the
  activity in `awaiting_token`. A different token or environment can resume the same activity,
  before its original eight-hour expiry. Waiting registrations still count toward
  activity limits; deletion and expiry cannot be revived. A hash of the invalid
  token prevents reusing it without retaining the token itself.
- Other push failures back off up to 15 minutes. Token rotation or an authenticated
  registration with `refresh: true` resets backoff and queues fresh delivery on
  the next poll. Ordinary registration retries remain idempotent. Late responses
  cannot override a replacement token or explicit refresh.
- Registration and push-result logs identify activities, status/reason, retry time,
  and failures without printing credentials or push tokens. Apple acceptance is
  not confirmation that the phone displayed the update.
- End locally in the app, then DELETE the registration. Server also expires it eight
  hours after its actual start. A Sunday activity must be restarted for Monday.
- No automatic game-final ending yet. Final scores may receive heartbeat pushes
  until expiry or the user ends the activity.
- Once sent, the network may still deliver a push after the user ends locally;
  the server prevents subsequent work for ended activities.
- At-least-once retry: a crash between Apple accepting a push and the database
  committing can cause a repeated update. Exactly-once delivery is not claimed.
- Polling is single-flight; identity checks/caps are transactional.
  Each tick processes activities with up to `APNS_MAX_CONCURRENT_SENDS` workers
  (default 4, allowed 1–16). Workers include feed lookup and snapshot preparation,
  so simultaneous APNs sends never exceed that bound. A slow send occupies one
  slot; it does not stop the other slots. League/week data is fetched once per tick.
  Queued activities are rechecked before sending; shutdown waits for active workers.
  This changes processing concurrency, not polling frequency or Apple's delivery
  budgets. Raising the limit needs load testing and can increase upstream concurrency. Late responses
  from a superseded token cannot mark its replacement invalid.
- Automatic App Attest enrollment is implemented; legacy invite enrollment is disabled by default when App Attest
  is enabled. App Attest verifies app/device integrity, not ownership of a
  Sleeper username. Security hardening is still in progress.

## Request protection

Before parsing API bodies, `/v1` requests are classified using a fixed-size bearer
credential check against an in-memory index of committed active devices. Unknown
IDs and wrong secrets never trigger a database read or create cache entries.
Enrollment routes always use the anonymous budget, even with a valid bearer token.
The credential index contains only IDs and hashes, is limited to 1,000 active
devices, updates after successful commits, and rebuilds at startup. Revocation
removes a credential immediately after commit. This relies on a single process
owning database writes; external writers are not supported.

Anonymous and authenticated requests have **independent** fixed-window allowances.
Each defaults to 400 requests per IP and 1,200 total per minute, configured through
`API_REQUESTS_PER_IP_PER_MINUTE` and `API_REQUESTS_PER_MINUTE`. Thus the combined
admission ceiling defaults to 2,400 per minute, with 1,200 reserved for authenticated
traffic. Rejected anonymous requests cannot spend that reservation. Credential
classification still runs for incoming requests, so this is not network-level flood
protection. One compromised valid device remains subject to its 30/minute budget.

Both settings must be integers from 1 to 10,000, with IP <= total; invalid settings
stop startup. Each IP map is bounded by its own admission budget and resets each
minute. Changes take effect on restart. These are request budgets, not user caps.
Downstream enrollment, device, and upstream-fetch limits apply independently.
Requests rejected by the per-device limit do not consume the shared authenticated
IP or global allowance. Accepted requests still count toward both shared ceilings.
429 responses include `Retry-After`; the ingress rejection also uses `no-store`.
`/health` remains outside these budgets.

`GET /health` returns `ok` and the APNs `mode` with
`Cache-Control: no-store`. When more than three poll intervals pass without a
completed tick, including the startup grace period, it returns 503 with `ok: false`. A tick can
complete during an upstream outage, so check the push and upstream logs when
diagnosing score delivery. The health route uses in-memory poller state.

The downstream counters reserve separate capacity: 1,000 authenticated-device
counters, 3,998 enrollment IP counters (shared by private and App Attest enrollment),
and two fixed global counters. Total capacity remains 5,000. Enrollment IP churn
cannot consume the slots reserved for authenticated devices or global budgets.
The device reservation matches the maximum supported `MAX_DEVICES` setting.
These are counter capacities, not a change to configured registration caps.

Cleanup removes expired entries in oldest-first order and stops at the first
unexpired entry. Counters expire 60 seconds after creation; hits do not extend the
window. At capacity, a category rejects new keys while existing counters retain
their budgets. Backward clock adjustments cannot reset counters early, though they
can lengthen the wait. Shared IP and global request limits still apply: reserving
counter capacity does not guarantee availability during sustained abuse.

These limits include legitimate requests and can temporarily affect users sharing
an IP or the entire service during sustained abuse. They reset on process restart,
are per instance, and are not a distributed denial-of-service defense. `CLIENT_IP_MODE=direct` (default) uses the connection peer and ignores forwarded
headers. `railway-public` uses exactly one valid `X-Real-IP` supplied by Railway's
HTTP edge; missing, duplicate, or malformed values fail with 400. IPv6 spelling
variants and IPv4-mapped IPv6 addresses are normalized. Express proxy trust is off.
Railway mode requires the listener to be reached only through the public HTTP edge
or by trusted operators. It does not authenticate the edge: private-network callers
and TCP/direct access can forge the header and must not be exposed to untrusted
callers. Hostnames and other caller-supplied headers cannot establish that boundary.
Do not enable this mode until the service's ingress paths have been checked. Local
tests simulate sanitized headers; live Railway spoofing verification remains open.
Sources: [Railway specs](https://docs.railway.com/networking/public-networking/specs-and-limits)
and [staff clarification](https://station.railway.com/questions/need-authoritative-client-ip-proxy-tru-090eac86). Rotating IPs (including IPv6 addresses) share the global
budget but are not grouped by subnet.
