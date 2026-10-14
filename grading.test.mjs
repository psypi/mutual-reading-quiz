import test from 'node:test';
import assert from 'node:assert/strict';
import {grade,validateTask,validateResult} from './grading.mjs';
const task={question:'왜 나눴나요?',core:'공동체 생존',rubric:'동기 100점',answer:'공동체를 위해'};
test('긴 입력은 API 전송 전 차단',()=>assert.throws(()=>validateTask({...task,answer:'가'.repeat(3501)})));
test('429는 결과 없이 수동 재시도 대기',async()=>{let calls=0;const r=await grade(task,'test',async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'60'}});});assert.equal(r.status,'waiting');assert.equal(calls,1);});
test('서버가 점수 합산하고 범위 검증',()=>{const r={items:[{criterion:'동기',score:80,max:100,reason:'핵심 포함'}],strengths:['동기'],missed:[],feedback:'근거를 보강하세요',total:999};assert.equal(validateResult(r).total,80);assert.throws(()=>validateResult({...r,items:[{...r.items[0],score:101}]}));});
test('전송 자료는 네 필드만, 모델 전환 없음',async()=>{await grade({...task,book:'전송하지 않음'},'test',async(url,init)=>{const data=JSON.parse(init.body);assert.equal(data.model,'openai/gpt-oss-120b');assert.deepEqual(Object.keys(JSON.parse(data.messages[1].content)),['question','core','rubric','answer']);return new Response('',{status:429});});});
