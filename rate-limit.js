// Fixed windows retain insertion order: with one duration and nondecreasing time,
// the oldest counter always expires first. Never refresh expiry on a hit.
export function createRateLimiter(now = Date.now, capacity = 5000) {
  if(!Number.isInteger(capacity)||capacity<1||capacity>5000)throw Error('Invalid counter capacity');
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
      if (hits.size >= capacity) reject();
      counter = {n:0, until:time+60000};
      hits.set(key, counter);
    }
    if (counter.n >= max) reject();
    counter.n++;
  };
}


// Reserve space for authenticated devices and fixed global budgets. Untrusted
// enrollment IPs cannot consume those slots. Total storage remains 5,000 counters.
export function createApiRateLimiter(now = Date.now) {
  const devices=createRateLimiter(now,1000);
  const enrollment=createRateLimiter(now,3998);
  const global=createRateLimiter(now,2);
  return (key,max)=>{
    if(key.startsWith('device:'))return devices(key,max);
    if(key.startsWith('ip:')||key.startsWith('enrollment:'))return enrollment(key,max);
    if(key==='global:enrollment'||key==='global:upstream')return global(key,max);
    throw Error('Unknown rate-limit category');
  };
}
