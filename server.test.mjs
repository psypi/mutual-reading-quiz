import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,mkdir} from 'node:fs/promises';
import {tmpdir,networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createQuizServer} from './server.mjs';

test('two invitation seats, concurrent claims, role isolation, shared state and restart',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'reading-quiz-test-'));
  let server;
  t.after(async()=>{if(server)await new Promise(r=>server.close(r));await rm(dataDir,{recursive:true,force:true});});
  const start=async()=>{
    server=await createQuizServer({dataDir});
    await new Promise(r=>server.listen(0,'0.0.0.0',r));
    return `http://127.0.0.1:${server.address().port}`;
  };
  let base=await start();
  const post=async(path,input)=>{
    const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    return {status:response.status,data:await response.json()};
  };
  const created=await post('/api/rooms',{});assert.equal(created.status,201);
  const {id,tokens}=created.data;assert.equal(tokens.length,2);assert.notEqual(tokens[0],tokens[1]);
  const sessions=[randomBytes(32).toString('hex'),randomBytes(32).toString('hex')];
  const claim=(token,session)=>post('/api/join',{id,token,session});
  const candidates=[sessions[0],randomBytes(32).toString('hex')];
  const contenders=await Promise.all(candidates.map(session=>claim(tokens[0],session)));
  assert.deepEqual(contenders.map(r=>r.status).sort(),[200,409]);
  sessions[0]=candidates[contenders.findIndex(r=>r.status===200)];
  assert.equal(contenders.find(r=>r.status===409).data.code,'SEAT_TAKEN');
  assert.equal((await claim('invalid',sessions[1])).status,403);
  assert.equal((await claim(tokens[1],sessions[0])).status,409);
  assert.equal((await claim(tokens[1],sessions[1])).data.index,1);
  const full=await claim(tokens[0],randomBytes(32).toString('hex'));
  assert.equal(full.status,409);assert.equal(full.data.code,'ROOM_FULL');
  assert.equal((await claim(tokens[0],sessions[0])).status,200);
  const act=(i,action,extra={})=>post('/api/room',{id,session:sessions[i],action,...extra});
  assert.equal((await post('/api/room',{id,token:tokens[0],action:'get'})).status,403);
  assert.equal((await post('/api/room',{id,action:'get'})).status,403);
  assert.equal((await act(0,'get',{index:1,token:tokens[1]})).data.index,0);
  const task={book:'가상 책',question:'왜 나눴나요?',core:'공동체 생존',rubric:'동기 100점'};
  assert.equal((await act(0,'setTask',{task,index:1})).status,200);
  const other=await act(1,'get');assert.equal(other.data.me.task.question,task.question);assert.equal(other.data.myTask,null);
  const submitted=await act(1,'submit',{answer:'공동체를 위해 나눴습니다.'});assert.equal(submitted.status,200);
  const shared=await act(0,'get');assert.equal(shared.data.other.answer,'공동체를 위해 나눴습니다.');assert.equal(shared.data.me.answer,undefined);
  const lan=Object.values(networkInterfaces()).flat().find(a=>a.family==='IPv4'&&!a.internal);
  if(lan){
    const response=await fetch(`http://${lan.address}:${server.address().port}/api/room`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,session:sessions[0],action:'get'})});
    assert.equal(response.status,200);assert.equal((await response.json()).other.answer,shared.data.other.answer);
  }
  assert.equal((await act(0,'peer',{score:80,reason:'동기 설명'})).status,200);
  assert.equal((await act(1,'get')).data.me.peer.score,80);
  const payload=JSON.stringify(shared.data);assert.ok(!payload.includes(tokens[0]));assert.ok(!payload.includes(sessions[1]));
  await new Promise(r=>server.close(r));server=null;base=await start();
  assert.equal((await act(0,'get')).data.other.answer,'공동체를 위해 나눴습니다.');
  assert.equal((await claim(tokens[1],randomBytes(32).toString('hex'))).data.code,'ROOM_FULL');
  assert.equal((await claim(tokens[1],sessions[1])).status,200);
});

test('private files, cross-site requests and upstream secret errors stay out of browser responses',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'quiz-security-'));
  const marker='fake-test-secret-not-a-real-api-key';
  let useFakeKey=false;
  const server=await createQuizServer({dataDir,getApiKey:()=>useFakeKey?marker:undefined,grader:async(task,key)=>{assert.equal(key,marker);throw new Error(`upstream error ${key}`);}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));await rm(dataDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=async(path,input,headers={})=>{
    const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(input)});
    const text=await response.text();assert.ok(!text.includes(marker));return {status:response.status,data:JSON.parse(text)};
  };
  for(const path of ['/.env','/server.mjs','/grading.mjs','/data/rooms.json','/.git/config','/%2e%2e/.env'])assert.equal((await fetch(base+path)).status,404);
  for(const path of ['/','/app.js','/style.css','/healthz']){
    const response=await fetch(base+path);assert.equal(response.status,200);
    assert.equal(response.headers.get('referrer-policy'),'no-referrer');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    assert.ok(!(await response.text()).includes(marker));
  }
  assert.equal((await post('/api/rooms',{}, {Origin:'https://other.example'})).status,403);
  assert.equal((await post('/api/join',null)).status,400);
  const {id,tokens}= (await post('/api/rooms',{}, {Origin:base})).data;
  const sessions=[randomBytes(32).toString('hex'),randomBytes(32).toString('hex')];
  // A failed server save must not consume a one-time invitation.
  await mkdir(join(dataDir,'rooms.json.tmp'));
  assert.equal((await post('/api/join',{id,token:tokens[0],session:sessions[0]})).status,503);
  await rm(join(dataDir,'rooms.json.tmp'),{recursive:true});
  for(let i=0;i<2;i++)assert.equal((await post('/api/join',{id,token:tokens[i],session:sessions[i]})).status,200);
  const act=(i,action,extra={})=>post('/api/room',{id,session:sessions[i],action,...extra});
  assert.equal((await post('/api/room',{id,token:tokens[0],action:'setTask',task:{}})).status,403);
  const task={question:'왜 나눴나요?',core:'공동체 생존',rubric:'동기 100점',untrustedExtra:marker};
  assert.equal((await act(0,'setTask',{task})).status,200);
  assert.equal((await act(1,'submit',{answer:'공동체를 위해'})).status,200);
  assert.equal((await act(1,'grade')).status,503);
  assert.equal((await act(1,'get')).data.me.status,'ready');
  useFakeKey=true;assert.equal((await act(1,'grade')).status,502);
  assert.equal((await act(1,'get')).data.me.status,'error');
  assert.ok(!(await readFile(join(dataDir,'rooms.json'),'utf8')).includes(marker));
});
