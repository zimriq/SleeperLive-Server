# Server operations

[Back to README](../README.md)

## Storage and backups

SQLite stores device credential hashes and activity registrations. This design
supports a single server instance; separate instances with separate databases do
not share state. Keep the database and its backups private.

`npm run backup` creates a consistent online SQLite backup, defaulting to
`data/backups`. It is a manual command, not an automatic schedule. The source
must already exist. Each copy is checked with SQLite quick_check and published
without overwriting an existing filename, with permissions limited to its owner.
Keep recovery copies separately and test restores with the server stopped.

### Optional retention for tool-created backups

Retention is disabled unless you explicitly set `BACKUP_RETENTION_DAYS` to an
integer from 1 through 365. For example, choosing `7` means a successful backup
run can remove eligible tool-created copies older than seven days. This is a
configuration example, not an applied production policy. Unset the variable to
keep all existing copies; `0`, empty values, fractions, and invalid values fail
before cleanup. `BACKUP_DIR` selects the directory managed by this command.

Cleanup happens only after a new valid backup has been published. It considers
only regular files with this tool's exact UTC timestamp filename and requires
both the filename timestamp and file modification time to be older than the
cutoff. The new backup, live database (including hard links), symlinks, directories,
invalid date names, and custom-named copies are preserved. If backup creation
fails, no retention cleanup runs. If cleanup itself fails, the command reports
failure, but the newly written valid backup may already exist. Abandoned partial
files after a process crash are not auto-deleted.

This does not configure a schedule, Railway volume-backup retention, off-site
copies, hosting logs, or support-email retention. Old copies are cleaned only
when this command successfully runs; seven days is not a guaranteed wall-clock
deletion deadline if runs are missed or copies are moved/renamed. Do not claim a
production retention period in the privacy policy until the actual configuration
and schedule are verified. Restoring an older backup also requires reconciling
user deletion requests before serving traffic, so deleted device data is not
silently restored. No real backup cleanup was run while developing this feature.

## Device revocation

Users can revoke their current credential through authenticated
`DELETE /v1/devices/me`. Operators can revoke a credential from the service
container using its existing `DB_PATH`:

```bash
npm run revoke-device -- --live <32-character-device-id>
```

Use `--live` after deploying a server version that refreshes its credential
index when another SQLite connection commits. The next authenticated lookup
then rejects the old credential. The poller handles queued end pushes on its
next tick. Use `--server-stopped` with older server versions or when operating
on a stopped instance. Keep the database and device credentials private.

Revocation retains the device/attestation-key record to block key reuse, and queues
owned active Live Activities for end pushes. Apple acceptance and delivery to
the phone are separate events.
Other devices are unaffected. Repeated revocation is safe. This revokes one device
credential, not a Sleeper username or a person's ability to enroll a different key.
No public administration endpoint or automatic device-record deletion is introduced.

Every successful storage transaction removes the bearer credential hash and stored
attestation public key from revoked records. This includes older revoked records
on the next normal write (such as poller housekeeping). Active device records are
unchanged. Revoked device IDs, attestation key IDs, and revocation flags remain to
prevent key reuse; pending activity end tokens remain until their lifecycle finishes.
This is logical data minimization, not secure erasure: older SQLite pages, WAL files,
and backups can retain previous values. The poller reports daily counts of non-revoked devices idle for at least 60 days
with no non-ended activities. The report is observational. Reclamation remains
a separate rollout decision.

## User-initiated device-data deletion

`DELETE /v1/devices/me/data`, authenticated with the current device bearer credential,
transactionally removes that device record (including App Attest identifiers and keys)
and all of its active/ending/ended activity records from the current logical database.
The committed credential index immediately rejects the old credential. Other devices
are untouched. The activity-registration transaction rechecks that the device still
exists after asynchronous upstream work, preventing a late request from recreating data.
The iOS client ends local activities before requesting deletion; the server does not
retain deleted push tokens to send further end notifications. An already in-flight push
may still finish, but its response cannot recreate a removed activity.

Deploy this server change before distributing the matching iOS client. The old
`DELETE /v1/devices/me` remains access revocation with replay protection, not erasure.
The new route does not retain a replay-blocking device/attestation tombstone. Future
fresh device enrollment remains possible. Completed enrollment challenges cannot
recreate a deleted device using their cached response, because completion verifies the
record still exists. Unfinished challenges have a five-minute in-memory lifetime.

This is logical deletion, not secure physical erasure of historical SQLite pages/WAL,
Railway logs, support mail, or backups. Backup/log retention and restoration procedures
still need a defined policy; restoring an older backup can restore deleted data and
requires reconciling deletion requests before serving traffic. No backup purge or
production database deletion is performed by this change. Do not claim complete erasure
from all systems or a retention deadline until those operational details are settled.
A lost successful HTTP response can leave the client unable to confirm deletion: it
must not interpret a later 401 (which might also mean revocation) as proof of erasure.
