import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from './registrations.js';

export function revokeDevice(store, deviceId) {
  if(!/^[a-f0-9]{32}$/.test(deviceId))throw Error('Invalid device ID');
  return store.change(state=>{
    const device=state.devices[deviceId];
    if(!device)return {found:false,activitiesQueued:0};
    device.revoked=true;
    let activitiesQueued=0;
    for(const activity of Object.values(state.activities)){
      if(activity.deviceId===deviceId&&activity.status==='active'){
        activity.status='ending';activity.version++;activity.nextAttempt=0;
        activitiesQueued++;
      }
    }
    // Retain the attestation key record so revoked keys cannot enroll again.
    return {found:true,activitiesQueued};
  });
}

export function revokeOffline(args, env=process.env) {
  if(args.length!==2||args[0]!=='--server-stopped'||!/^[a-f0-9]{32}$/.test(args[1])){
    throw Error('Stop the server, then use: npm run revoke-device -- --server-stopped <32-character-device-id>');
  }
  // No default path: require an explicit existing database to avoid creating or
  // silently modifying the wrong local database. The flag is operator acknowledgement,
  // not an automatic check that no other process is running.
  const path=env.DB_PATH;
  if(!path||path===':memory:'||!existsSync(path))throw Error('DB_PATH must name an existing server database');
  const store=openStore(path);
  try{return revokeDevice(store,args[1]);}finally{store.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const result=revokeOffline(process.argv.slice(2));
    if(!result.found){console.error('Device not found; no device was revoked.');process.exitCode=1;}
    else console.log(`Device revoked. Activities queued to end after restart: ${result.activitiesQueued}. Restart the server before testing access.`);
  }catch{
    console.error('Revocation failed. Stop the server, set DB_PATH to its existing database, and run: npm run revoke-device -- --server-stopped <32-character-device-id>');
    process.exitCode=1;
  }
}
