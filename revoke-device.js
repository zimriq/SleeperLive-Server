import { endActivity } from './activities.js';
import { logInfo } from './logging.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from './registrations.js';

export function revokeDevice(store, deviceId, {now=Date.now,log=logInfo}={}) {
  if(!/^[a-f0-9]{32}$/.test(deviceId))throw Error('Invalid device ID');
  return store.change(state=>{
    const device=state.devices[deviceId];
    if(!device)return {found:false,activitiesQueued:0};
    device.revoked=true;
    let activitiesQueued=0;
    for(const [id,activity] of Object.entries(state.activities)){
      if(activity.deviceId!==deviceId)continue;
      if(activity.status==='awaiting_token'){
        endActivity(activity,'device_revoked',Math.floor(now()/1000));
        activity.version++;
        log(`event=ended activity=${id.slice(0,8)} reason=device_revoked`);
      }
      if(activity.status==='active'){
        activity.endedReason='device_revoked';delete activity.endReason;
        activity.status='ending';activity.version++;activity.nextAttempt=0;
        activitiesQueued++;
      }
    }
    // Retain the attestation key record so revoked keys cannot enroll again.
    return {found:true,activitiesQueued};
  });
}

export function revokeFromDatabase(args, env=process.env) {
  if(args.length!==2||!['--live','--server-stopped'].includes(args[0])||!/^[a-f0-9]{32}$/.test(args[1])){
    throw Error('Use: npm run revoke-device -- --live <32-character-device-id>');
  }
  // No default path: require an explicit existing database to avoid creating or
  // silently modifying the wrong local database. --live requires the running
  // server to support credential refresh across database connections.
  const path=env.DB_PATH;
  if(!path||path===':memory:'||!existsSync(path))throw Error('DB_PATH must name an existing server database');
  const store=openStore(path);
  try{return revokeDevice(store,args[1]);}finally{store.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const result=revokeFromDatabase(process.argv.slice(2));
    if(!result.found){console.error('Device not found; no device was revoked.');process.exitCode=1;}
    else {
      console.log(`Device revoked. Activities queued to end: ${result.activitiesQueued}.`);
      if (process.argv[2]==='--server-stopped') console.log('Start the server before testing access.');
    }
  }catch(error){
    console.error('Revocation failed:',error.message);
    process.exitCode=1;
  }
}
