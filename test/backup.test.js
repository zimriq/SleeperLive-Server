import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, utimesSync, symlinkSync, linkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackup, retentionDays } from '../backup.js';

const now=Date.parse('2026-11-03T12:00:00.000Z');
const name=time=>new Date(time).toISOString().replaceAll(':','-')+'.sqlite';
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'sleeper-backup-')),path=join(root,'live.sqlite'),dir=join(root,'backups');
  mkdirSync(dir);
  const db=new DatabaseSync(path);db.exec('CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES (\'preserved\')');db.close();
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const old=(filename=name(now-10*86400000))=>{
    const file=join(dir,filename);writeFileSync(file,'old');utimesSync(file,new Date(now-10*86400000),new Date(now-10*86400000));return file;
  };
  return {root,path,dir,old};
}

test('retention is opt-in and rejects zero, fractional and unbounded values',()=>{
  assert.equal(retentionDays(undefined),null);
  assert.equal(retentionDays('7'),7);assert.equal(retentionDays('365'),365);
  for(const value of ['','0','-1','1.5','366','Infinity',' 7','07'])assert.throws(()=>retentionDays(value));
});

test('backup preserves data and old copies by default, with private file permissions',async t=>{
  const f=fixture(t),old=f.old();
  const result=await createBackup({...f,now});
  assert.equal(result.removed,0);assert.ok(existsSync(old));
  assert.equal(statSync(result.output).mode&0o777,0o600);
  const db=new DatabaseSync(result.output,{readOnly:true});
  try{assert.equal(db.prepare('SELECT value FROM sample').get().value,'preserved');}finally{db.close();}
  assert.equal(readdirSync(f.dir).some(n=>n.endsWith('.partial')),false);
});

test('enabled retention deletes only old generated copies after a valid replacement exists',async t=>{
  const f=fixture(t),old=f.old(),unrelated=f.old('manual.sqlite');
  const recent=f.old(name(now-86400000)),modified=f.old(name(now-11*86400000));
  utimesSync(modified,new Date(now),new Date(now));
  const result=await createBackup({...f,days:7,now});
  assert.equal(result.removed,1);assert.equal(existsSync(old),false);
  for(const file of [unrelated,recent,modified,result.output])assert.ok(existsSync(file));
});

test('retention preserves symlinks, directories, invalid dates and live database hard links',async t=>{
  const f=fixture(t),outside=join(f.root,'outside.sqlite');writeFileSync(outside,'untouched');
  const symbolic=join(f.dir,name(now-10*86400000));symlinkSync(outside,symbolic);
  const directory=join(f.dir,name(now-11*86400000));mkdirSync(directory);
  const hard=join(f.dir,name(now-12*86400000));linkSync(f.path,hard);
  utimesSync(hard,new Date(now-12*86400000),new Date(now-12*86400000));
  const invalid=f.old('2026-02-30T12-00-00.000Z.sqlite');
  const result=await createBackup({...f,days:7,now});
  assert.equal(result.removed,0);
  for(const file of [symbolic,directory,hard,invalid])assert.ok(existsSync(file));
  assert.equal(readFileSync(outside,'utf8'),'untouched');
});

test('missing source and destination collision do not prune or overwrite backups',async t=>{
  const f=fixture(t),old=f.old(),existing=join(f.dir,name(now));writeFileSync(existing,'keep');
  await assert.rejects(createBackup({...f,path:join(f.root,'missing.sqlite'),days:7,now}));
  await assert.rejects(createBackup({...f,days:7,now}));
  assert.ok(existsSync(old));assert.equal(readFileSync(existing,'utf8'),'keep');
  assert.equal(readdirSync(f.dir).some(n=>n.endsWith('.partial')),false);
});

test('corrupt source does not prune older backups',async t=>{
  const f=fixture(t),old=f.old();writeFileSync(f.path,'invalid SQLite');
  await assert.rejects(createBackup({...f,days:7,now}));
  assert.ok(existsSync(old));
});
