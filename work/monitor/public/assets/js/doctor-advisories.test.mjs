import assert from 'node:assert/strict';
import test from 'node:test';
import { doctorAttentionCount, doctorAdviceText } from './doctor-advisories.js';
import { formatDoctorOutput } from './render/diagnostics.js';
test('known maintenance advice is quiet; unknown warnings and failures stay visible',()=>{
 const warnItems=[{name:'updates',text:'update configuration is locally consistent'},{name:'threads',text:'rollout files are missing from the state DB'}];
 assert.equal(doctorAttentionCount({warn:2,warnItems}),0);
 assert.equal(doctorAttentionCount({warn:3,warnItems}),1);
 assert.match(doctorAdviceText(warnItems),/备份后检查/);
 assert.match(formatDoctorOutput('[!!] updates update configuration is inconsistent'),/doc-line warn/);
 assert.match(formatDoctorOutput('[xx] threads rollout files are missing from the state DB'),/doc-line fail/);
 assert.match(formatDoctorOutput('[!!] updates update configuration is locally consistent'),/doc-line info/);
});
