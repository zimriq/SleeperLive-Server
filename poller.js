import { snapshot } from './sleeper.js';
export function changed(a,b) {
  if (!a) return true;
  return ['yourScore','opponentScore','yourProjectionKind','opponentProjectionKind'].some(k=>a[k]!==b[k]) ||
    ['yourProjected','opponentProjected'].some(k=>(a[k]===null)!==(b[k]===null) || (a[k]!==null && Math.abs(a[k]-b[k])>=0.5));
}
export function createPoller({store,sleeper,transport,estimator,pollMs=75000,pushConcurrency=4,now=Date.now,log=console.warn}) {
  if(!Number.isInteger(pushConcurrency)||pushConcurrency<1||pushConcurrency>16)throw Error('Invalid push concurrency');
  let timer, running, stopped=true;
  const seconds=()=>Math.floor(now()/1000);
  const status={lastRunAt:null,lastError:null};
  const backoff = n=>Math.min(900,30*2**Math.min(n,5));
  async function deliver(id,snap) {
    let message, version;
    store.change(s=>{
      const a=s.activities[id], t=seconds();
      if(!a || a.status==='ended' || a.nextAttempt>t)return;
      if(a.expiresAt<=t)a.status='ending';
      const end=a.status==='ending';
      if(!end && !snap)return;
      if(!end && snap.state.updatedAt<a.state.updatedAt)return;
      if(!end && !a.force && !changed(a.sentState,snap.state) && t-(a.sentAt??0)<180)return;
      // Reserve an ordering timestamp durably BEFORE sending, including across restart/retry.
      if((a.pushTimestamp??0)>=t)return;
      a.pushTimestamp=t; version=a.version;
      // Compare with the last Apple-accepted score, or the initial app snapshot.
      // A failed delivery must not advance this baseline. Corrections count too.
      const baseline=a.sentState??a.state;
      const scoreChanged=!end && (baseline.yourScore!==snap.state.yourScore || baseline.opponentScore!==snap.state.opponentScore);
      message={token:a.token,env:a.env,event:end?'end':'update',timestamp:t,
        priority:end||scoreChanged?10:5,state:end?a.state:snap.state};
    });
    if(!message)return;
    let result;
    try{result=await transport.send(message);}catch{result={kind:'retry',reason:'TransportError'};}
    store.change(s=>{
      const a=s.activities[id];
      // A late old-token response must never invalidate a newly registered token.
      if(!a || a.version!==version || a.status==='ended')return;
      if(result.kind==='dead' || (result.kind==='ok' && message.event==='end')) {
        a.status='ended';a.endedAt=seconds();a.token=null;return;
      }
      if(result.kind==='ok'){
        a.state=message.state;a.sentState=message.state;a.sentAt=seconds();a.force=false;a.failures=0;a.nextAttempt=0;
      }else{
        a.failures=(a.failures??0)+1;a.nextAttempt=seconds()+backoff(a.failures);
        if(message.event==='end' && a.failures>=6){a.status='ended';a.endedAt=seconds();a.token=null;}
      }
    });
    if(result.kind==='retry')log('APNs retry needed',result.status??'',result.reason??'');
  }
  async function run(){
    store.change(s=>{
      for(const [id,a] of Object.entries(s.activities)){
        if(a.status==='active' && a.expiresAt<=seconds())a.status='ending';
        if(a.status==='ended' && seconds()-a.endedAt>86400)delete s.activities[id];
      }
    });
    const groups=new Map(), jobs=[];
    for(const a of Object.values(store.read().activities)){
      if(a.status==='ended' || a.nextAttempt>seconds())continue;
      if(a.status==='ending'){jobs.push(()=>deliver(a.id));continue;}
      const key=`${a.leagueId}:${a.week}`;
      if(!groups.has(key)){
        let pending;
        // Fetch lazily once per league/week, shared by every activity in this tick.
        groups.set(key,()=>pending??=Promise.all([
          sleeper.matchups(a.leagueId,a.week),sleeper.meta(a.leagueId)
        ]).catch(()=>{log('Sleeper unavailable; retaining last valid state');return null;}));
      }
      const fetchGroup=groups.get(key);
      jobs.push(async()=>{
        const feeds=await fetchGroup();
        if(!feeds)return;
        const [data,meta]=feeds;
        await deliver(a.id,await snapshot(data,meta,a.rosterId,a.week,estimator));
      });
    }
    let cursor=0;
    const worker=async()=>{
      while(cursor<jobs.length){
        const job=jobs[cursor++];
        try{await job();}catch{log('Activity update failed; retaining last valid state');}
      }
    };
    // Tick and shutdown wait for all workers; one slow send occupies only one slot.
    await Promise.all(Array.from({length:Math.min(pushConcurrency,jobs.length)},worker));
    status.lastRunAt=seconds();
  }
  return {
    tick(){if(running)return running;running=run().catch(e=>{status.lastError=e.message;log('Poll failed');}).finally(()=>{running=null;});return running;},
    start(){if(!stopped)return;stopped=false;const loop=async()=>{await this.tick();if(!stopped)timer=setTimeout(loop,pollMs);};timer=setTimeout(loop,0);},
    async stop(){stopped=true;clearTimeout(timer);if(running)await running;},
    status:()=>({...status}),
  };
}
// Preserved convenience function from the original project.
export async function fetchMatchups(leagueId,week){
  const {getJSON}=await import('./sleeper.js');
  return getJSON(`https://api.sleeper.app/v1/league/${leagueId}/matchups/${week}`);
}
