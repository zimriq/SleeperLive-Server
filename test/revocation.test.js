import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../registrations.js';
import {revokeDevice,revokeOffline} from '../revoke-device.js';
const id='a'.repeat(32),other='b'.repeat(32);
function seed(store){store.change(s=>{
  s.devices[id]={hash:'secret-hash',attestKeyId:'retained-key',attestPublicKey:'old-public-key'};
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
    assert.equal('hash' in state.devices[id],false);
    assert.equal('attestPublicKey' in state.devices[id],false);
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


test('legacy revoked records are minimized only on commit, with replay IDs retained',()=>{
  const dir=mkdtempSync(join(tmpdir(),'retention-')),path=join(dir,'state.sqlite');
  let store=openStore(path);store.close();
  // Seed an old-format database offline, before opening the application store.
  const legacy={devices:{
    [id]:{hash:'old-hash',attestPublicKey:'old-public-key',attestKeyId:'blocked-key',revoked:true,createdAt:123},
    [other]:{hash:'active-hash',attestPublicKey:'active-public-key',attestKeyId:'active-key'}
  },activities:{ending:{deviceId:id,status:'ending',token:'needed-for-end'}}};
  const db=new DatabaseSync(path);
  db.prepare('UPDATE state SET value=? WHERE id=1').run(JSON.stringify(legacy));db.close();
  store=openStore(path);
  try{
    assert.throws(()=>store.change(()=>{throw Error('rollback');}));
    assert.deepEqual(store.read(),legacy,'failed mutations must not perform cleanup');
    store.change(()=>{});
    const cleaned=store.read();
    assert.deepEqual(cleaned.devices[id],{attestKeyId:'blocked-key',revoked:true,createdAt:123});
    assert.deepEqual(cleaned.devices[other],legacy.devices[other]);
    assert.deepEqual(cleaned.activities,legacy.activities,'pending end tokens must survive');
    assert.equal(store.credentialHash(id),undefined);
    assert.equal(store.credentialHash(other),'active-hash');
    store.close();store=openStore(path);
    assert.deepEqual(store.read(),cleaned);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
