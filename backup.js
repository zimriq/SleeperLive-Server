import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, linkSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export function retentionDays(value) {
  if(value===undefined)return null;
  if(!/^[1-9]\d*$/.test(value)||Number(value)>365)throw Error('BACKUP_RETENTION_DAYS must be an integer from 1 to 365');
  return Number(value);
}

function backupTime(name) {
  const match=/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z\.sqlite$/.exec(name);
  if(!match)return null;
  const time=Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  if(!Number.isFinite(time)||new Date(time).toISOString().replaceAll(':','-')+'.sqlite'!==name)return null;
  return time;
}

// Never follow symlinks or delete the live database, including hard links to it.
function prune({dir,path,keep,days,now}) {
  if(days===null)return 0;
  const cutoff=now-days*86400000,source=statSync(path);
  let removed=0;
  for(const name of readdirSync(dir)){
    const time=backupTime(name),file=join(dir,name);
    if(time===null||time>=cutoff||file===keep)continue;
    const info=lstatSync(file);
    if(!info.isFile()||info.mtimeMs>=cutoff)continue;
    if(info.dev===source.dev&&info.ino===source.ino)continue;
    unlinkSync(file);removed++;
  }
  return removed;
}

export async function createBackup({path,dir,days=null,now=Date.now()}) {
  if(days!==null)days=retentionDays(String(days));
  path=realpathSync(path);dir=resolve(dir);
  const stamp=new Date(now).toISOString().replaceAll(':','-');
  mkdirSync(dir,{recursive:true,mode:0o700});
  const output=join(dir,stamp+'.sqlite'),partial=join(dir,`.backup-${randomUUID()}.partial`);
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    await backup(db,partial);
    chmodSync(partial,0o600);
    const check=new DatabaseSync(partial,{readOnly:true});
    try{
      if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('Backup integrity check failed');
    }finally{check.close();}
    // Exclusive publication: a concurrent backup cannot overwrite a copy.
    linkSync(partial,output);
  }finally{
    db.close();
    try{unlinkSync(partial);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const removed=prune({dir,path,keep:output,days,now});
  return {output,removed,days};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  process.umask(0o077);
  try{
    const result=await createBackup({path:process.env.DB_PATH??'./data/server.sqlite',
      dir:process.env.BACKUP_DIR??'./data/backups',days:retentionDays(process.env.BACKUP_RETENTION_DAYS)});
    console.log(`Backup written: ${result.output}`);
    console.log(result.days===null?'Retention disabled; no older backups removed.':`Retention: ${result.days} days; removed ${result.removed} older backups.`);
  }catch(error){
    console.error(`Backup/retention operation did not complete: ${error.message}`);
    process.exitCode=1;
  }
}
