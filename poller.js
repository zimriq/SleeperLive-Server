import { endActivity } from './activities.js';
import { DAY_SECONDS } from './registrations.js';
import { logInfo, logError } from './logging.js';
import { createHash } from 'node:crypto';
import { sides, snapshot } from './sleeper.js';
export function changed(a,b) {
  if (!a) return true;
  return ['yourScore','opponentScore','yourProjectionKind','opponentProjectionKind'].some(k=>a[k]!==b[k]) ||
    ['yourProjected','opponentProjected'].some(k=>(a[k]===null)!==(b[k]===null) || (a[k]!==null && Math.abs(a[k]-b[k])>=0.5));
}
export function createPoller({store,sleeper,transport,estimator,gameStatus,pollMs=75000,pushConcurrency=4,freshnessPriority=5,now=Date.now,log=logInfo,errorLog=logError}) {
  if(!Number.isInteger(pushConcurrency)||pushConcurrency<1||pushConcurrency>16)throw Error('Invalid push concurrency');
  if(![5,10].includes(freshnessPriority))throw Error('Invalid freshness priority');
  let timer, running, stopped=true, draining=false, nextIdleReport=0;
  const seconds=()=>Math.floor(now()/1000);
  const status={lastRunAt:null,lastError:null};
  let finalScores = new Map();
  const backoff = n=>Math.min(900,30*2**Math.min(n,5));
  // Coalesce ready workers in the same turn. Each worker still waits for its own
  // commit, and a stalled request never delays another worker's result.
  let pendingChanges = [];
  function changeActivity(id, update, afterCommit = value=>value) {
    return new Promise((resolve,reject)=>{
      pendingChanges.push({id,update,afterCommit,resolve,reject});
      if (pendingChanges.length===1) queueMicrotask(flushChanges);
    });
  }
  function flushChanges() {
    const batch = pendingChanges;
    pendingChanges = [];
    try {
      store.change(state=>{
        for (const item of batch) {
          const current = state.activities[item.id];
          if (!current) continue;
          const activity = {...current};
          try {
            item.value = item.update(activity);
            state.activities[item.id] = activity;
          } catch(error) {
            item.failed = true;
            item.reject(error);
          }
        }
      });
    } catch(error) {
      for (const item of batch) item.reject(error);
      return;
    }
    for (const item of batch) {
      if (item.failed) continue;
      try { item.resolve(item.afterCommit(item.value)); }
      catch(error) { item.reject(error); }
    }
  }
  function reserve(activity,snap,autoEnd) {
    if (draining) return;
    const t=seconds();
    if(activity.status==='ended' || activity.nextAttempt>t)return;
    if(activity.expiresAt<=t)activity.status='ending';
    if(activity.status==='awaiting_token' || !activity.token)return;
    if((activity.pushTimestamp??0)>=t)return;
    const finish = autoEnd && activity.status==='active'
      && activity.version===autoEnd.version && activity.deviceId===autoEnd.deviceId
      && activity.startedAt===autoEnd.startedAt && snap.state.updatedAt>=activity.state.updatedAt;
    if (finish) {
      activity.status='ending';
      activity.endedReason='matchup_final';
      delete activity.endReason;
      activity.state=snap.state;
    }
    const end=activity.status==='ending';
    if(!end && !snap)return;
    if(!end && snap.state.updatedAt<activity.state.updatedAt)return;
    const freshnessBaseline=freshnessPriority===10
      ? (activity.urgentSentAt??activity.sentAt??activity.startedAt)
      : (activity.sentAt??activity.startedAt);
    const heartbeatDue=t-freshnessBaseline>=180;
    if(!end && !activity.force && !changed(activity.sentState,snap.state) && !heartbeatDue)return;
    const baseline=activity.sentState??activity.state;
    const scoreChanged=!end && (baseline.yourScore!==snap.state.yourScore || baseline.opponentScore!==snap.state.opponentScore);
    const recovery=activity.force || !activity.sentState;
    activity.pushTimestamp=t;
    return {autoEnded:finish,version:activity.version,deviceId:activity.deviceId,message:{
      token:activity.token,env:activity.env,event:end?'end':'update',timestamp:t,
      priority:end||scoreChanged||recovery?10:heartbeatDue?freshnessPriority:5,
      cause:end?'end':scoreChanged?'score':recovery?'recovery':heartbeatDue?'heartbeat':'projection',
      state:end?activity.state:snap.state,
    }};
  }
  async function deliver(id,snap,autoEnd) {
    return changeActivity(id,activity=>reserve(activity,snap,autoEnd),async reservation=>{
      if (!reservation) return;
      const {message,version,deviceId}=reservation;
      if (reservation.autoEnded) log(`event=auto_end activity=${id.slice(0,8)} reason=matchup_final`);
      const attemptAt=seconds();
      log(`event=push_attempt activity=${id.slice(0,8)} reason=${message.cause} priority=${message.priority} timestamp=${message.timestamp} updatedAt=${message.state.updatedAt} staleAt=${message.event==='end'?'none':message.state.updatedAt+360}`);
      let result;
      try { result=await transport.send(message); }
      catch { result={kind:'retry',reason:'TransportError'}; }
      const completedAt=seconds();
      const event=await changeActivity(id,a=>{
        // Recheck after the send, including deletion and recreation under the same ID.
        if(a.version!==version || a.deviceId!==deviceId || a.pushTimestamp!==message.timestamp || a.status==='ended')return;
        if(result.kind==='dead' && message.event!=='end'){
          a.invalidTokenHash=createHash('sha256').update(a.token.toLowerCase()).digest('hex');
          a.status='awaiting_token';a.token=null;delete a.endReason;delete a.endedReason;
          a.tokenLostAt=completedAt;a.nextAttempt=0;
          return `event=token_lost activity=${id.slice(0,8)} reason=${result.reason??'unknown'} status=${result.status??''}`;
        }
        if(result.kind==='dead' || (result.kind==='ok' && message.event==='end')) {
          const reason=a.endedReason??a.endReason??(result.kind==='dead'?'apns_unregistered':'end_push_accepted');
          endActivity(a,reason,completedAt);
          return `event=ended activity=${id.slice(0,8)} reason=${reason}`;
        }
        if(result.kind==='ok'){
          a.state=message.state;a.sentState=message.state;a.sentAt=completedAt;
          if(message.priority===10)a.urgentSentAt=completedAt;
          a.force=false;a.failures=0;a.nextAttempt=0;
          return;
        }
        a.failures=(a.failures??0)+1;a.nextAttempt=completedAt+backoff(a.failures);
        if(message.event==='end' && a.failures>=6){
          endActivity(a,'end_push_failed',completedAt);
          return `event=ended activity=${id.slice(0,8)} reason=end_push_failed`;
        }
      });
      if(event)log(event);
      if(result.kind!=='dead')log(`event=push_result activity=${id.slice(0,8)} reason=${result.reason??result.kind} status=${result.status??''} priority=${message.priority} timestamp=${message.timestamp} updatedAt=${message.state.updatedAt} completedAt=${completedAt} durationSeconds=${completedAt-attemptAt}`);
      if(result.kind==='retry')log('APNs retry needed',result.status??'',result.reason??'');
    });
  }
  async function run(){
    const at=seconds();
    const previousFinalScores=finalScores;
    finalScores=new Map();
    store.change(s=>{
      for(const device of Object.values(s.devices)) {
        if(!device.revoked && !Number.isFinite(device.lastSeenAt)) device.lastSeenAt=at;
      }
      for(const [id,a] of Object.entries(s.activities)){
        if(['active','ending','awaiting_token'].includes(a.status) && !a.token && a.expiresAt<=seconds()){
          endActivity(a,'expired',seconds());
          log(`event=ended activity=${id.slice(0,8)} reason=expired`);
        }
        if(a.status==='active' && a.expiresAt<=seconds()){a.status='ending';a.endedReason='expired';delete a.endReason;}
        if(a.status==='ended' && seconds()-a.endedAt>86400)delete s.activities[id];
      }
    });
    const groups=new Map(), jobs=[];
    const state=store.read();
    const activities=Object.values(state.activities);
    if(at>=nextIdleReport) {
      const occupied=new Set(activities.filter(a=>a.status!=='ended').map(a=>a.deviceId));
      const idleDays=60;
      const candidates=Object.entries(state.devices).filter(([id,device])=>
        !device.revoked && !occupied.has(id) && at-device.lastSeenAt>=idleDays*DAY_SECONDS).length;
      log(`event=device_idle_candidates count=${candidates} idleDays=${idleDays}`);
      nextIdleReport=at+DAY_SECONDS;
    }
    for(const a of activities){
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
        if(draining || !feeds)return;
        const [data,meta]=feeds;
        const snap=await snapshot(data,meta,a.rosterId,a.week,estimator);
        let autoEnd;
        if (gameStatus && !draining && await gameStatus(meta.info,a.week,sides(data.rows,a.rosterId))) {
          const previous=previousFinalScores.get(a.id);
          const sameActivity=previous?.deviceId===a.deviceId && previous.startedAt===a.startedAt;
          const prior=sameActivity?previous:undefined;
          const fresh=snap.state.updatedAt>=at && (!prior || snap.state.updatedAt>prior.updatedAt);
          const sameScore=prior?.yourScore===snap.state.yourScore && prior.opponentScore===snap.state.opponentScore;
          const confirmedAt=prior?.confirmedAt??at;
          const stablePolls=fresh && sameScore && prior.fresh?prior.stablePolls+1:0;
          finalScores.set(a.id,{deviceId:a.deviceId,startedAt:a.startedAt,confirmedAt,
            updatedAt:snap.state.updatedAt,yourScore:snap.state.yourScore,
            opponentScore:snap.state.opponentScore,stablePolls,fresh});
          if (fresh && (stablePolls>=2 || at-confirmedAt>=600)) autoEnd=a;
        }
        await deliver(a.id,snap,autoEnd);
      });
    }
    let cursor=0;
    const worker=async()=>{
      while(!draining && cursor<jobs.length){
        const job=jobs[cursor++];
        try{await job();}catch(error){errorLog('activity_update_failed',error);}
      }
    };
    // Active sends persist their results even when shutdown stops workers taking new jobs.
    await Promise.all(Array.from({length:Math.min(pushConcurrency,jobs.length)},worker));
    status.lastRunAt=seconds();
    status.lastError=null;
  }
  return {
    tick() {
      if (running) return running;
      if (draining) return Promise.resolve();
      running = run().catch(error=>{
        status.lastError=error.message;
        errorLog('poll_failed',error);
      }).finally(()=>{running=null;});
      return running;
    },
    start() {
      if (!stopped) return;
      draining=false;
      stopped=false;
      const loop=async()=>{
        await this.tick();
        if (!stopped) timer=setTimeout(loop,pollMs);
      };
      timer=setTimeout(loop,0);
    },
    async stop() {
      draining=true;
      stopped=true;
      clearTimeout(timer);
      if (running) await running;
    },
    status:()=>({...status}),
  };
}
