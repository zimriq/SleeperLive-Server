import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
const path=process.env.DB_PATH??'./data/server.sqlite';
const dir=process.env.BACKUP_DIR??'./data/backups';
mkdirSync(dir,{recursive:true,mode:0o700});
const db=new DatabaseSync(path,{readOnly:true});
const output=`${dir}/${new Date().toISOString().replaceAll(':','-')}.sqlite`;
await backup(db,output);db.close();console.log(`Backup written: ${output}`);
