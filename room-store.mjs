import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';

// One Node process owns this directory. Multiple replicas require a transactional database.
export async function openRoomStore(dataDir){
  await mkdir(dataDir,{recursive:true,mode:0o700});
  const file=join(dataDir,'rooms.json');
  let saved=[];
  try{saved=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!Array.isArray(saved)||saved.some(r=>!r.id||!Array.isArray(r.players)||r.players.length!==2))throw new Error('대결 저장 파일 형식이 올바르지 않습니다. 백업을 확인하세요.');
  let rooms=new Map(saved.map(r=>[r.id,r]));
  for(const room of rooms.values())for(const p of room.players)if(p.status==='processing')p.status='waiting';
  let queue=Promise.resolve();
  return {
    get:id=>rooms.get(id),
    mutate(update){
      const operation=queue.catch(()=>{}).then(async()=>{
        const candidate=structuredClone(rooms);
        const result=update(candidate);
        try{
          await writeFile(file+'.tmp',JSON.stringify([...candidate.values()]),{mode:0o600,flush:true});
          await rename(file+'.tmp',file);
        }catch(e){await rm(file+'.tmp',{force:true}).catch(()=>{});throw e;}
        // Reads and successful responses only see a state whose save has completed.
        rooms=candidate;
        return result;
      });
      queue=operation;return operation;
    },
  };
}
