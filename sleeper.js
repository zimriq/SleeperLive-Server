import { createRateLimiter } from './rate-limit.js';
const ROOT = 'https://api.sleeper.app/v1';
export async function getJSON(url, {fetchImpl=fetch} = {}) {
  // The all-player catalog is substantially larger than league or weekly feeds.
  const maxBytes=url === `${ROOT}/players/nfl` ? 32*1024*1024 : 8*1024*1024;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) {
    await res.body?.cancel().catch(()=>{});
    throw new Error(`Upstream status ${res.status}`);
  }
  if (!res.body) throw new Error('Missing upstream body');
  const reader=res.body.getReader(), chunks=[];
  let size=0, complete=false;
  try {
    while(true){
      const {done,value}=await reader.read();
      if(done){complete=true;break;}
      size+=value.byteLength;
      // Count decoded stream bytes, not Content-Length (which may be absent or compressed).
      if(size>maxBytes)throw new Error('Upstream response too large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
  } finally {
    if(!complete)await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
export function createSleeper(load = getJSON, now = Date.now, {onFetch, maxActivities=100} = {}) {
  if (!Number.isInteger(maxActivities) || maxActivities<1 || maxActivities>1000)
    throw new Error('Invalid cache maxActivities');
  // One matchup and one metadata entry per activity, plus room for browsing.
  const maxEntries=maxActivities*2+100;
  const limit = createRateLimiter(now,1);
  const beforeFetch = onFetch ?? (() => {
    try { limit('global:upstream',60); }
    catch (error) { error.code='UPSTREAM_RATE_LIMITED'; throw error; }
  });
  // Charge each physical request, including all three metadata endpoints.
  const fetchJSON = async url => { beforeFetch(); return load(url); };
  const cache = new Map(), pending = new Map();
  async function memo(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit) {
      // Refresh recency without extending freshness or changing score timestamps.
      cache.delete(key); cache.set(key,hit);
      if (now() - hit.time < ttl) return hit.value;
    }
    if (pending.has(key)) return pending.get(key);
    const task = Promise.resolve().then(fn).then(value => {
      cache.delete(key); cache.set(key, { time: now(), value });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      return value;
    }).catch(error => {
      // Preserve the original timestamp: cached scores must not appear refreshed.
      if (error.code === 'UPSTREAM_RATE_LIMITED' && hit) return hit.value;
      throw error;
    }).finally(() => pending.delete(key));
    pending.set(key, task); return task;
  }
  return {
    matchups: (league, week) => memo(`m:${league}:${week}`, 5000, async () => {
      const rows = await fetchJSON(`${ROOT}/league/${league}/matchups/${week}`);
      if (!Array.isArray(rows)) throw new Error('Invalid matchups');
      return { rows, updatedAt: Math.floor(now()/1000) };
    }),
    meta: league => memo(`l:${league}`, 300000, async () => {
      const [info, rosters, users] = await Promise.all([
        fetchJSON(`${ROOT}/league/${league}`), fetchJSON(`${ROOT}/league/${league}/rosters`), fetchJSON(`${ROOT}/league/${league}/users`),
      ]);
      if (!info?.season || !Array.isArray(rosters) || !Array.isArray(users)) throw new Error('Invalid league');
      return { info, rosters, users };
    }),
  };
}
export function sides(rows, rosterId) {
  const yours = rows.find(r => r.roster_id === rosterId);
  if (!yours || yours.matchup_id == null) throw new Error('No matchup for this roster/week');
  const opponents = rows.filter(r => r.matchup_id === yours.matchup_id && r.roster_id !== rosterId);
  if (opponents.length !== 1) throw new Error('Expected one opponent');
  return [yours, opponents[0]];
}
export const round = n => Math.round((n + Number.EPSILON)*100)/100;
export function score(row) {
  const value = row.custom_points ?? row.points;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Missing or invalid score');
  return round(value);
}
export async function snapshot(data, meta, rosterId, week, estimator) {
  const [you, opponent] = sides(data.rows, rosterId);
  const name = row => {
    const roster = meta.rosters.find(r => r.roster_id === row.roster_id);
    const member = meta.users.find(u => u.user_id === roster?.owner_id);
    return member?.metadata?.team_name?.trim() || member?.display_name?.trim() || `Team ${row.roster_id}`;
  };
  const state = { yourScore: score(you), opponentScore: score(opponent), yourProjected: null,
    opponentProjected: null, yourProjectionKind: 'unavailable', opponentProjectionKind: 'unavailable', updatedAt: data.updatedAt };
  if (estimator) {
    try {
      const estimates = await estimator(meta.info, week, [you, opponent]);
      for (const [i, side] of ['your','opponent'].entries()) {
        const value = estimates[i];
        if (value && Number.isFinite(value.points)) {
          state[`${side}Projected`] = round(value.points); state[`${side}ProjectionKind`] = value.kind;
        }
      }
    } catch { /* A projection outage must not stop actual scores. */ }
  }
  return { attributes: { leagueName: meta.info.name, yourName: name(you), opponentName: name(opponent), week }, state };
}
