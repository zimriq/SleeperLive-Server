import express from 'express';
import { revokeDevice } from './revoke-device.js';
import { clientIP } from './client-ip.js';
import { createApiRateLimiter } from './rate-limit.js';
import { enrollmentRouter } from './enrollment.js';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { snapshot } from './sleeper.js';
const hash = text=>createHash('sha256').update(text).digest('hex');
const equals=(a,b)=>timingSafeEqual(Buffer.from(hash(a),'hex'),Buffer.from(hash(b),'hex'));
const fail=(status,error)=>Object.assign(new Error(error),{status});
export function createApp({cfg,store,sleeper,estimator,now=Date.now,poller}) {
  const app=express(), seconds=()=>Math.floor(now()/1000), limit=createApiRateLimiter(now);
  app.disable('x-powered-by');app.set('trust proxy',false);
  // Verify fixed-size bearer credentials using the committed, bounded memory index.
  // Unknown credentials never allocate cache entries or trigger database reads.
  let ingressUntil=0;
  const budgets={anonymous:{total:0,ips:new Map()},authenticated:{total:0,ips:new Map()}};
  app.use('/v1',(req,res,next)=>{
    req.clientIP=clientIP(req,cfg.clientIPMode);
    const enrollment=/^\/enrollment(?:\/|$)/i.test(req.path)||
      (req.method==='POST'&&/^\/devices\/?$/i.test(req.path));
    const match=!enrollment&&/^Bearer ([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(req.get('authorization')??'');
    const credential=match&&store.credentialHash(match[1]);
    if(credential&&equals(hash(match[2]),credential)){
      req.deviceId=match[1];req.credentialHash=credential;
    }
    const t=now();
    if(t>=ingressUntil){
      ingressUntil=t+60000;
      for(const budget of Object.values(budgets)){budget.total=0;budget.ips.clear();}
    }
    const budget=req.deviceId?budgets.authenticated:budgets.anonymous;
    const count=budget.ips.get(req.clientIP)??0;
    if(budget.total>=(cfg.ingressGlobal??1200)||count>=(cfg.ingressPerIP??400)){
      return res.status(429).set('Retry-After',String(Math.max(1,Math.ceil((ingressUntil-t)/1000))))
        .set('Cache-Control','no-store').json({error:'rate_limited'});
    }
    budget.total++;budget.ips.set(req.clientIP,count+1);
    if(req.deviceId)limit(`device:${req.deviceId}`,30);
    next();
  });
  app.use('/v1/enrollment', enrollmentRouter({cfg,store,limit,now}));
  app.use(express.json({limit:'8kb',inflate:false}));
  // Public liveness only. Preserve the iOS mode contract without exposing internal errors.
  app.get('/health',(_,res)=>res.set('Cache-Control','no-store').json({ok:true,mode:cfg.mode}));
  app.post('/v1/devices',(req,res)=>{
    res.set('Cache-Control','no-store');
    if(!(cfg.inviteEnabled ?? !cfg.attestEnabled))throw fail(404,'not_found');
    limit(`ip:${req.clientIP}`,10);
    if(typeof req.body?.inviteCode!=='string' || !equals(req.body.inviteCode,cfg.invite))throw fail(403,'invalid_invite');
    const id=randomBytes(16).toString('hex'), secret=randomBytes(32).toString('hex');
    store.change(s=>{
      if(Object.values(s.devices).filter(d=>!d.revoked).length>=cfg.maxDevices)throw fail(503,'device_limit');
      s.devices[id]={hash:hash(secret),createdAt:seconds()};
    });
    res.status(201).json({deviceId:id,deviceToken:`${id}.${secret}`});
  });
  app.use('/v1',(req,res,next)=>{
    // Recheck after body parsing: a concurrent request may have revoked the device.
    if(!req.deviceId||store.credentialHash(req.deviceId)!==req.credentialHash)
      return res.status(401).json({error:'unauthorized'});
    next();
  });
  function identity(body){
    const {leagueId}=body,week=Number(body.week),rosterId=Number(body.rosterId);
    if(typeof leagueId!=='string' || !/^\d{6,25}$/.test(leagueId) || !Number.isInteger(week)||week<1||week>18||!Number.isInteger(rosterId)||rosterId<1||rosterId>100)throw fail(400,'invalid_matchup');
    return {leagueId,week,rosterId};
  }
  async function getSnapshot(p){
    limit('global:upstream',60);
    try{const [data,meta]=await Promise.all([sleeper.matchups(p.leagueId,p.week),sleeper.meta(p.leagueId)]);return await snapshot(data,meta,p.rosterId,p.week,estimator);}
    catch{throw fail(503,'matchup_unavailable');}
  }
  app.get('/v1/matchup',async(req,res)=>res.json(await getSnapshot(identity(req.query))));
  app.put('/v1/activities/:id',async(req,res)=>{
    const id=req.params.id,b=req.body??{},p=identity(b),t=seconds();
    if(!/^[A-Za-z0-9-]{8,80}$/.test(id)||typeof b.pushToken!=='string'||!/^([a-fA-F0-9]{2}){16,256}$/.test(b.pushToken)||!['development','production'].includes(b.apnsEnvironment))throw fail(400,'invalid_activity');
    if(!Number.isInteger(b.startedAt)||b.startedAt>t+30||b.startedAt<=t-28800)throw fail(400,'invalid_started_at');
    // Validate access before doing upstream work, then recheck after await inside the transaction.
    const check=a=>{
      if(a.deviceId!==req.deviceId)throw fail(404,'not_found');
      if(a.status!=='active'||a.expiresAt<=seconds())throw fail(409,'activity_ended');
      if(a.leagueId!==p.leagueId||a.week!==p.week||a.rosterId!==p.rosterId||a.startedAt!==b.startedAt)throw fail(409,'identity_mismatch');
    };
    const existing=store.read().activities[id];if(existing)check(existing);
    const snap=existing?null:await getSnapshot(p);
    const result=store.change(s=>{
      if(s.devices[req.deviceId]?.revoked)throw fail(401,'unauthorized');
      const a=s.activities[id];
      if(a){check(a);if(a.token!==b.pushToken||a.env!==b.apnsEnvironment){a.token=b.pushToken;a.env=b.apnsEnvironment;a.version++;a.force=true;a.nextAttempt=0;a.failures=0;}return {created:false,expiresAt:a.expiresAt};}
      const active=Object.values(s.activities).filter(a=>a.status!=='ended'&&a.expiresAt>seconds());
      if(active.length>=cfg.maxActivities||active.filter(a=>a.deviceId===req.deviceId).length>=cfg.perDevice)throw fail(429,'activity_limit');
      const expiresAt=b.startedAt+28800;
      if(expiresAt<=seconds())throw fail(409,'activity_ended');
      s.activities[id]={id,...p,deviceId:req.deviceId,token:b.pushToken,env:b.apnsEnvironment,
        startedAt:b.startedAt,expiresAt,status:'active',version:1,state:snap.state,attributes:snap.attributes,
        force:true,failures:0,nextAttempt:0,pushTimestamp:0};
      return {created:true,expiresAt};
    });
    res.status(result.created?201:200).json({activityId:id,expiresAt:result.expiresAt});
  });
  app.get('/v1/activities/:id',(req,res)=>{
    const a=store.read().activities[req.params.id];if(!a||a.deviceId!==req.deviceId)throw fail(404,'not_found');
    res.json({activityId:a.id,status:a.status,expiresAt:a.expiresAt,state:a.state,attributes:a.attributes,lastAcceptedAt:a.sentAt??null});
  });
  app.delete('/v1/activities/:id',(req,res)=>{
    store.change(s=>{const a=s.activities[req.params.id];if(a?.deviceId===req.deviceId){a.status='ended';a.endedAt=seconds();a.token=null;a.version++;}});
    res.status(204).end();
  });
  app.get('/v1/devices/me',(req,res)=>{
    res.set('Cache-Control','no-store').json({deviceId:req.deviceId});
  });
  app.delete('/v1/devices/me',(req,res)=>{
    revokeDevice(store,req.deviceId);
    res.status(204).end();
  });
  app.use((req,res)=>res.status(404).json({error:'not_found'}));
  app.use((err,req,res,next)=>{
    const status=err.type==='entity.parse.failed'?400:err.type==='entity.too.large'?413:err.status??500;
    if(status===429||status===503)res.set('Retry-After','75');
    res.status(status).json({error:status===500?'internal_error':err.type??err.message});
  });
  return app;
}
