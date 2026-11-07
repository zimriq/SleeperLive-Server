# Historical development notes

[Back to README](../README.md)

These dated notes describe an experiment, not a current deployment recommendation. Verify current configuration before using them.

## Development delivery experiment — November 6, 2026

Start, token replacement, and explicit refresh use priority 10 even with unchanged
scores. Priority 5 is power-aware and Apple may group or delay it; it is unsuitable
for treating a six-minute arrival deadline as guaranteed. `APNS_FRESHNESS_PRIORITY`
accepts 5 (default) or 10. Set 10 on DEVELOPMENT ONLY for the next isolated test.
In that mode, a fresh-data heartbeat is urgent after at least 180 seconds since
the last accepted urgent update (the next poll adds delay). Projection-only pushes
remain low priority between those heartbeats and cannot keep postponing them.
Score changes and ending pushes remain urgent. No stale-window extension or widget
warning suppression is included. Apple may still delay/throttle urgent updates;
this is a bounded development experiment, not a proven fix or delivery guarantee.

Push attempt/result logs now include priority, push timestamp, content timestamp,
stale deadline (attempt), completion time and elapsed seconds (result). This allows
matching payload time against phone receipt time without logging content or tokens.
Remembered invalid-token hashes and loss timestamps are removed on ending as well
as revival/deletion. Existing low-priority records and JSON fields remain readable.
