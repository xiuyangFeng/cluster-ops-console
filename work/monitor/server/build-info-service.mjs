// T05 构建：/api/build-info 数据源。monitor 启动时冻结自身构建元信息（源代码运行缺失属正常），
// 请求时再读磁盘包的 build-info 与数据面组件指纹，拼出"运行中 vs 磁盘上"的对照。

import {
  assembleBuildInfoPayload,
  createBundleComponentsResolver,
  freezeBuildInfo,
  readBundleBuildInfo,
} from "../lib/build-info.mjs";

// getShouldBeRunning 是迟绑定（通道生命周期在本服务之后才创建），请求时才解引用；
// 取不到（尚未绑定 / 抛错）按未知处理。
export async function createBuildInfoService({ rootDir, getUsableSnapshot, getShouldBeRunning }) {
  const monitorBuildInfo = await freezeBuildInfo(rootDir);
  const monitorStartedAt = Date.now();
  // 热更新：磁盘新包的数据面组件指纹（build-info.json.components；源代码模式现场算、5s 缓存）。
  const resolveBundleComponents = createBundleComponentsResolver({ appRoot: rootDir });

  function readChannelRunning() {
    try {
      return getShouldBeRunning() === true;
    } catch {
      return undefined;
    }
  }

  return function getBuildInfo({ clientBuild } = {}) {
    // bundleOnDisk 与 monitorRunning 同一 appRoot：覆盖升级后磁盘是新构建、内存里仍是
    // 旧进程——这正是 restart-monitor 原因要表达的事实。读失败由 freeze/read 降级 unknown。
    return readBundleBuildInfo(rootDir).then(async (bundleBuild) => {
      const supervisorSnapshot = getUsableSnapshot();
      const bundleComponents = await resolveBundleComponents(bundleBuild).catch(() => null);
      return assembleBuildInfoPayload({
        monitorBuild: monitorBuildInfo,
        startedAt: monitorStartedAt,
        bundleBuild,
        supervisorSnapshot,
        clientBuild,
        bundleComponents,
        channelRunning: readChannelRunning(),
      });
    });
  };
}
