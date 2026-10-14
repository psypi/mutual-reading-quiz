import assert from 'node:assert/strict';
const base=process.env.QUIZ_BASE_URL||'http://127.0.0.1:3000';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function connection(url){
  const ws=new WebSocket(url);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let seq=0;const pending=new Map(),errors=[];
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}else if(m.method==='Runtime.exceptionThrown')errors.push(m);});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,m=>m.error?reject(m.error):resolve(m.result));ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  return {call,evaluate,errors,close:()=>ws.close()};
}
async function browser(port){
  const meta=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const root=await connection(meta.webSocketDebuggerUrl);
  const {browserContextId}=await root.call('Target.createBrowserContext');
  const {targetId}=await root.call('Target.createTarget',{url:'about:blank',browserContextId});
  const tabs=await(await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page=await connection(tabs.find(t=>t.id===targetId).webSocketDebuggerUrl);
  await page.call('Runtime.enable');await page.call('Page.enable');
  const navigate=async url=>{await page.call('Page.navigate',{url});await sleep(600);};
  return {...page,navigate,dispose:async()=>{page.close();await root.call('Target.disposeBrowserContext',{browserContextId});root.close();}};
}
const firstPort=Number(process.env.CHROME_A_PORT||9223),secondPort=Number(process.env.CHROME_B_PORT||9224);
const a=await browser(firstPort),b=await browser(secondPort),c=await browser(firstPort);
try{
  await a.navigate(base+'/');await a.evaluate('document.getElementById("create").click()');await sleep(500);
  const links=await a.evaluate('[...document.querySelectorAll("#links a")].map(a=>a.href)');assert.equal(links.length,2);
  await a.navigate(links[0]);await b.navigate(links[1]);await sleep(2500);
  assert.equal(await a.evaluate('document.getElementById("participants").textContent'),'참가자 1 · 참가 2/2명');
  assert.equal(await b.evaluate('document.getElementById("participants").textContent'),'참가자 2 · 참가 2/2명');
  // Submit participant 1's task and wait for participant 2's polling, without manual refresh.
  await a.evaluate('document.getElementById("example").click();document.getElementById("task").requestSubmit()');await sleep(2500);
  assert.ok((await b.evaluate('document.getElementById("question").textContent')).includes('씨앗을 나눈 이유'));
  assert.equal(await b.evaluate('document.querySelector("#answer button").disabled'),false);
  assert.equal(await b.evaluate('document.querySelector("#task button").disabled'),false);
  await b.evaluate('document.querySelector("#answer textarea").value="공동체의 생존을 위해 씨앗을 나누고 식량 부족을 해결했습니다.";document.getElementById("answer").requestSubmit()');await sleep(2500);
  assert.ok((await a.evaluate('document.getElementById("peerAnswer").textContent')).includes('공동체의 생존'));
  await a.evaluate('document.querySelector("#peer input").value="85";document.querySelector("#peer textarea").value="공동체 동기를 설명했습니다.";document.getElementById("peer").requestSubmit()');await sleep(2500);
  const peer=await b.evaluate('fetch("/api/room",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...identity,action:"get"})}).then(r=>r.json()).then(d=>d.me.peer)');
  assert.equal(peer.score,85);
  await c.navigate(links[0]);
  assert.ok((await c.evaluate('document.getElementById("notice").textContent')).includes('두 참가자 자리가 모두 찼습니다'));
  assert.equal(await c.evaluate('document.getElementById("game").hidden'),true);
  // The second browser cannot enter participant 1's occupied invitation.
  await b.navigate(links[0]);assert.ok((await b.evaluate('document.getElementById("notice").textContent')).includes('참가할 수 없습니다'));
  await b.navigate(links[1]);assert.equal(await b.evaluate('document.getElementById("game").hidden'),false);
  await a.call('Page.reload');await sleep(700);
  assert.equal(await a.evaluate('document.getElementById("game").hidden'),false);
  assert.ok((await a.evaluate('document.getElementById("peerAnswer").textContent')).includes('공동체의 생존'));
  assert.equal(a.errors.length+b.errors.length+c.errors.length,0);
  console.log('PASS: two independent Chrome processes share task, answer and peer evaluation; third browser and wrong-role invite rejected; original browser reload/re-entry succeeds; no JS errors.');
}finally{await Promise.all([a.dispose(),b.dispose(),c.dispose()]);}
