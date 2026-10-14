import test from 'node:test';
import assert from 'node:assert/strict';
import {serverConfig} from './config.mjs';

test('production requires an explicit absolute storage path and accepts remote binding',()=>{
  assert.throws(()=>serverConfig({NODE_ENV:'production'}),/DATA_DIR/);
  assert.throws(()=>serverConfig({NODE_ENV:'production',DATA_DIR:'data'}),/DATA_DIR/);
  const config=serverConfig({NODE_ENV:'production',DATA_DIR:'/persistent/quiz',PORT:'8080'});
  assert.equal(config.host,'0.0.0.0');assert.equal(config.port,8080);assert.equal(config.dataDir,'/persistent/quiz');
  assert.equal(serverConfig({}).host,'127.0.0.1');
  assert.equal(serverConfig({HOST:'0.0.0.0'}).host,'0.0.0.0');
  assert.throws(()=>serverConfig({PORT:'wrong'}),/PORT/);
});
