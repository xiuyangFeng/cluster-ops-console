import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export async function runRootAdminBrowserSmoke({ win, baseUrl, waitFor, screenshotDir }) {
  const headers = { "x-auth-token": "smoke-fixture-token", "content-type": "application/json" };
  const api = async (url, method = "GET", body) => {
    const res = await fetch(`${baseUrl}${url}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await res.json();
    assert.ok(res.ok, `${url}: ${JSON.stringify(data)}`);
    return data;
  };
  const page = (js) => win.webContents.executeJavaScript(js);
  await api("/api/config/personal", "POST", { sshUser: "root", activeServerId: "fixture-server" });
  await win.loadURL(baseUrl);
  await waitFor(() => page('!document.getElementById("tab-team").hidden && !document.getElementById("tab-storage").hidden'), "root management entries did not appear");
  await page('document.getElementById("connectionAddBtn").click()');
  await waitFor(() => page('document.getElementById("dlgSettings").open && !document.getElementById("serverRegistrySaveBtn").disabled'), "add connection did not open settings");
  await page(`(() => {
    const form = document.getElementById('serverRegistryForm');
    form.elements.name.value = 'Node04 smoke';
    form.elements.address.value = 'node04.fixture.invalid';
    form.elements.sshPort.value = '22';
    form.elements.sshUser.value = 'root';
    document.getElementById('serverRegistrySaveBtn').click();
    return true;
  })()`);
  let added;
  await waitFor(async () => { added = (await api("/api/servers")).servers.find((s) => s.name === "Node04 smoke"); return Boolean(added); }, async () => `second connection was not saved: ${await page('JSON.stringify({hint:document.getElementById("serverRegistryHint")?.textContent,invalid:[...document.querySelectorAll("#serverRegistryForm :invalid")].map(n=>n.name),disabled:document.getElementById("serverRegistrySaveBtn").disabled})')}`);
  await waitFor(() => page(`Boolean([...document.getElementById('connectionProfileSelect').options].find(o => o.value === ${JSON.stringify(added.id)}))`), "top connection picker did not receive second connection");
  await page(`document.getElementById('dlgSettings').close(); const picker = document.getElementById('connectionProfileSelect'); picker.value = ${JSON.stringify(added.id)}; picker.dispatchEvent(new Event('change')); true;`);
  await waitFor(async () => (await api("/api/config")).activeServerId === added.id, "second connection did not become active");
  await page('document.getElementById("tab-storage").click()');
  await waitFor(() => page('document.querySelector("[data-sa-target-form] [name=host]")?.value === "node04.fixture.invalid"'), "storage setup was not prefilled from node04");
  win.setSize(520, 820);
  await waitFor(() => page("window.innerWidth <= 520"), "root storage narrow layout did not resize");
  assert.ok(await page("document.documentElement.scrollWidth - document.documentElement.clientWidth <= 2"), "root storage form overflowed");
  if (screenshotDir) await writeFile(path.join(screenshotDir, "root-storage-config.png"), (await win.webContents.capturePage()).toPNG());
  await page('document.querySelector("[data-sa-target-form] [name=roots]").value = "/mnt"; document.querySelector("[data-sa-save-target]").click(); true;');
  await waitFor(async () => (await api("/api/config/personal")).config.storageAdmin?.targets?.some((t) => t.id === added.id && t.roots.join() === "/mnt"), "storage target was not saved from the form");
  // 全局 root 不得覆盖另一个连接显式设置的普通用户。
  const listed = await api("/api/servers");
  await api(`/api/servers/${encodeURIComponent(added.id)}`, "PATCH", { sshUser: "lin", expectedRevision: listed.revision });
  await win.loadURL(baseUrl);
  await waitFor(() => page('document.getElementById("tab-team").hidden && document.getElementById("tab-storage").hidden'), "ordinary connection retained root entries");
  for (const url of ["/api/team/overview", "/api/storage-admin"]) assert.equal((await fetch(`${baseUrl}${url}`, { headers })).status, 403, url);
  win.setSize(1100, 820);
  console.log("browser-smoke: root menus + multiple connections + storage configuration + ordinary-user denial ok");
}
