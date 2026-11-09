import assert from 'node:assert/strict';
import test from 'node:test';
import { createChannelToolkit } from './probes.mjs';
import { createStateStore } from './state-store.mjs';
import { bus, EVENTS } from './event-bus.mjs';
import { createIncidentStore } from './incidents/store.mjs';
import { recoverConnectionIncidents, incidentProbeServerId } from './incident-recovery.mjs';

const servers = [0,1,2].map(i => ({ id: `fixture-${i}`, host: `fixture-${i}.invalid`, localPort: 28888+i, remotePort: 27891+i }));
test('incident ingestion rejects deleted, disabled and stale active-server results', () => {
 const current = [servers[0], { ...servers[1], disabled: true }];
 const check = (id, captured) => incidentProbeServerId({ id, result: { probeContext: { serverId: captured } }, activeServerId: 'fixture-0', servers: current });
 assert.equal(check('doctor', 'fixture-2'), null, 'deleted target must not be attributed to new active target');
 assert.equal(check('endpoint', 'fixture-1'), null, 'old view result must not reopen or resolve current events');
 assert.equal(check('doctor'), null, 'scheduler timeouts without captured context cannot be attributed to the current view');
 assert.equal(check('collect:slow:fixture-1'), null, 'disabled samples are not fresh health evidence');
 assert.equal(check('collect:slow:fixture-2'), null, 'late per-server samples are discarded');
 assert.equal(check('doctor', 'fixture-0'), 'fixture-0');
 assert.equal(check('collect:slow:fixture-0'), 'fixture-0');
 assert.equal(check('local-resource'), null);
});
const ps = [
 '501 11 1 0 ?? 0:00.01 node work/local_http_connect_proxy.mjs',
 '501 12 1 0 ?? 0:00.01 node work/monitor/channel-supervisor.mjs',
 ...servers.map((s,i)=>`501 ${21+i} 1 0 ?? 0:00.01 ssh -N -R 127.0.0.1:${s.remotePort}:127.0.0.1:28888 ${s.host}`),
].join('\n');
test('switching view retains all process matches, port evidence, and emits no outage; real process loss still alarms', async () => {
 let config = { servers, agents: [], activeServerId: servers[0].id };
 let processText = ps;
 const toolkit = createChannelToolkit({ platform:'darwin', rootDir:'/tmp', getConfig:async()=>config, execFileImpl:async()=>({code:0,stdout:processText}), getConnectionTargets:()=>({source:'supervisor-snapshot',freshness:'fresh',effectiveProxyPort:{value:28888}}) });
 const store = createStateStore({config});
 let time=Date.now();
 const emit = (id,data,level='ok') => bus.emit(EVENTS.PROBE_UPDATED,{id,layer:'channel',result:{level,data,checkedAt:++time,nextCheckAt:time+60000,probeContext:{serverId:config.activeServerId}}});
 try {
  emit('processes',{processes:await toolkit.getProcesses()});
  // Old slow failures must be superseded by newer fast success when leaving that view.
  emit('collect:slow:fixture-0',{ports:{27891:false}});
  emit('log-signals',{remotePortOpen:true});
  for(const s of servers.slice(1)) emit(`collect:slow:${s.id}`,{ports:{[s.remotePort]:true}});
  const start=store.getRecentTransitions(50).length;
  for(const s of [...servers.slice(1),servers[0]]) {
   config={...config,activeServerId:s.id}; store.setConfig(config);
   const processes=await toolkit.getProcesses();
   assert.deepEqual(Object.values(processes.tunnelsByServer).map(x=>x.length),[1,1,1]);
   emit('processes',{processes});
   assert.equal(store.getLayers().channel.level,'ok');
   assert.ok(Object.values(store.getLayers().tunnels).every(t=>t.level==='ok'));
  }
  assert.equal(store.getRecentTransitions(50).slice(start).some(t=>t.to==='error'),false);
  processText=ps.split('\n').filter(l=>!l.endsWith('fixture-2.invalid')).join('\n');
  emit('processes',{processes:await toolkit.getProcesses()});
  assert.equal(store.getLayers().tunnels['fixture-2'].level,'error');
 } finally { store.dispose(); }
});

test('connection incidents resolve after two fresh samples even after switching away; unknown does not resolve',()=>{
 const incidents=createIncidentStore({ openGate: {} });
 incidents.observe({serverId:'fixture-0',component:'tunnel',reasonCode:'TUNNEL_DOWN',severity:'error'});
 const params={id:'collect:slow:fixture-0',activeServerId:'fixture-1',shouldBeRunning:true,incidentStore:incidents,layers:{tunnels:{'fixture-0':{tunnelUp:true,remotePortOpen:true}},channel:{detail:{localProxyUp:true,supervisorUp:true}}},result:{level:'ok',data:{ports:{27891:true}}}};
 recoverConnectionIncidents(params);
 recoverConnectionIncidents({...params,result:{level:'error'}});
 recoverConnectionIncidents(params);
 assert.equal(incidents.query({state:'open'}).incidents.length,1);
 recoverConnectionIncidents(params);
 assert.equal(incidents.query({state:'open'}).incidents.length,0);
});

// 生产 10-06～10-11 的 19 起主通道事件全部在通道恢复后又挂了 ≥612 秒才关：断线时 reclaude 自报的
// 「网关不健康」信号存活 600 秒，fast 采集那段时间 level 是 error，恢复采样一直被当成未知。
test('connection recovery ignores the log-signal verdict of the fast sample; only its port conclusion counts',()=>{
 let clock=1_000_000;
 const incidents=createIncidentStore({ now:()=>clock });
 const layers=(open)=>({tunnels:{'fixture-0':{tunnelUp:true,remotePortOpen:open}},channel:{detail:{localProxyUp:true,supervisorUp:true}}});
 const fast=(open,level='error')=>recoverConnectionIncidents({id:'log-signals',activeServerId:'fixture-0',shouldBeRunning:true,incidentStore:incidents,layers:layers(open),result:{level,probeContext:{serverId:'fixture-0'},data:{activeSignals:[{signalId:'gateway-unhealthy',severity:'error'}],remotePortOpen:open}}});
 // 120 秒内自愈的短断：带着活跃信号的一次成功采样就撤掉候选，到点不再转正。
 incidents.observe({serverId:'fixture-0',component:'channel',reasonCode:'REMOTE_PORT_CLOSED',severity:'error'});
 clock+=30_000; fast(true);
 clock+=120_000;
 assert.deepEqual(incidents.promotePending(),[]);
 // 已打开的事件：两次带回「端口开放」的采样即关闭，不等信号过期。
 const open=createIncidentStore({ openGate: {} });
 const fastOpen=(portOpen)=>recoverConnectionIncidents({id:'log-signals',activeServerId:'fixture-0',shouldBeRunning:true,incidentStore:open,layers:layers(portOpen),result:{level:'error',probeContext:{serverId:'fixture-0'},data:{activeSignals:[{signalId:'gateway-unhealthy',severity:'error'}],remotePortOpen:portOpen}}});
 open.observe({serverId:'fixture-0',component:'channel',reasonCode:'REMOTE_PORT_CLOSED',severity:'error'});
 fastOpen(true);
 fastOpen(false);
 fastOpen(true);
 assert.equal(open.query({state:'open'}).incidents.length,1,'端口判为未开放的采样打断连击');
 fastOpen(true);
 assert.equal(open.query({state:'open'}).incidents.length,0);
});
