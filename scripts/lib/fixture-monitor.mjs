// scripts/lib/fixture-monitor.mjs —— 实现在 work/monitor/lib/fixture-monitor.mjs（自更新的自检也要用，
// 而 monitor-server 的静态依赖不能指到 scripts/ 下），这里保留原路径给冒烟脚本用。
export { spawnFixtureMonitor } from "../../work/monitor/lib/fixture-monitor.mjs";
