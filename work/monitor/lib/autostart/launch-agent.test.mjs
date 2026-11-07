import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildLaunchAgentPlist,
  buildLaunchPath,
  isLaunchAgentRoot,
  isPlistText,
  LAUNCH_AGENT_FILE,
  LAUNCH_AGENT_LABEL,
  LAUNCH_AGENT_THROTTLE_SECONDS,
  launchAgentPath,
  launchAgentProgram,
  parseLaunchAgentPlist,
} from "./launch-agent.mjs";
import { AUTOSTART_FLAG, AUTOSTART_MARKER } from "./launch-flag.mjs";

const ROOT = "/Users/tester/cluster-workbench";
const PATH_ENV = "/Users/tester/.nvm/versions/node/v24.11.0/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

test("launchAgentPath：用户级 LaunchAgents 目录下，文件名即标签", () => {
  assert.equal(LAUNCH_AGENT_FILE, "com.clusterworkbench.launcher.plist");
  assert.equal(launchAgentPath("/Users/tester"), path.join("/Users/tester", "Library", "LaunchAgents", LAUNCH_AGENT_FILE));
});

test("buildLaunchPath：顺序原样保留；空的、相对的、带换行等怪字符的条目去掉；去重；缺的系统目录补在最后", () => {
  assert.equal(buildLaunchPath({ pathEnv: PATH_ENV }), PATH_ENV, "正常的 PATH 一个字都不变");
  assert.equal(
    buildLaunchPath({ pathEnv: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" }),
    "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
    "系统目录排在前面的也不挪：换了顺序 ssh / git 可能就换成另一份",
  );
  assert.equal(
    buildLaunchPath({ pathEnv: "/a/bin::./rel:bin:/b\n/evil:/c\tx:/a/bin/:/d/\u0000:/ok" }),
    "/a/bin:/ok:/usr/bin:/bin:/usr/sbin:/sbin",
  );
  assert.equal(buildLaunchPath({ pathEnv: "" }), "/usr/bin:/bin:/usr/sbin:/sbin", "空 PATH 也给出能用的系统目录");
  assert.equal(buildLaunchPath({}), "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(buildLaunchPath({ pathEnv: "/x/&<y>:/usr/bin" }), "/x/&<y>:/usr/bin:/bin:/usr/sbin:/sbin", "XML 特殊字符留给生成 plist 时转义，这里不丢");
});

test("buildLaunchPath：超长时从后往前丢，系统目录始终都在", () => {
  const many = Array.from({ length: 400 }, (_, i) => `/opt/tool-${String(i).padStart(3, "0")}/bin`).join(":");
  const out = buildLaunchPath({ pathEnv: many, maxChars: 200 });
  assert.ok(out.length <= 200, `长度 ${out.length}`);
  assert.ok(out.startsWith("/opt/tool-000/bin:/opt/tool-001/bin"), "保留的是靠前的条目");
  assert.ok(out.endsWith(":/usr/bin:/bin:/usr/sbin:/sbin"));
  assert.equal(buildLaunchPath({ pathEnv: many, maxChars: 10 }), "/usr/bin:/bin:/usr/sbin:/sbin", "上限小到放不下任何条目时只剩系统目录");
});

test("isPlistText / isLaunchAgentRoot：控制字符、相对路径、空串、残缺的代理对都不收", () => {
  assert.equal(isLaunchAgentRoot(ROOT), true);
  assert.equal(isLaunchAgentRoot("/Users/秀/Documents/集群 codex 连接"), true, "中文与空格没问题");
  assert.equal(isLaunchAgentRoot("relative/dir"), false);
  assert.equal(isLaunchAgentRoot(""), false);
  assert.equal(isLaunchAgentRoot(undefined), false);
  for (const bad of ["/a\nb", "/a\rb", "/a\tb", "/a\u0000b", "/a\u007fb", "/a\ud800b", "/a\uffffb"]) {
    assert.equal(isLaunchAgentRoot(bad), false, JSON.stringify(bad));
    assert.equal(isPlistText(bad), false, JSON.stringify(bad));
  }
});

test("buildLaunchAgentPlist：登录时用 /bin/bash 执行安装目录的 start.sh 并带自启标志；异常退出才重拉；输出丢弃；带标记", () => {
  const plist = buildLaunchAgentPlist({ repoRoot: ROOT, pathEnv: PATH_ENV });
  assert.ok(plist.includes(AUTOSTART_MARKER), "带标记：之后才认得出是自己放的");
  assert.match(plist, /<key>Label<\/key>\n\t<string>com\.clusterworkbench\.launcher<\/string>/);
  assert.match(plist, /<key>ProgramArguments<\/key>\n\t<array>\n\t\t<string>\/bin\/bash<\/string>\n\t\t<string>\/Users\/tester\/cluster-workbench\/start\.sh<\/string>\n\t\t<string>--autostart<\/string>\n\t<\/array>/);
  assert.match(plist, /<key>WorkingDirectory<\/key>\n\t<string>\/Users\/tester\/cluster-workbench<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n\t<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\n\t<dict>\n\t\t<key>SuccessfulExit<\/key>\n\t\t<false\/>\n\t<\/dict>/, "只在异常退出时重拉");
  assert.match(plist, new RegExp(`<key>ThrottleInterval</key>\\n\\t<integer>${LAUNCH_AGENT_THROTTLE_SECONDS}</integer>`));
  assert.match(plist, /<key>StandardOutPath<\/key>\n\t<string>\/dev\/null<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>\n\t<string>\/dev\/null<\/string>/);
  assert.ok(plist.includes(`<key>PATH</key>\n\t\t<string>${PATH_ENV}</string>`), "启动器那一刻的 PATH 原样写入");
  // 不该出现的键：写死的 ssh-agent 套接字重启后失效；不做系统级服务；不让 launchd 放过进程组。
  for (const key of ["SSH_AUTH_SOCK", "UserName", "AbandonProcessGroup", "StartInterval", "HOME"]) {
    assert.ok(!plist.includes(key), `${key} 不该出现在 plist 里`);
  }
  assert.ok(plist.endsWith("</plist>\n"));
  // XML 注释里不能出现连续两个连字符（否则整份 plist 解析失败）。
  const comment = plist.match(/<!--([\s\S]*?)-->/g).find((c) => c.includes(AUTOSTART_MARKER));
  assert.ok(!comment.slice(4, -3).includes("--"));
});

test("buildLaunchAgentPlist：路径与 PATH 里的 XML 特殊字符转义；不合格的输入直接抛错，不生成半截文件", () => {
  const root = "/Users/t/a&b <c> \"d\" 'e'/集群";
  const plist = buildLaunchAgentPlist({ repoRoot: root, pathEnv: "/x&y/bin:/usr/bin" });
  assert.ok(plist.includes("<string>/Users/t/a&amp;b &lt;c&gt; \"d\" 'e'/集群/start.sh</string>"));
  assert.ok(plist.includes("<string>/x&amp;y/bin:/usr/bin</string>"));
  assert.deepEqual(parseLaunchAgentPlist(plist).program, ["/bin/bash", `${root}/start.sh`, "--autostart"], "读回来与写进去的逐字一致");
  assert.throws(() => buildLaunchAgentPlist({ repoRoot: "/a\nb", pathEnv: PATH_ENV }), /安装目录/);
  assert.throws(() => buildLaunchAgentPlist({ repoRoot: "rel", pathEnv: PATH_ENV }), /安装目录/);
  assert.throws(() => buildLaunchAgentPlist({ repoRoot: ROOT, pathEnv: "/a\n/b" }), /PATH/);
  assert.throws(() => buildLaunchAgentPlist({ repoRoot: ROOT, pathEnv: "" }), /PATH/);
});

test("parseLaunchAgentPlist：认标记、取出登录时执行的命令；没有标记的、二进制的、不是字符串的都按「不是我们放的」", () => {
  const own = parseLaunchAgentPlist(buildLaunchAgentPlist({ repoRoot: ROOT, pathEnv: PATH_ENV }));
  assert.equal(own.managed, true);
  assert.deepEqual(own.program, launchAgentProgram(ROOT));
  assert.deepEqual(own.program, ["/bin/bash", `${ROOT}/start.sh`, AUTOSTART_FLAG]);

  const foreign = parseLaunchAgentPlist(`<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${LAUNCH_AGENT_LABEL}</string><key>ProgramArguments</key><array><string>/usr/local/bin/other</string></array></dict></plist>`);
  assert.deepEqual(foreign, { managed: false, program: ["/usr/local/bin/other"] }, "同一个标签但没有标记：不是工作台放的");
  assert.deepEqual(parseLaunchAgentPlist("bplist00Ñ\u0001\u0002"), { managed: false, program: [] });
  assert.deepEqual(parseLaunchAgentPlist(""), { managed: false, program: [] });
  assert.deepEqual(parseLaunchAgentPlist(null), { managed: false, program: [] });
  assert.deepEqual(parseLaunchAgentPlist(undefined), { managed: false, program: [] });
});

// plutil 只在 macOS 上有；只对 os.tmpdir() 下的临时文件用，不碰 ~/Library/LaunchAgents。
const onMac = process.platform === "darwin";

test("plutil -lint：生成的 plist 是合法的属性列表，解析出来的结构与预期逐项一致", { skip: onMac ? false : "plutil 只在 macOS 上有" }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "autostart-plist-"));
  try {
    const cases = [
      { repoRoot: ROOT, pathEnv: PATH_ENV },
      { repoRoot: "/Users/秀 杨/Documents/集群codex连接", pathEnv: buildLaunchPath({ pathEnv: "/Users/秀 杨/bin:/opt/a&b/bin" }) },
      { repoRoot: "/tmp/we<i>rd & \"quoted\" 'dir'", pathEnv: "/usr/bin:/bin" },
    ];
    for (const [index, input] of cases.entries()) {
      const file = path.join(dir, `case-${index}.plist`);
      writeFileSync(file, buildLaunchAgentPlist(input));
      const lint = spawnSync("plutil", ["-lint", file], { encoding: "utf8" });
      assert.equal(lint.status, 0, `plutil -lint 失败：${lint.stdout}${lint.stderr}`);
      // -o - 把转换结果写到标准输出，不改文件。
      const json = spawnSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" });
      assert.equal(json.status, 0, `plutil -convert 失败：${json.stdout}${json.stderr}`);
      assert.deepEqual(JSON.parse(json.stdout), {
        Label: LAUNCH_AGENT_LABEL,
        ProgramArguments: ["/bin/bash", `${input.repoRoot}/start.sh`, "--autostart"],
        WorkingDirectory: input.repoRoot,
        EnvironmentVariables: { PATH: input.pathEnv },
        RunAtLoad: true,
        KeepAlive: { SuccessfulExit: false },
        ThrottleInterval: LAUNCH_AGENT_THROTTLE_SECONDS,
        ProcessType: "Interactive",
        StandardOutPath: "/dev/null",
        StandardErrorPath: "/dev/null",
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
