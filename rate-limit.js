// Fixed windows retain insertion order: with one duration and nondecreasing time,
// the oldest counter always expires first. Never refresh expiry on a hit.
export function createRateLimiter(now = Date.now) {
  const hits = new Map();
  let lastTime = -Infinity;
  const reject = () => { throw Object.assign(new Error('rate_limited'), {status:429}); };
  return (key, max) => {
    // A wall-clock correction must not break expiration ordering.
    const time = lastTime = Math.max(lastTime, now());
    for (const [oldest, counter] of hits) {
      if (counter.until > time) break;
      hits.delete(oldest);
    }
    let counter = hits.get(key);
    if (!counter) {
      if (hits.size >= 5000) reject();
      counter = {n:0, until:time+60000};
      hits.set(key, counter);
    }
    if (counter.n >= max) reject();
    counter.n++;
  };
}
