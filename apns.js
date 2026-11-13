import http2 from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';
export function payload(message) {
  return { aps: { timestamp: message.timestamp, event: message.event, 'content-state': message.state,
    ...(message.event === 'end' ? {'dismissal-date': message.timestamp + 900} : {'stale-date': message.state.updatedAt + 360}) } };
}
export function pushPriority(message) {
  return message.event === 'end' || message.priority === 10 ? '10' : '5';
}
export function classify(status, reason) {
  if (status === 200) return 'ok';
  if (status === 410 && ['Unregistered', 'ExpiredToken'].includes(reason)) return 'dead';
  // BadDeviceToken can mean a wrong environment/topic: don't permanently discard on configuration errors.
  return 'retry';
}
export function createAPNs(cfg, now = Date.now, {
  connect=host=>http2.connect(host), requestTimeoutMs=12000, sessionIdleMs=60000,
  errorLog=record=>console.error(JSON.stringify({level:'error',...record})),
} = {}) {
  for (const value of [requestTimeoutMs,sessionIdleMs])
    if (!Number.isInteger(value) || value<1) throw new Error('Invalid APNs timeout');
  if (cfg.mode === 'dry-run') return { async send() { return {kind:'ok', dryRun:true}; }, close() {} };
  function signer(pem, keyId) {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('APNs requires a P-256 private key');
    let jwt, signedAt = 0;
    return () => {
      const t = Math.floor(now()/1000);
      if (!jwt || t-signedAt >= 2700) {
        const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
        const input = `${enc({alg:'ES256',kid:keyId})}.${enc({iss:cfg.teamId,iat:t})}`;
        jwt = `${input}.${sign('sha256', Buffer.from(input), {key,dsaEncoding:'ieee-p1363'}).toString('base64url')}`;
        signedAt = t;
      }
      return `bearer ${jwt}`;
    };
  }
  const defaultAuthorization = signer(cfg.key, cfg.keyId);
  const productionAuthorization = cfg.productionKey ? signer(cfg.productionKey, cfg.productionKeyId) : defaultAuthorization;
  const sessions = new Map(), failures = new Map();
  const knownReasons=new Set(['BadDeviceToken','DeviceTokenNotForTopic','BadTopic','TopicDisallowed',
    'InvalidProviderToken','ExpiredProviderToken','MissingProviderToken','Forbidden','TooManyRequests',
    'InternalServerError','ServiceUnavailable','Shutdown','Timeout','ConnectionError','ConnectionClosed',
    'TransportError','PayloadTooLarge']);
  function observe(env,result) {
    if(result.kind!=='retry'){failures.delete(env);return result;}
    const reason=knownReasons.has(result.reason)?result.reason:'Other';
    const signature=`${result.status??''}:${result.reason??''}`;
    const previous=failures.get(env);
    const count=previous?.signature===signature?previous.count+1:1;
    failures.set(env,{signature,count});
    if(count===3)errorLog({event:'apns_repeated_failure',environment:env,
      status:result.status??null,reason,consecutiveFailures:count});
    return result;
  }
  function session(env) {
    const host = env === 'development' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    let s = sessions.get(host);
    if (s && !s.closed && !s.destroyed) return s;
    s = connect(host); sessions.set(host,s);
    const remove = () => { if(sessions.get(host)===s) sessions.delete(host); };
    s.setTimeout(sessionIdleMs,()=>{remove();s.destroy();});
    s.on('error', () => {remove();s.destroy();}); s.on('goaway', () => {remove();s.close();}); s.on('close', remove);
    return s;
  }
  return {
    async send(message) {
      const body = JSON.stringify(payload(message));
      if (Buffer.byteLength(body)>4096) return observe(message.env,{kind:'retry',reason:'PayloadTooLarge'});
      try {
        const result = await new Promise(resolve => {
          let req, connection, done=false, status, data='';
          const finish = result => {if(done)return;done=true;clearTimeout(timer);resolve(result);};
          const timer = setTimeout(()=>{
            finish({kind:'retry',reason:'Timeout'});
            // This session may have been replaced already; never remove its replacement.
            for(const [host,s] of sessions)if(s===connection)sessions.delete(host);
            connection?.destroy();
          },requestTimeoutMs);
          try {
            connection=session(message.env);
            req=connection.request({':method':'POST',':path':`/3/device/${message.token}`,
              authorization:message.env === 'development' ? defaultAuthorization() : productionAuthorization(),'apns-topic':`${cfg.bundleId}.push-type.liveactivity`,
              'apns-push-type':'liveactivity','apns-priority':pushPriority(message),
              'apns-expiration':String(Math.floor(now()/1000)+300),'content-type':'application/json'});
            req.setEncoding('utf8'); req.on('response', h=>{status=h[':status'];});
            req.on('data', c=>{if(data.length<8192)data+=c;});
            req.on('error', ()=>finish({kind:'retry',reason:'ConnectionError'}));
            req.on('end', ()=>{let reason;try{reason=JSON.parse(data).reason;}catch{}finish({kind:classify(status,reason),status,reason});});
            req.on('close',()=>finish({kind:'retry',reason:'ConnectionClosed'})); req.end(body);
          }catch{finish({kind:'retry',reason:'ConnectionError'});}
        });
        return observe(message.env,result);
      }catch {return observe(message.env,{kind:'retry',reason:'TransportError'});}
    },
    close(){for(const s of sessions.values())s.destroy();sessions.clear();},
  };
}
