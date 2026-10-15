import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openRoomStore} from './room-store.mjs';

test('failed disk write does not claim a seat or overwrite the last saved state',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'quiz-store-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const store=await openRoomStore(dataDir);
  await store.mutate(rooms=>rooms.set('room',{id:'room',players:[{},{}]}));
  const file=join(dataDir,'rooms.json'),before=await readFile(file,'utf8');
  // A directory at the staging path simulates a filesystem save failure, without chmod assumptions.
  await mkdir(file+'.tmp');
  await assert.rejects(store.mutate(rooms=>{rooms.get('room').players[0].session='new-session';}));
  assert.equal(store.get('room').players[0].session,undefined);
  assert.equal(await readFile(file,'utf8'),before);
  await rm(file+'.tmp',{recursive:true});
  await store.mutate(rooms=>{rooms.get('room').players[0].session='retry-session';});
  assert.equal((await openRoomStore(dataDir)).get('room').players[0].session,'retry-session');
  assert.deepEqual(await readdir(dataDir),['rooms.json']);
});

test('damaged save fails startup rather than silently deleting all rooms',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'quiz-corrupt-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const file=join(dataDir,'rooms.json');
  await writeFile(file,'{"damaged":');await assert.rejects(openRoomStore(dataDir));
  assert.equal(await readFile(file,'utf8'),'{"damaged":');
  await writeFile(file,JSON.stringify([{id:'room',players:[{}]}]));await assert.rejects(openRoomStore(dataDir),/형식/);
});

test('older saves preserve invitations and human work without obsolete fields',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'quiz-interrupted-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const store=await openRoomStore(dataDir);
  await store.mutate(rooms=>rooms.set('room',{id:'room',players:[{status:'processing',answer:'저장된 답안'},{status:'draft'}]}));
  const restored=(await openRoomStore(dataDir)).get('room');
  assert.equal(restored.players[0].status,undefined);assert.equal(restored.players[0].answer,'저장된 답안');
  assert.equal(restored.startedAt,1);assert.equal(restored.players[1].name,'참가자 2');
  assert.equal(restored.name,'이전 대결 room');assert.equal(restored.closedAt,null);
});
