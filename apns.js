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
  if (status === 410 && reason === 'Unregistered') return 'dead';
  // BadDeviceToken can mean a wrong environment/topic: don't permanently discard on configuration errors.
  return 'retry';
}
export function createAPNs(cfg, now = Date.now) {
  if (cfg.mode === 'dry-run') return { async send(message) { return {kind:'ok', dryRun:true}; }, close() {} };
  const key = createPrivateKey(cfg.key);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('APNs requires a P-256 private key');
  let jwt, signedAt = 0;
  const sessions = new Map();
  function authorization() {
    const t = Math.floor(now()/1000);
    if (!jwt || t-signedAt >= 2700) {
      const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const input = `${enc({alg:'ES256',kid:cfg.keyId})}.${enc({iss:cfg.teamId,iat:t})}`;
      jwt = `${input}.${sign('sha256', Buffer.from(input), {key,dsaEncoding:'ieee-p1363'}).toString('base64url')}`;
      signedAt = t;
    }
    return `bearer ${jwt}`;
  }
  function session(env) {
    const host = env === 'development' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    let s = sessions.get(host);
    if (s && !s.closed && !s.destroyed) return s;
    s = http2.connect(host); sessions.set(host,s);
    const remove = () => { if(sessions.get(host)===s) sessions.delete(host); };
    s.on('error', () => {remove();s.destroy();}); s.on('goaway', () => {remove();s.close();}); s.on('close', remove);
    return s;
  }
  return {
    async send(message) {
      const body = JSON.stringify(payload(message));
      if (Buffer.byteLength(body)>4096) return {kind:'retry',reason:'PayloadTooLarge'};
      try {
        return await new Promise(resolve => {
          let req, done=false, status, data='';
          const finish = result => {if(done)return;done=true;clearTimeout(timer);resolve(result);};
          const timer = setTimeout(()=>{finish({kind:'retry',reason:'Timeout'});req?.close();},12000);
          try {
            req=session(message.env).request({':method':'POST',':path':`/3/device/${message.token}`,
              authorization:authorization(),'apns-topic':`${cfg.bundleId}.push-type.liveactivity`,
              'apns-push-type':'liveactivity','apns-priority':pushPriority(message),
              'apns-expiration':String(Math.floor(now()/1000)+300),'content-type':'application/json'});
            req.setEncoding('utf8'); req.on('response', h=>{status=h[':status'];});
            req.on('data', c=>{if(data.length<8192)data+=c;});
            req.on('error', ()=>finish({kind:'retry',reason:'ConnectionError'}));
            req.on('end', ()=>{let reason;try{reason=JSON.parse(data).reason;}catch{}finish({kind:classify(status,reason),status,reason});});
            req.on('close',()=>finish({kind:'retry',reason:'ConnectionClosed'})); req.end(body);
          }catch{finish({kind:'retry',reason:'ConnectionError'});}
        });
      }catch {return {kind:'retry',reason:'TransportError'};}
    },
    close(){for(const s of sessions.values())s.destroy();sessions.clear();},
  };
}
