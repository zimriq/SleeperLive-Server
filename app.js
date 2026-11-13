import { activityRouter } from './activity-router.js';
import { logInfo, logError } from './logging.js';
import express from 'express';
import { revokeDevice } from './revoke-device.js';
import { clientIP } from './client-ip.js';
import { createApiRateLimiter } from './rate-limit.js';
import { enrollmentRouter } from './enrollment.js';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
const hash = text=>createHash('sha256').update(text).digest('hex');
const equals=(a,b)=>timingSafeEqual(Buffer.from(hash(a),'hex'),Buffer.from(hash(b),'hex'));
const fail=(status,error)=>Object.assign(new Error(error),{status});
export function createApp({cfg,store,sleeper,estimator,now=Date.now,poller,log=logInfo,errorLog=logError}) {
  const app=express(), seconds=()=>Math.floor(now()/1000), limit=createApiRateLimiter(now);
  app.disable('x-powered-by');app.set('trust proxy',false);
  app.use((_req,res,next)=>{res.set('X-Content-Type-Options','nosniff');next();});
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
    // Rejected devices must not spend other users' shared admission allowance.
    if(req.deviceId)limit(`device:${req.deviceId}`,30);
    budget.total++;budget.ips.set(req.clientIP,count+1);
    next();
  });
  app.use('/v1/enrollment', enrollmentRouter({cfg,store,limit,now}));
  app.use(express.json({limit:'8kb',inflate:false}));
  const healthStartedAt=seconds(), healthGrace=(cfg.pollMs??75000)*3/1000;
  // Completion measures poller progress, not whether every upstream request succeeds.
  app.get('/health',(_,res)=>{
    const lastRunAt=poller?.status().lastRunAt;
    const ok=!poller || seconds()-(lastRunAt??healthStartedAt)<=healthGrace;
    res.status(ok?200:503).set('Cache-Control','no-store').json({ok,mode:cfg.mode});
  });
  app.post('/v1/devices',(req,res)=>{
    res.set('Cache-Control','no-store');
    if(!(cfg.inviteEnabled ?? !cfg.attestEnabled))throw fail(404,'not_found');
    limit(`ip:${req.clientIP}`,10);
    if(typeof req.body?.inviteCode!=='string' || !equals(req.body.inviteCode,cfg.invite))throw fail(403,'invalid_invite');
    const id=randomBytes(16).toString('hex'), secret=randomBytes(32).toString('hex');
    store.change(s=>{
      if(Object.values(s.devices).filter(d=>!d.revoked).length>=cfg.maxDevices)throw fail(503,'device_limit');
      const at=seconds();
      s.devices[id]={hash:hash(secret),createdAt:at,lastSeenAt:at};
    });
    res.status(201).json({deviceId:id,deviceToken:`${id}.${secret}`});
  });
  app.use('/v1',(req,res,next)=>{
    // Recheck after body parsing: a concurrent request may have revoked the device.
    if(!req.deviceId||store.credentialHash(req.deviceId)!==req.credentialHash)
      return res.status(401).json({error:'unauthorized'});
    if (req.method!=='DELETE' || !/^\/devices\/me(?:\/data)?\/?$/i.test(req.path)) {
      res.once('finish',()=>{
        if (res.statusCode<200 || res.statusCode>=300) return;
        try { store.recordDeviceUse(req.deviceId,req.credentialHash,seconds()); }
        catch(error) { errorLog('device_activity_write_failed',error); }
      });
    }
    next();
  });
  app.use(activityRouter({cfg,store,sleeper,estimator,now,log}));
  app.get('/v1/devices/me',(req,res)=>{
    res.set('Cache-Control','no-store').json({deviceId:req.deviceId});
  });
  // Explicit erasure is separate from access revocation/replay protection.
  app.delete('/v1/devices/me/data',(req,res)=>{
    store.change(s=>{
      // An operator can revoke this credential between authentication and BEGIN.
      const device=s.devices[req.deviceId];
      if (!device || device.revoked || device.hash!==req.credentialHash) throw fail(401,'unauthorized');
      for(const [id,activity] of Object.entries(s.activities)){
        if(activity.deviceId!==req.deviceId)continue;
        log(`event=ended activity=${id.slice(0,8)} reason=device_data_deleted`);
        delete s.activities[id];
      }
      delete s.devices[req.deviceId];
    });
    res.set('Cache-Control','no-store').status(204).end();
  });
  app.delete('/v1/devices/me',(req,res)=>{
    revokeDevice(store,req.deviceId,{now,log});
    res.status(204).end();
  });
  app.use((_req,res)=>res.status(404).json({error:'not_found'}));
  app.use((err,_req,res,_next)=>{
    const status=err.type==='entity.parse.failed'?400:err.type==='entity.too.large'?413:err.status??500;
    if(status===500)errorLog('request_failed',err);
    if(status===429||status===503)res.set('Retry-After','75');
    res.status(status).json({error:status===500?'internal_error':err.type??err.message});
  });
  return app;
}
