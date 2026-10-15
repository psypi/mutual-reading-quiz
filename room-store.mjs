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
  // Preserve invitations and human work from older saves; discard obsolete derived fields.
  for(const room of rooms.values()){
    room.name=typeof room.name==='string'&&room.name.trim()?room.name.trim():`이전 대결 ${room.id.slice(0,6)}`;
    room.createdAt=Number.isSafeInteger(room.createdAt)?room.createdAt:null;
    room.closedAt=Number.isSafeInteger(room.closedAt)?room.closedAt:null;
    // Existing matches with submitted work are already in progress; never lock that work away.
    room.startedAt=room.startedAt??(room.players.some(p=>p.task||p.answer||p.peer)?1:null);
    room.phase=room.phase||(!room.startedAt?'lobby':room.players.every(p=>p.peer)?'results':room.players.every(p=>p.answer)?'grading':room.players.every(p=>p.task)?'answers':'problems');
    room.players=room.players.map((p,i)=>({
    token:p.token,session:p.session,name:p.name||(room.startedAt!==null?`참가자 ${i+1}`:''),task:p.task?Object.fromEntries(['book','range','question','core','rubric'].map(k=>[k,p.task[k]||''])):null,
    draftAnswer:typeof p.draftAnswer==='string'?p.draftAnswer:'',draftRevision:Number.isSafeInteger(p.draftRevision)?p.draftRevision:0,
    answer:p.answer||null,peer:p.peer?{score:p.peer.score,reason:p.peer.reason}:null,
    }));
  }
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
