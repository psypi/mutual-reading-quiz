import test from 'node:test';
import assert from 'node:assert/strict';
import {buildInviteUrl} from './public/invite-url.mjs';

test('P2 invitation URL keeps the current local or HTTPS origin and encodes room plus seat token',()=>{
  for(const origin of ['http://127.0.0.1:3000','https://example.trycloudflare.com']){
    const url=new URL(buildInviteUrl(origin,'room-123','private-p2-token'));
    assert.equal(url.origin,origin);
    const params=new URLSearchParams(url.hash.slice(1));
    assert.equal(params.get('room'),'room-123');
    assert.equal(params.get('token'),'private-p2-token');
  }
});
