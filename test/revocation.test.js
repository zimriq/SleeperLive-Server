import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../registrations.js';
import {revokeDevice,revokeOffline} from '../revoke-device.js';
const id='a'.repeat(32),other='b'.repeat(32);
function seed(store){store.change(s=>{
  s.devices[id]={hash:'secret-hash',attestKeyId:'retained-key'};
  s.devices[other]={hash:'other-hash'};
  for(const [key,deviceId,status] of [['active',id,'active'],['ending',id,'ending'],['ended',id,'ended'],['other',other,'active']]){
    s.activities[key]={deviceId,status,version:1,nextAttempt:100};
  }
});}
test('revocation removes access, preserves replay protection and only queues owned active activities',()=>{
  const store=openStore(':memory:');
  try{
    seed(store);
    assert.deepEqual(revokeDevice(store,id),{found:true,activitiesQueued:1});
    assert.equal(store.credentialHash(id),undefined);
    assert.equal(store.credentialHash(other),'other-hash');
    const state=store.read();
    assert.equal(state.devices[id].attestKeyId,'retained-key');
    assert.equal(state.activities.active.status,'ending');assert.equal(state.activities.active.version,2);
    assert.equal(state.activities.active.nextAttempt,0);
    assert.equal(state.activities.ending.version,1);assert.equal(state.activities.ended.status,'ended');
    assert.equal(state.activities.other.status,'active');
    assert.deepEqual(revokeDevice(store,id),{found:true,activitiesQueued:0});
    const before=store.read();
    assert.deepEqual(revokeDevice(store,'c'.repeat(32)),{found:false,activitiesQueued:0});
    assert.deepEqual(store.read(),before);
  }finally{store.close();}
});
test('offline command validates inputs and persists revocation across restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'offline-revoke-')),path=join(dir,'state.sqlite');
  try{
    assert.throws(()=>revokeOffline(['--server-stopped',id],{DB_PATH:path}));
    assert.equal(existsSync(path),false);
    let store=openStore(path);seed(store);store.close();
    assert.throws(()=>revokeOffline([id],{DB_PATH:path}));
    assert.throws(()=>revokeOffline(['--server-stopped','bad'],{DB_PATH:path}));
    assert.throws(()=>revokeOffline(['--server-stopped',id],{}));
    assert.deepEqual(revokeOffline(['--server-stopped',id],{DB_PATH:path}),{found:true,activitiesQueued:1});
    store=openStore(path);
    assert.equal(store.credentialHash(id),undefined);
    assert.equal(store.credentialHash(other),'other-hash');store.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
