import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {grade,validateTask} from './grading.mjs';
import {openRoomStore} from './room-store.mjs';
import {serverConfig} from './config.mjs';

class RequestError extends Error{
  constructor(status,message,code){super(message);this.status=status;this.code=code;}
}
const fail=(status,message,code)=>{throw new RequestError(status,message,code);};
const token=()=>randomBytes(18).toString('hex');
const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
async function body(req){
  let text='';for await(const chunk of req){text+=chunk;if(text.length>20000)fail(413,'요청이 너무 큽니다.');}
  try{const input=JSON.parse(text);if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'요청 형식이 올바르지 않습니다.');return input;}catch{fail(400,'요청 형식이 올바르지 않습니다.');}
}
function validate(task){try{validateTask(task);}catch(e){fail(400,e.message);}}
function participant(rooms,input){
  const room=rooms.get(input.id),index=room?.players.findIndex(p=>p.session&&p.session===input.session);
  if(!room||index<0)fail(403,'참가 권한이 없습니다. 자신의 초대 링크로 참가해 주세요.','UNAUTHORIZED');
  return {room,index,me:room.players[index],other:room.players[1-index]};
}
function view(room,index){
  const me=room.players[index],other=room.players[1-index];
  const finished=room.players.every(p=>p.status==='complete'&&p.peer);
  const clean=(p,task)=>({task:task?{question:task.question}:null,answer:p.answer,status:p.status,message:p.message,result:p.peer||finished?p.result:null,peer:p.peer,limits:p.limits});
  return {me:clean(me,other.task),other:clean(other,me.task),myTask:me.task,finished,scores:finished?room.players.map(p=>(p.result.total+p.peer.score)/2):null,index,participants:room.players.filter(p=>p.session).length};
}

export async function createQuizServer({dataDir=serverConfig().dataDir,grader=grade,getApiKey=()=>process.env.GROQ_API_KEY}={}){
  const store=await openRoomStore(dataDir);
  let busy=false;
  return http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try{
      if(req.method==='POST'&&req.headers.origin){
        try{if(new URL(req.headers.origin).host!==req.headers.host)fail(403,'다른 사이트에서 보낸 요청은 허용하지 않습니다.');}
        catch(e){if(e instanceof RequestError)throw e;fail(403,'요청 출처가 올바르지 않습니다.');}
      }
      if(req.url==='/healthz'&&req.method==='GET')return send(res,200,{ok:true});
      if(req.url==='/api/rooms'&&req.method==='POST'){
        const result=await store.mutate(rooms=>{
          const room={id:token(),players:Array.from({length:2},()=>({token:token(),task:null,status:'draft',peer:null}))};
          rooms.set(room.id,room);return {id:room.id,tokens:room.players.map(p=>p.token)};
        });
        return send(res,201,result);
      }
      if(req.url==='/api/join'&&req.method==='POST'){
        const input=await body(req);
        const result=await store.mutate(rooms=>{
          const room=rooms.get(input.id);if(!room)fail(403,'참가 링크가 올바르지 않습니다.','INVALID_INVITE');
          const index=room.players.findIndex(p=>p.token===input.token),player=room.players[index];
          if(player?.session&&player.session===input.session)return {index};
          if(room.players.every(p=>p.session))fail(409,'두 참가자 자리가 모두 찼습니다. 이 대결에 참가할 수 없습니다.','ROOM_FULL');
          if(!player)fail(403,'참가 링크가 올바르지 않습니다.','INVALID_INVITE');
          if(player.session)fail(409,'이 초대 링크의 자리는 이미 다른 브라우저가 사용 중입니다. 참가할 수 없습니다.','SEAT_TAKEN');
          if(typeof input.session!=='string'||!/^[a-f0-9]{64}$/.test(input.session))fail(400,'참가 세션이 올바르지 않습니다.');
          if(room.players.some(p=>p.session===input.session))fail(409,'각 참가자는 자신의 별도 세션을 사용해야 합니다.');
          player.session=input.session;return {index};
        });
        return send(res,200,result);
      }
      if(req.url==='/api/room'&&req.method==='POST'){
        const input=await body(req);
        if(!['get','setTask','submit','peer','grade'].includes(input.action))fail(400,'지원하지 않는 요청입니다.');
        if(input.action==='grade'){
          const key=getApiKey();
          const {me,other}=participant(store,input);
          if(!me.answer||me.status==='complete')fail(400,'채점할 답안이 없거나 완료되었습니다.');
          if(!key)fail(503,'서버 환경변수 GROQ_API_KEY가 필요합니다. 답안은 저장되어 있습니다.');
          if(busy)fail(429,'다른 답안을 채점 중입니다. 잠시 후 재시도를 눌러 주세요.');
          busy=true;
          try{
            await store.mutate(rooms=>{participant(rooms,input).me.status='processing';});
            let result;
            try{result=await grader({...other.task,answer:me.answer},key);}
            catch{
              await store.mutate(rooms=>{participant(rooms,input).me.status='error';});
              // Upstream exception text can contain credentials; never return it.
              fail(502,'AI 채점에 실패했습니다. 서버 설정을 확인하고 다시 시도해 주세요.');
            }
            await store.mutate(rooms=>{Object.assign(participant(rooms,input).me,result);});
          }finally{busy=false;}
        }else if(input.action!=='get'){
          await store.mutate(rooms=>{
            const {me,other}=participant(rooms,input);
            if(input.action==='setTask'){
              if(me.task||other.answer)fail(400,'확정된 출제는 수정할 수 없습니다.');
              validate({...input.task,answer:'검증'});
              me.task=Object.fromEntries(['book','question','core','rubric'].map(k=>[k,input.task[k]]));
            }else if(input.action==='submit'){
              if(!other.task||me.answer)fail(400,'문제가 없거나 이미 제출했습니다.');
              validate({...other.task,answer:input.answer});me.answer=input.answer;me.status='ready';
            }else if(input.action==='peer'){
              if(!other.answer||other.peer!==null)fail(400,'평가할 답안이 없거나 평가가 확정됐습니다.');
              if(!Number.isInteger(input.score)||input.score<0||input.score>100||typeof input.reason!=='string'||!input.reason.trim())fail(400,'0~100 정수 점수와 평가 근거를 입력하세요.');
              other.peer={score:input.score,reason:input.reason.slice(0,3000)};
            }
          });
        }
        const {room,index}=participant(store,input);return send(res,200,view(room,index));
      }
      if(req.method==='GET'&&['/','/app.js','/style.css'].includes(req.url)){
        const file=req.url==='/'?'index.html':req.url.slice(1);
        const content=await readFile(new URL(`public/${file}`,import.meta.url));
        res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8'});
        return res.end(content);
      }
      send(res,404,{message:'찾을 수 없습니다.'});
    }catch(e){
      if(e instanceof RequestError)return send(res,e.status,{message:e.message,code:e.code});
      send(res,503,{message:'서버 저장소 또는 처리에 문제가 있습니다. 저장 완료되지 않았으니 잠시 후 다시 시도해 주세요.'});
    }
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {host,port,dataDir}=serverConfig();
  (await createQuizServer({dataDir})).listen(port,host,()=>console.log(`퀴즈 서버 실행: ${host}:${port}`));
}
