import { createHash } from 'node:crypto';
import { Router } from 'express';
import { endActivity } from './activities.js';
import { createRateLimiter } from './rate-limit.js';
import { snapshot } from './sleeper.js';

const hash = text=>createHash('sha256').update(text).digest('hex');
const fail=(status,error)=>Object.assign(new Error(error),{status});
const ownActivity=(activities,id)=>Object.hasOwn(activities,id)?activities[id]:undefined;

export function activityRouter({cfg,store,sleeper,estimator,now,log}) {
  const router=Router();
  const seconds=()=>Math.floor(now()/1000);
  const matchupLimit=createRateLimiter(now,1000);

  function identity(body,query=false){
    const number=value=>query && typeof value==='string' && /^\d+$/.test(value)
      ? Number(value) : value;
    const {leagueId}=body,week=number(body.week),rosterId=number(body.rosterId);
    if(typeof leagueId!=='string' || !/^\d{6,25}$/.test(leagueId) || !Number.isInteger(week)||week<1||week>18||!Number.isInteger(rosterId)||rosterId<1||rosterId>100)throw fail(400,'invalid_matchup');
    return {leagueId,week,rosterId};
  }
  async function getSnapshot(p){
    try{const [data,meta]=await Promise.all([sleeper.matchups(p.leagueId,p.week),sleeper.meta(p.leagueId)]);return await snapshot(data,meta,p.rosterId,p.week,estimator);}
    catch{throw fail(503,'matchup_unavailable');}
  }
  router.get('/v1/matchup',async(req,res)=>{
    matchupLimit(req.deviceId,10);
    res.json(await getSnapshot(identity(req.query,true)));
  });
  router.put('/v1/activities/:id',async(req,res)=>{
    const id=req.params.id,b=req.body??{},p=identity(b),t=seconds();
    if(!/^[A-Za-z0-9-]{8,80}$/.test(id)||typeof b.pushToken!=='string'||!/^([a-fA-F0-9]{2}){16,256}$/.test(b.pushToken)||!['development','production'].includes(b.apnsEnvironment))throw fail(400,'invalid_activity');
    if(!Number.isInteger(b.startedAt))throw fail(400,'invalid_started_at');
    // Validate access before doing upstream work, then recheck after await inside the transaction.
    const check=a=>{
      if(a.deviceId!==req.deviceId)throw fail(404,'not_found');
      if(!['active','awaiting_token'].includes(a.status)||a.expiresAt<=seconds())throw fail(409,'activity_ended');
      if(a.leagueId!==p.leagueId||a.week!==p.week||a.rosterId!==p.rosterId||a.startedAt!==b.startedAt)throw fail(409,'identity_mismatch');
    };
    const existing=ownActivity(store.read().activities,id);if(existing)check(existing);
    if(b.startedAt>t+30||b.startedAt<=t-28800)throw fail(400,'invalid_started_at');
    const snap=existing?null:await getSnapshot(p);
    const result=store.change(s=>{
      if(!s.devices[req.deviceId]||s.devices[req.deviceId].revoked)throw fail(401,'unauthorized');
      const a=ownActivity(s.activities,id);
      if(a){
        check(a);
        if(a.status==='awaiting_token' && a.invalidTokenHash===hash(b.pushToken.toLowerCase()) && a.env===b.apnsEnvironment)
          return {created:false,expiresAt:a.expiresAt,needsPushToken:true};
        const revived=a.status==='awaiting_token';
        // Ordinary retries remain idempotent. An explicit refresh supersedes any
        // in-flight delivery so a late response cannot restore the old backoff.
        const reset=a.token!==b.pushToken||a.env!==b.apnsEnvironment||b.refresh===true;
        if(reset){
          a.token=b.pushToken;a.env=b.apnsEnvironment;a.status='active';
          delete a.invalidTokenHash;delete a.tokenLostAt;delete a.endReason;delete a.endedReason;
          if(revived)log(`event=token_revived activity=${id.slice(0,8)} reason=replacement`);
          a.version++;a.force=true;a.nextAttempt=0;a.failures=0;
        }
        return {created:false,expiresAt:a.expiresAt};
      }
      const active=Object.values(s.activities).filter(a=>a.status!=='ended'&&a.expiresAt>seconds());
      if(active.length>=cfg.maxActivities||active.filter(a=>a.deviceId===req.deviceId).length>=cfg.perDevice)throw fail(429,'activity_limit');
      const expiresAt=b.startedAt+28800;
      if(expiresAt<=seconds())throw fail(409,'activity_ended');
      s.activities[id]={id,...p,deviceId:req.deviceId,token:b.pushToken,env:b.apnsEnvironment,
        startedAt:b.startedAt,expiresAt,status:'active',version:1,state:snap.state,attributes:snap.attributes,
        force:true,failures:0,nextAttempt:0,pushTimestamp:0};
      return {created:true,expiresAt};
    });
    log(`event=registered activity=${id.slice(0,8)} reason=${result.created?'created':'updated'}`);
    res.status(result.created?201:200).json({activityId:id,expiresAt:result.expiresAt,...(result.needsPushToken?{needsPushToken:true}:{})});
  });
  router.get('/v1/activities/:id',(req,res)=>{
    const a=ownActivity(store.read().activities,req.params.id);if(!a||a.deviceId!==req.deviceId)throw fail(404,'not_found');
    res.json({activityId:a.id,status:a.status,expiresAt:a.expiresAt,state:a.state,attributes:a.attributes,lastAcceptedAt:a.sentAt??null,endReason:a.endReason??a.endedReason??null,needsPushToken:a.status==='awaiting_token',endedReason:a.endedReason??a.endReason??null,endedAt:a.endedAt??null});
  });
  router.delete('/v1/activities/:id',(req,res)=>{
    store.change(s=>{
      const activity=ownActivity(s.activities,req.params.id);
      if(activity?.deviceId!==req.deviceId || activity.status==='ended')return;
      endActivity(activity,'user_delete',seconds());
      activity.version++;
      log(`event=ended activity=${activity.id.slice(0,8)} reason=user_delete`);
    });
    res.status(204).end();
  });
  return router;
}
