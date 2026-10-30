import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// One small, transactional document is sufficient for this single-instance service.
// No async work may run inside change(): limit checks and writes remain atomic.
export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
    INSERT OR IGNORE INTO state VALUES (1, '{"devices":{},"activities":{}}');`);
  const read = db.prepare('SELECT value FROM state WHERE id=1');
  const write = db.prepare('UPDATE state SET value=? WHERE id=1');
  const index = state => {
    const entries=Object.entries(state.devices).filter(([,device])=>!device.revoked);
    if(entries.length>1000)throw Error('Active device index capacity exceeded');
    return new Map(entries.map(([id,device])=>[id,device.hash]));
  };
  let credentials=index(JSON.parse(read.get().value));
  return {
    credentialHash: id => credentials.get(id),
    read: () => JSON.parse(read.get().value),
    change(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const state = JSON.parse(read.get().value);
        const result = fn(state);
        if (result instanceof Promise) throw new Error('Transactions must be synchronous');
        const nextCredentials=index(state);
        write.run(JSON.stringify(state)); db.exec('COMMIT');
        credentials=nextCredentials;return result;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    close: () => db.close(),
  };
}
