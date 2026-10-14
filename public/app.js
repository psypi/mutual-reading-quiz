const $=id=>document.getElementById(id);
let identity;
let pending=false;
let polling;
let syncFailed=false;
const participantStatus=document.createElement('p');participantStatus.id='participants';$('game').prepend(participantStatus);
async function request(action,extra={},silent=false){
  if(pending)return;pending=true;if(!silent)$('notice').textContent='처리 중…';
  try{
    const r=await fetch('/api/room',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...identity,action,...extra}),signal:AbortSignal.timeout(action==='grade'?70000:15000)});
    const data=await r.json();
    if(!r.ok){if(r.status===403){clearInterval(polling);$('game').hidden=true;}throw new Error(data.message);}
    render(data);$('game').hidden=false;if(!silent||syncFailed)$('notice').textContent='';syncFailed=false;
  }catch(e){if(silent)syncFailed=true;$('notice').textContent=e.name==='TimeoutError'?'서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.':e instanceof TypeError?'서버와 연결할 수 없습니다. 연결 상태를 확인해 주세요.':e.message;}finally{pending=false;}
}
function render(d){
  participantStatus.textContent=`참가자 ${d.index+1} · 참가 ${d.participants}/2명`;
  $('task').querySelectorAll('input,textarea,button').forEach(e=>e.disabled=!!d.myTask);
  if(d.myTask)for(const [key,value]of Object.entries(d.myTask))if($('task').elements[key])$('task').elements[key].value=value;
  $('question').textContent=d.me.task?.question||'상대의 출제를 기다립니다.';
  $('answer').querySelectorAll('textarea,button').forEach(e=>e.disabled=!d.me.task||!!d.me.answer);
  if(d.me.answer)$('answer').elements.answer.value=d.me.answer;
  $('state').textContent=({draft:'제출 전',ready:'답안 저장 완료 · AI 채점 버튼을 눌러 주세요.',processing:'채점 중',waiting:'무료 한도 대기 · 나중에 재시도하세요.',complete:'AI 채점 완료',error:'채점 오류 · 다시 시도하세요.'})[d.me.status];
  $('grade').disabled=!d.me.answer||['processing','complete'].includes(d.me.status);
  $('peerAnswer').textContent=d.other.answer||'상대가 아직 답안을 제출하지 않았습니다.';
  $('peer').querySelectorAll('input,textarea,button').forEach(e=>e.disabled=!d.other.answer||!!d.other.peer);
  $('ai').replaceChildren();
  if(d.me.result){const pre=document.createElement('pre');pre.textContent=`AI 총점: ${d.me.result.total}/100\n`+d.me.result.items.map(i=>`${i.criterion}: ${i.score}/${i.max} · ${i.reason}`).join('\n')+`\n잘 이해한 점: ${d.me.result.strengths.join(' / ')}\n놓친 핵심: ${d.me.result.missed.join(' / ')}\n피드백: ${d.me.result.feedback}`;$('ai').append(pre);}else if(d.me.status==='complete')$('ai').textContent='상대 평가 확정 후 AI 결과가 공개됩니다.';
  if(d.finished){const mine=d.scores[d.index],theirs=d.scores[1-d.index];$('result').textContent=`내 점수 ${mine} · 상대 점수 ${theirs} — ${mine===theirs?'무승부':mine>theirs?'승리':'패배'} (내 상대 평가: ${d.me.peer.score}점 · ${d.me.peer.reason})`;}
}
$('create').onclick=async()=>{
  const button=$('create');
  if(button.disabled)return;
  button.disabled=true;button.textContent='대결 만드는 중…';$('notice').textContent='대결을 만들고 있습니다…';
  try{
    const r=await fetch('/api/rooms',{method:'POST',signal:AbortSignal.timeout(15000)});
    let data;
    try{data=await r.json();}catch{throw new Error('서버 응답을 읽을 수 없습니다. npm start로 실행한 서버에서 접속해 주세요.');}
    if(!r.ok)throw new Error(data.message||`대결 생성 실패 (HTTP ${r.status})`);
    if(typeof data.id!=='string'||!data.id||!Array.isArray(data.tokens)||data.tokens.length!==2||data.tokens.some(t=>typeof t!=='string'||!t)||data.tokens[0]===data.tokens[1])throw new Error('서버에서 올바른 참가 링크를 받지 못했습니다. 다시 시도해 주세요.');
    $('links').replaceChildren();
    data.tokens.forEach((token,i)=>{
      const p=document.createElement('p'),a=document.createElement('a');
      a.href=`/#room=${encodeURIComponent(data.id)}&token=${encodeURIComponent(token)}`;
      a.textContent=`참가자 ${i+1} 링크`;p.append(a);$('links').append(p);
    });
    const p=document.createElement('p');p.textContent='각자 자신의 링크만 사용하세요. 초대 링크를 처음 연 브라우저가 그 자리를 사용합니다. 다른 브라우저로 옮기거나 링크를 공개하지 마세요.';$('links').append(p);
    $('notice').textContent='대결이 만들어졌습니다. 참가자 링크를 열어 주세요.';
  }catch(e){
    $('notice').textContent=e.name==='TimeoutError'?'서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.':e instanceof TypeError?'서버에 연결할 수 없습니다. npm start 실행 상태를 확인하고 다시 시도해 주세요.':e.message;
  }finally{button.disabled=false;button.textContent='대결 만들기';}
};
$('task').onsubmit=e=>{e.preventDefault();request('setTask',{task:Object.fromEntries(new FormData(e.target))});};
$('answer').onsubmit=async e=>{e.preventDefault();await request('submit',{answer:new FormData(e.target).get('answer')});};
$('peer').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target);request('peer',{score:Number(f.get('score')),reason:f.get('reason')});};
$('grade').onclick=()=>request('grade');$('refresh').onclick=()=>request('get');
$('example').onclick=()=>{if($('task').elements.book.disabled)return;const v={book:'가상 단편: 씨앗을 나눈 마을',question:'주인공이 씨앗을 나눈 이유와 마을에 생긴 변화를 설명하세요.',core:'혼자만의 풍작보다 공동체의 생존을 중요하게 여겼다. 씨앗 공유로 협력이 생기고 식량 부족을 함께 해결했다.',rubric:'공동체를 위한 동기 40점, 씨앗 공유와 협력의 인과 관계 40점, 식량 부족 해결 20점.'};for(const[k,x]of Object.entries(v))$('task').elements[k].value=x;};
async function openParticipant(){
  const params=new URLSearchParams(location.hash.slice(1));
  const id=params.get('room'),token=params.get('token');
  if(!id&&!token)return;
  $('start').hidden=true;$('game').hidden=true;
  if(!id||!token){$('notice').textContent='참가 링크가 올바르지 않습니다.';return;}
  $('notice').textContent='참가 자리를 확인하고 있습니다…';
  try{
    // Store before claiming: retries and reloads must present the same browser credential.
    const key=`reading-quiz:${id}:${token}`;
    let session=localStorage.getItem(key);
    if(!session){session=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');localStorage.setItem(key,session);}
    const r=await fetch('/api/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,token,session}),signal:AbortSignal.timeout(15000)});
    const data=await r.json();if(!r.ok)throw new Error(data.message);
    identity={id,session};await request('get');
    polling=setInterval(()=>{if(!document.hidden)request('get',{},true);},2000);
  }catch(e){$('notice').textContent=e.name==='SecurityError'?'브라우저 저장소를 사용할 수 없어 참가할 수 없습니다. 저장소 설정을 확인해 주세요.':e.message;}
}
// Each participant has a different identity; reload to discard the previous view and requests.
window.addEventListener('hashchange',()=>location.reload());
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&identity)request('get',{},true);});
openParticipant();
