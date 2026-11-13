import { getJSON } from './sleeper.js';

const TEAM_ALIASES = new Map([['LA', 'LAR'], ['WSH', 'WAS'], ['JAC', 'JAX']]);
const teamName = name => TEAM_ALIASES.get(name) ?? name;

export function startersFinished(rows, games, players) {
  return rows.every(row => {
    if (!Array.isArray(row.starters)) return false;
    const starters = row.starters.filter(id => id !== '0');
    return starters.length > 0 && starters.every(id => {
      if (typeof id !== 'string') return false;
      const defense = /^[A-Z]{2,3}$/.test(id);
      const team = teamName(defense ? id : players[id]?.team);
      return games.get(team) === true;
    });
  });
}

export function createGameStatus(load = getJSON, now = Date.now) {
  const cache = new Map();
  const pending = new Map();
  let catalog, catalogPending;
  async function players() {
    if (catalog && now() < catalog.until) return catalog.value;
    catalogPending ??= Promise.resolve().then(async () => {
      const value = await load('https://api.sleeper.app/v1/players/nfl');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid player catalog');
      catalog = {value, until: now() + 86400000};
      return value;
    }).catch(() => {
      catalog = {value: null, until: now() + 60000};
      return null;
    }).finally(() => { catalogPending = null; });
    return catalogPending;
  }

  async function schedule(season, week) {
    const key = `${season}:${week}`;
    const entry = cache.get(key);
    if (entry && now() < entry.until) {
      cache.delete(key);
      cache.set(key, entry);
      return entry.value;
    }
    if (pending.has(key)) return pending.get(key);
    // Bound simultaneous scoreboard work even with many distinct league weeks.
    if (pending.size >= 4) return null;
    const task = Promise.resolve().then(async () => {
      const board = await load(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${week}`);
      if (board?.season?.year !== Number(season) || board.season.type !== 2 ||
          board.week?.number !== week || !Array.isArray(board.events) || !board.events.length) return null;
      const games = new Map();
      for (const bye of board.week.teamsOnBye ?? []) {
        if (typeof bye?.abbreviation === 'string') games.set(teamName(bye.abbreviation), true);
      }
      for (const event of board.events) {
        if (event.season?.year !== Number(season) || event.week?.number !== week) return null;
        const competition = event.competitions?.[0];
        const status = event.status?.type ?? competition?.status?.type;
        const teams = competition?.competitors?.map(item => teamName(item.team?.abbreviation));
        if (!teams || teams.length !== 2 || teams.some(team => typeof team !== 'string') || teams[0] === teams[1]) return null;
        for (const team of teams) {
          // A scheduled game takes precedence over an inconsistent bye marker.
          const final = status?.completed === true && status.name === 'STATUS_FINAL';
          games.set(team, games.get(team) !== false && final);
        }
      }
      return games;
    }).catch(() => null).then(value => {
      cache.delete(key);
      cache.set(key, {value, until: now() + 60000});
      while (cache.size > 4) cache.delete(cache.keys().next().value);
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }

  return async (league, week, rows) => {
    const season = league?.season;
    if (typeof season !== 'string' || !/^\d{4}$/.test(season) ||
        !Number.isInteger(week) || week < 1 || week > 18) return false;
    const games = await schedule(season, week);
    if (!games) return false;
    const catalog = await players();
    return catalog !== null && startersFinished(rows, games, catalog);
  };
}
