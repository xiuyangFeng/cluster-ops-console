import assert from "node:assert/strict";
import { test } from "node:test";

import { diskEntryHtml, ownerSlots, pickEntryDisk, splitSegments, squarify, tone, treemapHtml, userRowsHtml } from "./storage-admin-viz.js";

test("squarify：块铺满整个矩形、互不重叠、面积与数值成正比", () => {
  const values = [600, 300, 200, 120, 80, 40, 20, 10];
  const cells = squarify(values.map((value, i) => ({ value, i })), 1200, 480);
  assert.equal(cells.length, values.length);
  const total = values.reduce((a, b) => a + b, 0);
  const area = cells.reduce((s, c) => s + c.w * c.h, 0);
  assert.ok(Math.abs(area - 1200 * 480) < 1e-6, "面积之和等于整块");
  for (const c of cells) {
    assert.ok(Math.abs((c.w * c.h) / (1200 * 480) - c.value / total) < 1e-9, "单块面积按比例");
    assert.ok(c.x >= -1e-9 && c.y >= -1e-9 && c.x + c.w <= 1200 + 1e-6 && c.y + c.h <= 480 + 1e-6, "不出界");
  }
  for (let a = 0; a < cells.length; a++) {
    for (let b = a + 1; b < cells.length; b++) {
      const p = cells[a];
      const q = cells[b];
      const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
      const oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
      assert.ok(ox <= 1e-6 || oy <= 1e-6, `第 ${a} 与第 ${b} 块不重叠`);
    }
  }
  // 最大那块接近正方形（squarified 的意义所在）
  const big = cells.find((c) => c.i === 0);
  assert.ok(Math.max(big.w / big.h, big.h / big.w) < 3);
  assert.deepEqual(squarify([], 10, 10), []);
  assert.deepEqual(squarify([{ value: 0 }], 10, 10), []);
});

test("颜色跟人走：前 5 名占固定色位，第 6 名起不分色", () => {
  const rows = [3, 9, 1, 7, 5, 8].map((bytes, uid) => ({ uid, bytes }));
  const slots = ownerSlots(rows);
  assert.deepEqual([...slots.entries()], [[1, 1], [5, 2], [3, 3], [4, 4], [0, 5]]);
  assert.equal(slots.get(2), undefined);
  const html = userRowsHtml({ rows: rows.map((r) => ({ ...r, name: `u${r.uid}`, share: 0.1, files: 1 })) });
  assert.match(html, /data-slot="1"><\/span>u1</);
  assert.match(html, /data-kind="others"><\/span>u2</);
});

test("分段条：前 5 人 + 其他用户 + 未归属 + 剩余，按「已用 + 可用」口径", () => {
  const rows = [50, 20, 10, 5, 3, 2, 1].map((bytes, uid) => ({ uid, name: `u${uid}`, bytes }));
  const segs = splitSegments({ used: 100, avail: 50, size: 160, rows });
  assert.deepEqual(segs.map((s) => s.kind), ["user", "user", "user", "user", "user", "others", "unassigned", "free"]);
  assert.equal(segs.find((s) => s.kind === "others").bytes, 3);
  assert.equal(segs.find((s) => s.kind === "unassigned").bytes, 9);
  assert.equal(segs.find((s) => s.kind === "free").bytes, 50);
  assert.ok(Math.abs(segs.reduce((s, x) => s + x.ratio, 0) - 1) < 1e-9);
  assert.deepEqual(splitSegments({ used: 0, avail: 0, rows: [] }), []);
});

test("树图：深浅按占比分档，名字转义，超出的小目录并进「其余」", () => {
  assert.deepEqual([0.5, 0.1, 0.03, 0.001].map(tone), [4, 3, 2, 1]);
  const children = Array.from({ length: 40 }, (_, i) => ({ rel: `d${i}`, name: i === 0 ? "<b>x</b>" : `d${i}`, blocks: 1000 - i * 10, share: 0, files: 1, deeper: i % 2 === 0 }));
  const html = treemapHtml({ path: "/public", node: { blocks: 40_000 }, children, rest: 500 });
  assert.equal((html.match(/class="sa-tm-tile"/g) || []).length, 37, "36 块 + 其余");
  assert.match(html, /其余（含另外 4 个目录）/);
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.ok(!html.includes("<b>x</b>"));
  assert.equal(treemapHtml({ path: "/", node: { blocks: 0 }, children: [] }), "");
});

test("磁盘卡片入口：先按主机地址、再按挂载点对上那块盘；对不上就取最满的", () => {
  const mk = (id, host, mounts, users = []) => ({ id, label: id, host, info: { mounts }, users });
  const m = (mount, used, avail) => ({ mount, used, avail, size: used + avail });
  const data = { targets: [
    mk("master", "1.1.1.1", [m("/public", 93, 7)], [{ mount: "/public", used: 93, rows: [{ uid: 1, name: "kai", bytes: 40 }] }]),
    mk("node04", "2.2.2.2", [m("/mnt/data1", 50, 50), m("/mnt/data2", 99, 1)]),
  ] };
  assert.equal(pickEntryDisk(data, { hosts: ["1.1.1.1"], mount: "/public" }).mount.mount, "/public");
  assert.equal(pickEntryDisk(data, { hosts: ["2.2.2.2"], mount: "/home" }).mount.mount, "/mnt/data2");
  assert.equal(pickEntryDisk(data, { hosts: [], mount: "/mnt/data1" }).target.id, "node04");
  const html = diskEntryHtml(data, { hosts: ["1.1.1.1"], mount: "/public" });
  assert.match(html, /master \/public · 最多 kai 40 B/);
  assert.match(html, /class="res-sa-split"/);
  assert.match(diskEntryHtml(null), /各盘按用户占用与目录树/);
});
