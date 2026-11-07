// app/settings-autostart.js —— 配置浮层「启动」一节（v2.62）：一个开关「登录电脑后自动启动」加一句说明。
//
// 打开配置时读 GET /api/autostart。用哪种办法由安装形态决定（后端给 method），页面只跟着走：
//   launch-agent（macOS 源码安装）/ startup-folder（Windows）  开关直接 POST /api/autostart { enabled }；
//   login-item（打包的 .app）  登录项在桌面壳里，经 window.electronAPI.getAutostart / setAutostart 读写并回读；
//                              用浏览器打开这份 App 的页面时没有这个接口，开关不可用，说明去哪里设；
//   none（Linux 等）           开关不可用，给一条手动命令。
// 骨架在 index.html（#settingsAutostart），这里只改文字、显隐与开关的勾选 / 禁用——开关从不重建，焦点不丢。
// 说明文字按「这一页是不是开在桌面窗口里」分两种说法：桌面窗口关掉只是收进菜单栏；网页模式登录后没有窗口。

const errText = (err) => err?.serverMessage || err?.message || "未知错误";

// 纯函数：把桌面壳回读的登录项结果并进后端给的状态。
export function mergeLoginItem(status, item) {
  const supported = item?.supported === true;
  const enabled = supported && item.enabled === true;
  return {
    ...status,
    supported,
    enabled,
    state: enabled ? "on" : "off",
    loginItem: { status: item?.status ?? null, error: item?.error ?? null },
  };
}

function methodText(status, desktop) {
  if (status.method === "launch-agent") {
    return desktop
      ? "用的是 macOS 的登录启动项（LaunchAgent）。登录后自动打开桌面窗口；关掉窗口只是收进菜单栏，隧道还在。"
      : "用的是 macOS 的登录启动项（LaunchAgent）。登录后工作台在后台运行，没有终端窗口，隧道不会因为关窗口断开；浏览器不会自动打开，要看页面时点桌面图标。";
  }
  if (status.method === "startup-folder") {
    return "用的是 Windows「启动」文件夹里的一个脚本。登录后工作台在一个最小化的命令行窗口里运行，浏览器不会自动打开，要看页面时点桌面图标；请不要关那个窗口：关掉后工作台就停了，隧道没有人守护。";
  }
  if (status.method === "login-item") {
    return "用的是 macOS 的登录项。登录后自动打开工作台；关掉窗口只是收进菜单栏，隧道还在。";
  }
  return "这个系统上没有做自动设置（目前只支持 macOS 与 Windows）。想让工作台在后台运行、关掉终端也不停，在终端执行下面这条命令；要开机自启，把它加进桌面环境的自启动项。";
}

// 纯函数：这一节此刻该显示什么。
//   available  开关能不能点；checked 开关的勾选
//   text       一句说明（用的是哪种方式、关掉窗口后隧道是否还在）
//   note       现状的补充（什么时候生效），没有为空
//   warn       需要用户知道或处理的情况，没有为空
//   command    手动命令（只在不支持自动设置的系统上有）
export function describeAutostart(status, { desktop = false } = {}) {
  if (!status) return { available: false, checked: false, text: "打开后读取启动设置…", note: "", warn: "", command: "" };
  const view = { available: false, checked: status.enabled === true, text: methodText(status, desktop), note: "", warn: "", command: "" };
  const warns = [];

  if (status.method === "login-item") {
    if (status.desktopOnly) {
      warns.push("这是打包的 App：请在它的桌面窗口里打开「配置 → 启动」来设置。");
    } else if (!status.supported) {
      warns.push("这个窗口读不到系统的登录项，暂时没法在这里设置。");
    } else {
      view.available = true;
      if (status.loginItem?.error) warns.push(`读不出系统的登录项（${status.loginItem.error}）。`);
      else if (status.loginItem?.status === "requires-approval") warns.push("系统还没有允许：请到「系统设置 → 通用 → 登录项」里把它打开。");
    }
    view.warn = warns.join("");
    return view;
  }

  if (!status.supported) {
    if (status.reason === "unsafe-path") {
      view.text = "安装目录的路径没法写进系统的启动项（里面有换行、引号这类字符，或者是网络路径）。把工作台挪到本机的普通路径下再来打开这个开关。";
    } else if (status.reason === "no-startup-folder") {
      view.text = "没有找到当前用户的「启动」文件夹，没法设置。";
    } else {
      view.command = status.manualCommand || "";
    }
    return view;
  }

  if (status.state === "foreign") {
    warns.push(`${status.file} 已经存在，但不是工作台放的，没有改动它。要用这个开关，请先自己把它移走。`);
  } else if (status.state === "unknown") {
    warns.push(`读不出 ${status.file}${status.detail ? `（${status.detail}）` : ""}，没有改动它。`);
  } else {
    view.available = true;
    if (status.state === "other-install") {
      warns.push(`之前在另一个安装目录开过${status.target ? `（${status.target}）` : ""}。在这里打开，会改成启动这一份。`);
    } else if (status.state === "on") {
      view.note = status.fromAutostart
        ? "这一份就是登录时自动启动的。"
        : "下次登录起生效。现在这一份是手动启动的，仍跟着启动它的那个窗口。";
    }
    if (status.caveats?.includes("launcher-path-unknown")) {
      // 后端不知道启动时的 PATH，不会替用户猜：已经开着的仍然可以关，要开得先完整重启一次。
      warns.push("这一份工作台拿不到启动时的 PATH（多半是更新之后还没有完整重启）。请完全退出工作台，从桌面图标再启动一次，然后回来打开这个开关。");
      view.available = status.state === "on";
    }
    if (status.caveats?.includes("protected-folder")) {
      warns.push("安装目录在「文稿 / 桌面 / 下载」或外接磁盘上：登录时 macOS 可能会问是否允许 bash 访问，需要点「允许」，否则启动不了。");
    }
  }
  view.warn = warns.join("");
  return view;
}

// 纯函数：开 / 关成功后的提示。
export function autostartToastText(status, enabled) {
  if (!enabled) return "已关闭，下次登录不再自动启动；现在这一份继续运行。";
  const base = status?.fromAutostart ? "已开启。" : "已开启，下次登录电脑时自动启动。";
  return status?.method === "launch-agent" ? `${base}系统可能提示添加了一个后台项目（显示为 bash），属正常。` : base;
}

// 登录项设置之后回读到的仍是原来的状态：系统没接受。开和关各有各的出路。
const loginItemRejected = (enabled) => (enabled
  ? "系统没有接受这次设置。这份 App 是本机临时签名的时候，macOS 可能不允许它登记登录项；可以到「系统设置 → 通用 → 登录项」里手动添加。"
  : "系统没有接受这次设置；可以到「系统设置 → 通用 → 登录项」里手动把它移除。");

// electronAPI：桌面窗口里的 window.electronAPI（浏览器里为 null）。
export function createSettingsAutostart({ doc, getJson, postJson, showToast, electronAPI = null }) {
  const getEl = (id) => doc.getElementById(id);
  const desktop = Boolean(electronAPI);
  const loginItemApi = () => (typeof electronAPI?.getAutostart === "function" && typeof electronAPI?.setAutostart === "function" ? electronAPI : null);
  let status = null;
  let loadError = "";
  let pending = false; // 写入在飞：开关禁用，避免连点交错
  let seq = 0; // 读与写的发出序号：写入之后才回来的旧读取不覆盖新状态
  let appliedSeq = 0;

  function render() {
    const view = loadError
      ? { available: false, checked: false, text: loadError, note: "", warn: "", command: "" }
      : describeAutostart(status, { desktop });
    const fill = (id, text) => {
      const el = getEl(id);
      if (!el) return;
      if (el.textContent !== text) el.textContent = text;
      el.hidden = !text;
    };
    fill("autostartText", view.text);
    fill("autostartNote", view.note);
    fill("autostartWarn", view.warn);
    fill("autostartCommand", view.command);
    const input = getEl("autostartSwitch");
    if (input) {
      input.checked = view.checked;
      input.disabled = pending || !view.available;
    }
  }

  async function fetchStatus() {
    const base = await getJson("/api/autostart");
    if (base?.method !== "login-item") return base;
    const api = loginItemApi();
    return api ? mergeLoginItem(base, await api.getAutostart()) : { ...base, desktopOnly: true };
  }

  async function load() {
    const mine = ++seq;
    try {
      const next = await fetchStatus();
      if (mine < appliedSeq) return;
      appliedSeq = mine;
      status = next;
      loadError = "";
    } catch (err) {
      if (mine < appliedSeq) return;
      appliedSeq = mine;
      // 404：页面比运行中的监控服务新（刚更新完、还没重启的那一阵），那边还没有这个接口。
      loadError = err?.status === 404
        ? "运行中的监控服务还是旧版本，没有这一项；重启界面后再打开。"
        : `启动设置读取失败：${errText(err)}；重新打开配置可重试。`;
    }
    render();
  }

  async function toggle() {
    const input = getEl("autostartSwitch");
    if (!input || pending || !status) return;
    const enabled = Boolean(input.checked);
    const viaDesktop = status.method === "login-item";
    const api = viaDesktop ? loginItemApi() : null;
    if (viaDesktop && !api) return render();
    const mine = ++seq;
    pending = true;
    input.disabled = true;
    let failed = false;
    try {
      let next;
      if (viaDesktop) {
        // 设置后拿到的是桌面壳回读的结果：系统没接受时它仍是原来的状态。
        next = mergeLoginItem(status, await api.setAutostart(enabled));
        appliedSeq = mine;
        status = next;
        if (next.enabled !== enabled) throw new Error(`${loginItemRejected(enabled)}${next.loginItem?.error ? `（${next.loginItem.error}）` : ""}`);
      } else {
        next = await postJson("/api/autostart", { enabled });
        appliedSeq = mine;
        status = next;
      }
      loadError = "";
      showToast({ type: "success", title: "启动", message: autostartToastText(next, enabled), duration: enabled ? 8000 : 3000 });
    } catch (err) {
      failed = true;
      showToast({ type: "error", title: "启动", message: `没有改成：${errText(err)}`, duration: 10000 });
    } finally {
      pending = false;
      render(); // 失败时勾选回到实际状态
    }
    // 后端拒绝多半是那个文件的情况变了（被别的东西占了、读不出）：重读一次，让说明跟上。
    if (failed && !viaDesktop) await load();
  }

  getEl("autostartSwitch")?.addEventListener("change", toggle);

  return { onOpen: load, load, toggle };
}
