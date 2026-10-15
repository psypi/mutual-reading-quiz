import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {openRoomStore} from './room-store.mjs';
import {serverConfig} from './config.mjs';

class RequestError extends Error{constructor(status,message,code){super(message);this.status=status;this.code=code;}}
const fail=(status,message,code)=>{throw new RequestError(status,message,code);};
const token=()=>randomBytes(18).toString('hex');
const hex=(n)=>randomBytes(n).toString('hex');
const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
async function body(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>20000)fail(413,'요청이 너무 큽니다.');}try{const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'요청 형식이 올바르지 않습니다.');return value;}catch{fail(400,'요청 형식이 올바르지 않습니다.');}}
function text(v,label,max){if(typeof v!=='string'||!v.trim())fail(400,`${label}을(를) 입력하세요.`);if(v.trim().length>max)fail(400,`${label}은(는) ${max}자 이하로 입력하세요.`);return v.trim();}
function draft(v){if(typeof v!=='string'||v.length>4000)fail(400,'답안은 4000자 이하로 입력하세요.');return v;}
function taskInput(v){if(!v||typeof v!=='object')fail(400,'문제를 입력하세요.');return Object.fromEntries([['book','책 제목',200],['range','독서 범위',200],['question','문제',1500],['core','핵심 답',2000],['rubric','채점 기준',2000]].map(([k,l,m])=>[k,text(v[k],l,m)]));}
function participant(rooms,input){const room=rooms.get(input.id),index=room?.players.findIndex(p=>p.session&&p.session===input.session);if(!room||index<0)fail(403,'참가 권한이 없습니다. 자신의 초대 링크로 참가해 주세요.','UNAUTHORIZED');if((input.index!==undefined&&input.index!==index)||(input.token!==undefined&&input.token!==room.players[index].token))fail(403,'다른 참가자의 자리에 접근할 수 없습니다.','ROLE_MISMATCH');return {room,index,me:room.players[index],other:room.players[1-index]};}
function view(room,index,presence){
  const finished=room.phase==='results';
  const participants=room.players.map((p,i)=>({name:p.name||`참가자 ${i+1}`,book:p.task?.book||null,range:p.task?.range||'',joined:!!p.session,online:presence.players[i].online,ready:presence.players[i].ready,hasTask:!!p.task,hasAnswer:!!p.answer,hasEvaluated:!!p.peer,status:!presence.players[i].online?(!room.startedAt?'초대 대기 중':'재접속 대기 중'):!room.startedAt?'입장 완료':room.phase==='problems'?(p.task?'문제 제출 완료':'문제 작성 중'):room.phase==='answers'?(p.answer?'답변 제출 완료':'답변 작성 중'):room.phase==='grading'?(p.peer?'채점 완료':'채점 중'):finished?'대결 완료':'입장 완료'}));
  const me=room.players[index],other=room.players[1-index];
  const result={id:room.id,name:room.name,index,phase:room.phase,stage:{lobby:0,problems:1,answers:2,grading:3,results:4}[room.phase],startedAt:room.startedAt,finished,participants,lobby:{opponentStatus:presence.players[1-index].online?'상대 입장 완료':!room.startedAt?'상대 초대 대기 중':'상대 재접속 대기 중'},myTask:me.task||null,publicTasks:room.players.map(p=>p.task?{book:p.task.book,range:p.task.range,question:p.task.question}:null),me:{name:me.name||''},statuses:{tasks:room.players.map(p=>!!p.task),answers:room.players.map(p=>!!p.answer),evaluations:room.players.map(p=>!!p.peer)}};
  if(room.phase==='answers')result.answers=room.players.map(p=>({draft:p.answer??p.draftAnswer??'',submitted:!!p.answer,revision:p.draftRevision||0}));
  if(['grading','results'].includes(room.phase))result.answers=room.players.map(p=>({draft:p.answer||'',submitted:!!p.answer}));
  if(room.phase==='grading')result.peerAnswer=other.answer;
  if(finished)result.results=room.players.map((p,i)=>({name:p.name||`참가자 ${i+1}`,score:room.players[1-i].peer.score,feedback:room.players[1-i].peer.reason}));
  return result;
}
export async function createQuizServer({dataDir=serverConfig().dataDir,now=Date.now,presenceTimeoutMs=6000}={}){
  const store=await openRoomStore(dataDir),presences=new Map();let operations=Promise.resolve();
  function serial(op){const result=operations.catch(()=>{}).then(op);operations=result;return result;}
  function state(room){if(!presences.has(room.id))presences.set(room.id,{players:room.players.map(()=>({online:false,ready:false,clients:new Map(),closed:new Set()}))});return presences.get(room.id);}
  function refresh(room,p){const time=now();for(const x of p.players){for(const [id,seen]of x.clients)if(time-seen>=presenceTimeoutMs)x.clients.delete(id);x.online=x.clients.size>0;}if(room.phase==='lobby'&&p.players.some(x=>!x.online))for(const x of p.players)x.ready=false;}
  function connection(input){if(typeof input.clientId!=='string'||!/^[a-f0-9]{32}$/.test(input.clientId))fail(400,'접속 정보가 올바르지 않습니다.');}
  function touch(room,index,input){const p=state(room);refresh(room,p);const own=p.players[index];if(own.closed.has(input.clientId))fail(409,'종료된 접속입니다. 다시 입장해 주세요.','CONNECTION_CLOSED');own.clients.set(input.clientId,now());own.online=true;return p;}
  return http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try{
      if(req.method==='POST'&&req.headers.origin){try{if(new URL(req.headers.origin).host!==req.headers.host)fail(403,'다른 사이트에서 보낸 요청은 허용하지 않습니다.');}catch(e){if(e instanceof RequestError)throw e;fail(403,'요청 출처가 올바르지 않습니다.');}}
      if(req.url==='/healthz'&&req.method==='GET')return send(res,200,{ok:true});
      if(req.url==='/api/rooms/list'&&req.method==='POST'){
        const input=await body(req);if(!Array.isArray(input.credentials)||input.credentials.length>100)fail(400,'방 목록 요청이 올바르지 않습니다.');
        const rooms=input.credentials.flatMap(credential=>{if(!credential||typeof credential.id!=='string'||typeof credential.token!=='string'||typeof credential.session!=='string')return [];const room=store.get(credential.id);if(!room||room.closedAt!==null||room.players[0].token!==credential.token||room.players[0].session!==credential.session)return [];return [{id:room.id,name:room.name,phase:room.phase,createdAt:room.createdAt}];});
        return send(res,200,{rooms:[...new Map(rooms.map(room=>[room.id,room])).values()].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))});
      }
      if(req.url==='/api/rooms'&&req.method==='POST'){
        const input=await body(req),name=text(input.name,'방 이름',60);
        const result=await store.mutate(rooms=>{const id=token(),session=hex(32),clientId=hex(16),players=Array.from({length:2},()=>({token:token(),session:null,name:'',task:null,draftAnswer:'',draftRevision:0,answer:null,peer:null}));players[0].session=session;const room={id,name,createdAt:now(),closedAt:null,phase:'lobby',startedAt:null,players};rooms.set(id,room);return {id,name,token:players[0].token,session,clientId,index:0};});
        const room=store.get(result.id),p=state(room).players[0];p.clients.set(result.clientId,now());p.online=true;return send(res,201,result);
      }
      if(req.url==='/api/join'&&req.method==='POST'){
        const input=await body(req);connection(input);const result=await serial(async()=>{const claimed=await store.mutate(rooms=>{const room=rooms.get(input.id);if(!room)fail(403,'참가 링크가 올바르지 않습니다.','INVALID_INVITE');const index=room.players.findIndex(p=>p.token===input.token),player=room.players[index];if(!player)fail(403,'참가 링크가 올바르지 않습니다.','INVALID_INVITE');if(input.index!==undefined&&input.index!==index)fail(403,'초대 링크와 참가자 자리가 일치하지 않습니다.','ROLE_MISMATCH');if(room.closedAt!==null)fail(410,'이 방은 해체되었습니다. 더 이상 입장할 수 없습니다.','ROOM_CLOSED');if(player.session&&player.session===input.session)return {index};if(room.players.every(p=>p.session))fail(409,'두 참가자 자리가 모두 찼습니다. 이 대결에 참가할 수 없습니다.','ROOM_FULL');if(player.session)fail(409,'이 초대 링크의 자리는 이미 다른 브라우저가 사용 중입니다. 참가할 수 없습니다.','SEAT_TAKEN');if(typeof input.session!=='string'||!/^[a-f0-9]{64}$/.test(input.session))fail(400,'참가 세션이 올바르지 않습니다.');if(room.players.some(p=>p.session===input.session))fail(409,'각 참가자는 자신의 별도 세션을 사용해야 합니다.');player.session=input.session;return {index};});touch(store.get(input.id),claimed.index,input);return claimed;});return send(res,200,result);
      }
      if(req.url==='/api/room'&&req.method==='POST'){
        const input=await body(req);connection(input);if(!['get','leave','ready','startGame','setName','submitTask','startAnswers','saveAnswerDraft','submitAnswer','peer','getInvite','closeRoom'].includes(input.action))fail(400,'지원하지 않는 요청입니다.');
        const result=await serial(async()=>{
          let current=participant(store,input),presence=state(current.room);refresh(current.room,presence);
          if(current.room.closedAt!==null)fail(410,'이 방은 해체되었습니다. 더 이상 입장할 수 없습니다.','ROOM_CLOSED');
          if(input.action==='closeRoom'){if(current.index!==0)fail(403,'방 해체는 P1만 할 수 있습니다.','ROLE_MISMATCH');const closedAt=now();await store.mutate(rooms=>{rooms.get(input.id).closedAt=closedAt;});presences.delete(input.id);return {id:input.id,closedAt};}
          if(input.action==='getInvite'){if(current.index!==0)fail(403,'초대 링크는 P1만 확인할 수 있습니다.','ROLE_MISMATCH');return {inviteToken:current.room.players[1].token};}
          if(input.action==='leave'){
            if(current.room.phase==='answers'&&!current.me.answer&&Number.isSafeInteger(input.revision)&&input.revision>(current.me.draftRevision||0)){const value=draft(input.draft??'');await store.mutate(rooms=>{const p=participant(rooms,input).me;p.draftAnswer=value;p.draftRevision=input.revision;});current=participant(store,input);}
            const p=presence.players[current.index];p.clients.delete(input.clientId);p.closed.add(input.clientId);refresh(current.room,presence);return view(current.room,current.index,presence);
          }
          presence=touch(current.room,current.index,input);
          if(input.action==='ready'){
            if(current.room.phase==='lobby'){if(!current.me.name)fail(400,'먼저 참가자 이름을 입력하세요.');if(!presence.players.every(p=>p.online))fail(409,'상대 초대 대기 중입니다. 두 사람이 입장하면 준비할 수 있습니다.');if(typeof input.ready!=='boolean')fail(400,'준비 여부가 올바르지 않습니다.');presence.players[current.index].ready=input.ready;}
          }else if(input.action==='startGame'){
            if(current.index!==0)fail(403,'게임 시작은 P1만 할 수 있습니다.','ROLE_MISMATCH');if(current.room.phase!=='lobby'||!presence.players.every(p=>p.online&&p.ready))fail(409,'두 사람이 접속 중이고 준비 완료여야 시작할 수 있습니다.','NOT_READY');
            await store.mutate(rooms=>{const room=rooms.get(input.id);if(room.phase==='lobby'){room.startedAt=now();room.phase='problems';}});
          }else if(input.action!=='get'){
            await store.mutate(rooms=>{const {room,me,other}=participant(rooms,input);
              if(input.action==='setName'){if(room.phase!=='lobby')fail(400,'게임 시작 후 이름은 변경할 수 없습니다.');me.name=text(input.name,'이름',24);}
              else if(input.action==='submitTask'){if(room.phase!=='problems')fail(409,'문제를 제출할 단계가 아닙니다.','WRONG_PHASE');if(!me.name)fail(400,'먼저 이름을 저장해 주세요.');if(me.task)fail(400,'제출한 문제는 수정할 수 없습니다.');me.task=taskInput(input.task);if(room.players.every(p=>p.task))room.canStartAnswers=true;}
              else if(input.action==='startAnswers'){if(current.index!==0)fail(403,'답변 단계는 P1만 시작할 수 있습니다.','ROLE_MISMATCH');if(room.phase!=='problems'||!room.players.every(p=>p.task))fail(409,'두 사람이 문제를 제출한 뒤 답변 단계로 이동할 수 있습니다.','WRONG_PHASE');room.phase='answers';}
              else if(input.action==='saveAnswerDraft'){if(room.phase!=='answers')fail(409,'답안을 작성할 단계가 아닙니다.','WRONG_PHASE');if(me.answer)fail(409,'이미 제출한 답안은 수정할 수 없습니다.','LOCKED');if(!Number.isSafeInteger(input.revision)||input.revision<0)fail(400,'답안 버전이 올바르지 않습니다.');const value=draft(input.draft);if(input.revision>(me.draftRevision||0)){me.draftAnswer=value;me.draftRevision=input.revision;}}
              else if(input.action==='submitAnswer'){if(room.phase!=='answers')fail(409,'답안을 제출할 단계가 아닙니다.','WRONG_PHASE');if(me.answer)fail(400,'이미 답안을 제출했습니다.');me.answer=text(input.answer,'답안',4000);me.draftAnswer=me.answer;if(room.players.every(p=>p.answer))room.phase='grading';}
              else if(input.action==='peer'){if(room.phase!=='grading')fail(409,'채점할 단계가 아닙니다.','WRONG_PHASE');if(!other.answer||me.peer)fail(400,'평가할 답안이 없거나 평가가 이미 확정됐습니다.');if(!Number.isInteger(input.score)||input.score<0||input.score>100)fail(400,'점수는 0~100 사이의 정수로 입력하세요.');me.peer={score:input.score,reason:text(input.reason,'피드백',3000)};if(room.players.every(p=>p.peer))room.phase='results';}
            });
          }
          const {room,index}=participant(store,input);return view(room,index,presence);
        });return send(res,200,result);
      }
      if(req.method==='GET'&&['/','/app.js','/invite-url.mjs','/style.css'].includes(req.url)){const file=req.url==='/'?'index.html':req.url.slice(1),content=await readFile(new URL(`public/${file}`,import.meta.url));res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')||file.endsWith('.mjs')?'text/javascript; charset=utf-8':'text/css; charset=utf-8'});return res.end(content);}
      send(res,404,{message:'찾을 수 없습니다.'});
    }catch(e){if(e instanceof RequestError)return send(res,e.status,{message:e.message,code:e.code});send(res,503,{message:'서버 저장소 또는 처리에 문제가 있습니다. 저장 완료되지 않았으니 잠시 후 다시 시도해 주세요.'});}
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const {host,port,dataDir}=serverConfig();(await createQuizServer({dataDir})).listen(port,host,()=>console.log(`퀴즈 서버 실행: ${host}:${port}`));}
