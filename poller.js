import { logInfo, logError } from './logging.js';
import { createHash } from 'node:crypto';
import { snapshot } from './sleeper.js';
export function changed(a,b) {
  if (!a) return true;
  return ['yourScore','opponentScore','yourProjectionKind','opponentProjectionKind'].some(k=>a[k]!==b[k]) ||
    ['yourProjected','opponentProjected'].some(k=>(a[k]===null)!==(b[k]===null) || (a[k]!==null && Math.abs(a[k]-b[k])>=0.5));
}
export function createPoller({store,sleeper,transport,estimator,pollMs=75000,pushConcurrency=4,freshnessPriority=5,now=Date.now,log=logInfo,errorLog=logError}) {
  if(!Number.isInteger(pushConcurrency)||pushConcurrency<1||pushConcurrency>16)throw Error('Invalid push concurrency');
  if(![5,10].includes(freshnessPriority))throw Error('Invalid freshness priority');
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
      if(a.status==='awaiting_token' || !a.token)return;
      const end=a.status==='ending';
      if(!end && !snap)return;
      if(!end && snap.state.updatedAt<a.state.updatedAt)return;
      const freshnessBaseline=freshnessPriority===10?(a.urgentSentAt??a.sentAt??a.startedAt):(a.sentAt??a.startedAt);
      const heartbeatDue=t-freshnessBaseline>=180;
      if(!end && !a.force && !changed(a.sentState,snap.state) && !heartbeatDue)return;
      // Reserve an ordering timestamp durably BEFORE sending, including across restart/retry.
      if((a.pushTimestamp??0)>=t)return;
      a.pushTimestamp=t; version=a.version;
      // Compare with the last Apple-accepted score, or the initial app snapshot.
      // A failed delivery must not advance this baseline. Corrections count too.
      const baseline=a.sentState??a.state;
      const scoreChanged=!end && (baseline.yourScore!==snap.state.yourScore || baseline.opponentScore!==snap.state.opponentScore);
      const recovery=a.force || !a.sentState;
      message={token:a.token,env:a.env,event:end?'end':'update',timestamp:t,
        priority:end||scoreChanged||recovery?10:heartbeatDue?freshnessPriority:5,
        cause:end?'end':scoreChanged?'score':recovery?'recovery':heartbeatDue?'heartbeat':'projection',state:end?a.state:snap.state};
    });
    if(!message)return;
    const attemptAt=seconds();
    log(`event=push_attempt activity=${id.slice(0,8)} reason=${message.cause} priority=${message.priority} timestamp=${message.timestamp} updatedAt=${message.state.updatedAt} staleAt=${message.event==='end'?'none':message.state.updatedAt+360}`);
    let result;
    try{result=await transport.send(message);}catch{result={kind:'retry',reason:'TransportError'};}
    store.change(s=>{
      const a=s.activities[id];
      // A late old-token response must never invalidate a newly registered token.
      if(!a || a.version!==version || a.status==='ended')return;
      if(result.kind==='dead' && message.event!=='end'){
        a.status='awaiting_token';a.invalidTokenHash=createHash('sha256').update(a.token.toLowerCase()).digest('hex');
        a.token=null;delete a.endReason;delete a.endedReason;a.tokenLostAt=seconds();a.nextAttempt=0;
        log(`event=token_lost activity=${id.slice(0,8)} reason=${result.reason??'unknown'} status=${result.status??''}`);return;
      }
      if(result.kind==='dead' || (result.kind==='ok' && message.event==='end')) {
        a.endedReason=a.endedReason??(result.kind==='dead'?'apns_unregistered':'end_push_accepted');a.endReason=a.endedReason;
        log(`event=ended activity=${id.slice(0,8)} reason=${a.endedReason}`);
        a.status='ended';a.endedAt=seconds();a.token=null;delete a.invalidTokenHash;delete a.tokenLostAt;return;
      }
      if(result.kind==='ok'){
        a.state=message.state;a.sentState=message.state;a.sentAt=seconds();
        if(message.priority===10)a.urgentSentAt=seconds();a.force=false;a.failures=0;a.nextAttempt=0;
      }else{
        a.failures=(a.failures??0)+1;a.nextAttempt=seconds()+backoff(a.failures);
        if(message.event==='end' && a.failures>=6){a.status='ended';a.endedReason='end_push_failed';a.endReason=a.endedReason;log(`event=ended activity=${id.slice(0,8)} reason=end_push_failed`);a.endedAt=seconds();a.token=null;delete a.invalidTokenHash;delete a.tokenLostAt;}
      }
    });
    if(result.kind!=='dead')log(`event=push_result activity=${id.slice(0,8)} reason=${result.reason??result.kind} status=${result.status??''} priority=${message.priority} timestamp=${message.timestamp} updatedAt=${message.state.updatedAt} completedAt=${seconds()} durationSeconds=${seconds()-attemptAt}`);
    if(result.kind==='retry')log('APNs retry needed',result.status??'',result.reason??'');
  }
  async function run(){
    store.change(s=>{
      for(const [id,a] of Object.entries(s.activities)){
        if(['active','ending','awaiting_token'].includes(a.status) && !a.token && a.expiresAt<=seconds()){a.status='ended';a.endedAt=seconds();a.endedReason='expired';a.endReason='expired';delete a.invalidTokenHash;delete a.tokenLostAt;log(`event=ended activity=${id.slice(0,8)} reason=expired`);}
        if(a.status==='active' && a.expiresAt<=seconds()){a.status='ending';a.endedReason='expired';a.endReason='expired';}
        if(a.status==='ended' && seconds()-a.endedAt>86400)delete s.activities[id];
      }
    });
    const groups=new Map(), jobs=[];
    for(const a of Object.values(store.read().activities)){
      if(['ended','awaiting_token'].includes(a.status) || !a.token || a.nextAttempt>seconds())continue;
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
        try{await job();}catch(error){errorLog('activity_update_failed',error);}
      }
    };
    // Tick and shutdown wait for all workers; one slow send occupies only one slot.
    await Promise.all(Array.from({length:Math.min(pushConcurrency,jobs.length)},worker));
    status.lastRunAt=seconds();
    status.lastError=null;
  }
  return {
    tick(){if(running)return running;running=run().catch(e=>{status.lastError=e.message;errorLog('poll_failed',e);}).finally(()=>{running=null;});return running;},
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
