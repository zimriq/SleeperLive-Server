import { getJSON, score } from './sleeper.js';

// Experimental time-remaining estimate. These feeds are undocumented.
// Only these explicitly supported counting stats are scored; unknown rules fail closed.
const LINEAR = new Set(`pass_yd pass_td pass_int pass_2pt pass_att pass_cmp pass_inc pass_sack pass_fd pass_int_td rush_yd rush_td rush_2pt rush_att rush_fd rec rec_yd rec_td rec_2pt rec_fd fum fum_lost fum_rec_td fgm fgm_yds fgm_0_19 fgm_20_29 fgm_30_39 fgm_40_49 fgm_50_59 fgm_60p fgmiss xpm xpmiss sack int ff fum_rec def_td safe blk_kick st_td st_ff st_fum_rec def_st_td def_st_ff def_st_fum_rec`.split(' '));
const TEAM = team => ({ LA: 'LAR', WSH: 'WAS', JAC: 'JAX' }[team] ?? team);
export function gameProgress(event) {
  const status = event.status ?? event.competitions?.[0]?.status;
  if (status?.type?.completed) return { remaining: 0, final: true };
  // Suspended/delayed/cancelled games are not normal running clocks.
  if (['STATUS_SCHEDULED','STATUS_PREGAME'].includes(status?.type?.name)) return { remaining: 1, final: false };
  if (!['STATUS_IN_PROGRESS','STATUS_HALFTIME','STATUS_END_PERIOD'].includes(status?.type?.name)) return null;
  const period = status.period;
  const clock = Number(status.clock);
  if (!Number.isInteger(period) || period < 1 || period > 4 || !Number.isFinite(clock) || clock < 0 || clock > 900) return null;
  return { remaining: ((4-period)*900 + clock)/3600, final: false };
}
export function projectedPoints(stats, rules, position = 'QB') {
  if (!stats || stats.gp !== 1 || !rules || typeof rules !== 'object') return null;
  let total = 0;
  const bucketFamilies = ['pts_allow_', 'yds_allow_'];
  for (const [key, weight] of Object.entries(rules)) {
    if (typeof weight !== 'number' || !Number.isFinite(weight)) return null;
    if (weight === 0) continue;
    const family = bucketFamilies.find(prefix => key.startsWith(prefix));
    if (family) {
      if (position !== 'DEF') continue;
      if (!Object.keys(stats).some(k => k.startsWith(family))) return null;
      const indicator = stats[key] ?? 0;
      if (!Number.isFinite(indicator) || indicator < 0 || indicator > 1) return null;
      total += weight * indicator; continue;
    }
    if (!LINEAR.has(key)) return null;
    // Sleeper projection feed calls a recovered-fumble TD def_fum_td for defenses.
    const value = (key === 'fum_rec_td' && position === 'DEF' ? stats.def_fum_td : stats[key]) ?? 0;
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    total += weight * value;
  }
  return total;
}
export function estimateTeam(row, rules, projections, games) {
  if (!Array.isArray(row.starters) || !row.starters.length) return null;
  let delta = 0, allFinal = true;
  for (const id of row.starters) {
    if (id === '0') continue;
    const p = projections.get(id);
    const game = p && games.get(TEAM(p.team ?? p.player?.team));
    const progress = game && gameProgress(game);
    if (!progress) return null;
    if (progress.final) continue;
    allFinal = false;
    const base = projectedPoints(p.stats, rules, p.player?.position);
    if (base === null) return null;
    if (p.player?.position === 'DEF') {
      // D/ST starts with points-allowed credit. Blend toward its current score instead
      // of adding a full projection on top of that credit. This is a heuristic, not a forecast model.
      const actual = row.players_points?.[id];
      if (!Number.isFinite(actual)) return null;
      delta += (base - actual) * progress.remaining;
    } else {
      delta += base * progress.remaining;
    }
  }
  return { points: score(row) + delta, kind: allFinal ? 'final' : 'estimate' };
}
export function createEstimator(load = getJSON, now = Date.now) {
  let cache, pending, playersCache, retryAfter = 0;
  return async (league, week, rows) => {
    const key = `${league.season}:${week}`;
    const fetchFeeds = async () => {
      const feeds = await Promise.allSettled([
        load(`https://api.sleeper.com/projections/nfl/${league.season}/${week}?season_type=regular`),
        load(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${league.season}&seasontype=2&week=${week}`),
        playersCache && now()-playersCache.at<86400000 ? playersCache.value : load("https://api.sleeper.app/v1/players/nfl").then(value=>{playersCache={at:now(),value};return value;}),
      ]);
      // Wait for every request to settle before allowing another batch.
      if (feeds.some(feed => feed.status === 'rejected')) throw new Error('Estimate feed unavailable');
      const [projections, board, players] = feeds.map(feed => feed.value);
      if (!Array.isArray(projections) || !Array.isArray(board.events) || !board.events.length) throw new Error('Invalid estimate feeds');
      if (board.week?.number !== week || board.season?.year !== Number(league.season)) throw new Error('Wrong scoreboard season/week');
      const games = new Map();
      for (const team of board.week.teamsOnBye ?? []) games.set(TEAM(team.abbreviation), { status: {type:{completed:true}}, bye:true });
      for (const event of board.events) {
        if (event.season?.year !== Number(league.season) || event.week?.number !== week) throw new Error('Wrong scoreboard week');
        for (const team of event.competitions?.[0]?.competitors ?? []) games.set(TEAM(team.team.abbreviation), event);
      }
      const values = new Map(Object.entries(players).map(([id,p])=>[id,{team:p.team,player:p}]));
      for (const p of projections) {
        if (String(p.season) !== String(league.season) || p.week !== week || p.season_type !== 'regular') continue;
        values.set(p.player_id, p);
      }
      cache = { key, at: now(), values, games }; return cache;
    };
    // Shared cooldown also covers different weeks: changing a request key must not
    // bypass protection for the same upstream services. Keep only one batch in flight.
    const fresh = () => cache?.key === key && now()-cache.at <= 60000;
    if (!fresh()) {
      if (pending && pending.key !== key) await pending.task;
      if (!fresh()) {
        if (now() < retryAfter) return rows.map(()=>null);
        if (!pending) {
          const task = fetchFeeds().catch(() => {
            retryAfter = now()+60000;
            return null;
          });
          pending = {key, task};
          task.finally(() => { if (pending?.task === task) pending = null; }).catch(()=>{});
        }
        const result = await pending.task;
        if (!result || result.key !== key) return rows.map(()=>null);
        return rows.map(row => estimateTeam(row, league.scoring_settings, result.values, result.games));
      }
    }
    return rows.map(row => estimateTeam(row, league.scoring_settings, cache.values, cache.games));
  };
}
