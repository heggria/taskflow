import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { PersistentFileMutex } from '../../src/resources/persistence.ts';
const [mode, lock, marker] = process.argv.slice(2);
function pause(point: string) {
 fs.writeFileSync(marker, point);
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
const realLink = fs.linkSync;
const realRename = fs.renameSync;
if (mode === 'intent' || mode === 'anchor' || mode === 'complete' || mode === 'late') {
 fs.linkSync = function(source, destination) {
  if (mode === 'late' && String(destination) === lock+'.queue.initializing') {
   fs.writeFileSync(marker, mode);
   while (!fs.existsSync(marker+'.continue')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
  }
  try { realLink(source,destination); }
  finally {
   if (mode==='late' && String(destination)===lock+'.queue.initializing') fs.writeFileSync(marker+'.published','attempted');
  }
  const suffix = mode==='intent' ? 'initializing' : mode==='complete' ? 'initialized' : 'identity';
  if (mode!=='late' && String(destination) === lock+'.queue.'+suffix) pause(mode);
 };
} else if (mode === 'renamed') {
 fs.renameSync = function(source,destination) {
  realRename(source,destination);
  if (String(destination)===lock+'.queue') pause(mode);
 };
}
syncBuiltinESMExports();
const mutex = new PersistentFileMutex(lock, {pollMs: 2});
if (mode === 'recover-counter') {
 for(let i=0;i<5;i++) await mutex.runExclusive(async()=>{
  const previous=Number(fs.readFileSync(marker,'utf8'));
  await new Promise(resolve=>setTimeout(resolve,2));
  fs.writeFileSync(marker,String(previous+1));
 },{timeoutMs:5000});
} else (await mutex.acquire({timeoutMs:5000}))();
