"use strict";
const $ = (id) => document.getElementById(id);
const colors = [
  "#0784a0",
  "#ee8545",
  "#7d63ad",
  "#36a278",
  "#c75a77",
  "#b49b35",
];
let token = "",
  state = { nodes: [], signals: [], blocks: [], blockTypes: [] },
  selected = new Set(),
  live = {},
  busy = false,
  paused = false,
  currentComponent = "";
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function notice(message, error = false) {
  $("notice").hidden = false;
  $("notice").className = "notice" + (error ? " error" : "");
  $("notice").textContent = message;
}
async function api(op, args = {}) {
  const r = await fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-DAQ-Token": token },
    body: JSON.stringify({ op, args }),
  });
  const data = await r.json();
  if (!r.ok || !data.ok) throw Error(data.error || "操作失敗");
  return data.result;
}
async function action(fn) {
  if (busy) return;
  busy = true;
  updateButtons();
  try {
    await fn();
  } catch (e) {
    notice(e.message, true);
  } finally {
    busy = false;
    updateButtons();
  }
}
function updateButtons() {
  document.querySelectorAll("button").forEach((b) => {
    if (!b.classList.contains("nav") && b.id !== "pause-plot")
      b.disabled = busy;
  });
  $("start").disabled = busy || live.running;
  $("stop").disabled = busy || !live.running;
  $("record-start").disabled = busy || !live.running || !!live.recording;
  $("record-stop").disabled = busy || !live.recording;
  $("scan").disabled = busy || live.running;
  $("load-config").disabled = busy || live.running;
}
function showTab(id) {
  document
    .querySelectorAll(".tab")
    .forEach((n) => n.classList.toggle("active", n.id === id));
  document
    .querySelectorAll(".nav")
    .forEach((n) => n.classList.toggle("active", n.dataset.tab === id));
  $("page-title").textContent = document.querySelector(
    `[data-tab="${id}"] span`,
  ).textContent;
  if (id === "acquisition") drawPlots();
}
document
  .querySelectorAll(".nav")
  .forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
function button(text, fn, cls) {
  const b = el("button", text, cls);
  b.onclick = () => action(fn);
  return b;
}
function describe(n) {
  const d = el("div");
  d.append(
    el("span", n.name, "item-name"),
    el("div", n.connection || n.id, "item-detail"),
  );
  return d;
}
async function refresh() {
  state = await api("state");
  selected = new Set(
    [...selected].filter((id) => state.signals.some((s) => s.id === id)),
  );
  renderDevices();
  renderSignals();
  renderBlocks();
  const selector = $("component");
  selector.replaceChildren();
  for (const n of [...state.nodes, ...state.signals]) {
    const o = el("option", `${n.kind} / ${n.name}`);
    o.value = n.id;
    selector.append(o);
  }
  if ([...selector.options].some((o) => o.value === currentComponent))
    selector.value = currentComponent;
  currentComponent = selector.value;
  if (currentComponent) await properties();
  $("updated").textContent =
    "SDK 狀態已更新 · " + new Date().toLocaleTimeString();
}
function renderDevices() {
  const box = $("connected");
  box.classList.remove("empty");
  box.replaceChildren();
  const devices = state.nodes.filter((n) => n.kind === "device");
  if (!devices.length) {
    box.classList.add("empty");
    box.textContent = "尚未連線。";
  }
  for (const d of devices) {
    const row = el("div", undefined, "device-row");
    row.append(
      describe(d),
      button(
        "中斷連線",
        async () => {
          await api("disconnect", { id: d.id });
          await refresh();
          notice("裝置已中斷連線。");
        },
        "danger",
      ),
    );
    box.append(row);
  }
}
function renderSignals() {
  const box = $("signals");
  box.replaceChildren();
  box.classList.remove("empty");
  for (const s of state.signals) {
    const label = el("label", undefined, "signal-option"),
      check = el("input");
    check.type = "checkbox";
    check.checked = selected.has(s.id);
    check.disabled = !!live.running;
    check.onchange = () => {
      if (check.checked) selected.add(s.id);
      else selected.delete(s.id);
    };
    const text = el("span", s.name + (s.unit ? ` · ${s.unit}` : ""));
    text.append(el("small", s.id));
    label.append(check, text);
    box.append(label);
  }
  if (!state.signals.length) {
    box.classList.add("empty");
    box.textContent = "連線裝置後選擇訊號。";
  }
}
async function properties() {
  if (!currentComponent) return;
  const result = await api("properties", { id: currentComponent }),
    table = el("table"),
    head = el("tr");
  ["屬性", "數值", "操作"].forEach((s) => head.append(el("th", s)));
  table.append(head);
  for (const p of result.properties) {
    const row = el("tr"),
      name = el("td", p.name),
      cell = el("td"),
      controls = el("td");
    if (p.description) name.append(el("div", p.description, "muted"));
    const primitive =
      [0, 1, 2, 3].includes(p.type) &&
      (typeof p.value === "string" ||
        typeof p.value === "number" ||
        typeof p.value === "boolean");
    if (p.readOnly || !primitive || p.error) {
      cell.textContent = p.error || JSON.stringify(p.value);
      controls.textContent = p.readOnly ? "唯讀" : "僅供檢視";
    } else {
      let input;
      if (Array.isArray(p.selection)) {
        input = el("select");
        p.selection.forEach((v, i) => {
          const o = el("option", String(v));
          o.value = i;
          input.append(o);
        });
        input.value = p.value;
      } else if (typeof p.value === "boolean") {
        input = el("select");
        for (const [v, t] of [
          ["true", "開啟"],
          ["false", "關閉"],
        ]) {
          const o = el("option", t);
          o.value = v;
          input.append(o);
        }
        input.value = String(p.value);
      } else {
        input = el("input");
        input.type = typeof p.value === "number" ? "number" : "text";
        input.value = p.value;
        if (input.type === "number") {
          input.step = "any";
          if (p.min !== undefined) input.min = p.min;
          if (p.max !== undefined) input.max = p.max;
        }
      }
      input.setAttribute("aria-label", p.name);
      cell.append(input);
      controls.append(
        button("套用", async () => {
          let value = input.value;
          if (typeof p.value === "number") {
            if (!value.trim()) throw Error("請輸入數值");
            value = Number(value);
            if (!Number.isFinite(value)) throw Error("數值格式不正確");
          } else if (typeof p.value === "boolean") value = value === "true";
          await api("set", { id: currentComponent, name: p.name, value });
          await properties();
          notice(p.name + " 已更新。");
        }),
      );
    }
    row.append(name, cell, controls);
    table.append(row);
  }
  $("properties").replaceChildren(table);
}
function renderBlocks() {
  const types = $("block-type");
  types.replaceChildren();
  for (const t of state.blockTypes) {
    const o = el("option", t.name + " / " + t.id);
    o.value = t.id;
    types.append(o);
  }
  const box = $("blocks");
  box.replaceChildren();
  box.classList.remove("empty");
  if (!state.blocks.length) {
    box.classList.add("empty");
    box.textContent = "尚未新增功能方塊。";
  }
  for (const b of state.blocks) {
    const card = el("article", undefined, "panel"),
      heading = el("div", undefined, "panel-head");
    heading.append(
      describe(b),
      button(
        "移除",
        async () => {
          await api("block_remove", { id: b.id });
          await refresh();
        },
        "danger",
      ),
    );
    card.append(heading);
    card.append(
      button("編輯屬性", async () => {
        currentComponent = b.id;
        showTab("devices");
        $("component").value = b.id;
        await properties();
      }),
    );
    for (const p of b.ports) {
      const row = el("div", undefined, "port-row"),
        select = el("select");
      select.setAttribute("aria-label", p.name + " 輸入訊號");
      const none = el("option", "選擇訊號");
      none.value = "";
      select.append(none);
      for (const s of state.signals) {
        const o = el("option", s.name + " / " + s.id);
        o.value = s.id;
        select.append(o);
      }
      select.value = p.signal;
      row.append(
        el("span", p.name),
        select,
        button("接線", async () => {
          if (!select.value) throw Error("請選擇訊號");
          await api("port_connect", { port: p.id, signal: select.value });
          await refresh();
        }),
        button("解除", async () => {
          await api("port_disconnect", { port: p.id });
          await refresh();
        }),
      );
      card.append(row);
    }
    box.append(card);
  }
}
async function connectDevice(connection) {
  const args = { connection };
  if ($("username").value) {
    args.username = $("username").value;
    args.password = $("password").value;
  }
  await api("connect", args);
  $("password").value = "";
}
function connection() {
  const v = $("address").value.trim();
  return $("protocol").value === "custom" ? v : $("protocol").value + v;
}
function preview() {
  $("connection-preview").textContent = connection();
}
$("protocol").onchange = preview;
$("address").oninput = preview;
preview();
$("scan").onclick = () =>
  action(async () => {
    notice("正在探索裝置，請稍候…");
    const { devices } = await api("scan"),
      box = $("discovered");
    box.replaceChildren();
    box.classList.remove("empty");
    for (const d of devices) {
      const row = el("div", undefined, "device-row"),
        desc = describe(d);
      if (d.connection.startsWith("daqref://"))
        desc.append(el("span", "SDK 參考裝置", "badge reference"));
      row.append(
        desc,
        button("連線", async () => {
          await connectDevice(d.connection);
          await refresh();
          notice("裝置已連線。");
        }),
      );
      box.append(row);
    }
    if (!devices.length) {
      box.classList.add("empty");
      box.textContent =
        "未發現裝置。請確認後端與裝置位於相同網段，或使用直接連線。";
    }
    notice(`探索完成：${devices.length} 個裝置（含已安裝的參考裝置）。`);
  });
$("connect-form").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    const c = connection();
    if (!c.trim()) throw Error("請輸入連線資訊");
    notice("正在連線 " + c);
    await connectDevice(c);
    await refresh();
    notice("裝置已連線。請到「擷取與波形」選擇訊號。");
  });
};
$("refresh").onclick = () => action(refresh);
$("component").onchange = () =>
  action(async () => {
    currentComponent = $("component").value;
    await properties();
  });
$("start").onclick = () =>
  action(async () => {
    live = await api("start", { signals: [...selected] });
    renderSignals();
    renderLive();
    notice("擷取已開始。");
  });
$("stop").onclick = () =>
  action(async () => {
    live = await api("stop");
    renderSignals();
    renderLive();
    notice("擷取已停止，已讀取的波形與統計仍保留。");
  });
$("record-start").onclick = () =>
  action(async () => {
    live = await api("record_start");
    renderLive();
    notice("已開始 CSV 錄製。");
  });
$("record-stop").onclick = () =>
  action(async () => {
    live = await api("record_stop");
    renderLive();
    notice("錄製已完成，可在「組態與紀錄」下載。");
  });
$("block-form").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    if (!$("block-type").value) throw Error("沒有可用的功能方塊模組");
    await api("block_add", { type: $("block-type").value });
    await refresh();
    notice("功能方塊已建立，請接上輸入訊號。");
  });
};
$("pause-plot").onclick = () => {
  paused = !paused;
  $("pause-plot").textContent = paused ? "繼續畫面" : "暫停畫面";
  if (!paused) drawPlots();
};
function download(name, text) {
  const url = URL.createObjectURL(
      new Blob([text], { type: "application/json" }),
    ),
    a = el("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("save-config").onclick = () =>
  action(async () => {
    const r = await api("config_save");
    download("opendaq-workstation.json", r.configuration);
    notice("組態已匯出。");
  });
$("load-config").onchange = (e) =>
  action(async () => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) throw Error("組態檔不能超過 2 MiB");
    const configuration = await f.text();
    JSON.parse(configuration);
    if (!window.confirm("載入組態將修改目前裝置與功能方塊設定，是否繼續？"))
      return;
    await api("config_load", { configuration });
    selected.clear();
    await refresh();
    notice("組態已載入。");
  }).finally(() => {
    $("load-config").value = "";
  });
function fmt(n) {
  return n === null || n === undefined
    ? "—"
    : Number(n).toLocaleString(undefined, { maximumSignificantDigits: 6 });
}
function renderLive() {
  $("run-dot").classList.toggle("live", !!live.running);
  $("run-status").textContent = live.running ? "擷取中" : "待命";
  $("record-status").textContent = live.recording ? "● REC" : "";
  $("record-detail").textContent = live.recording
    ? `錄製中 · ${live.recording.rows.toLocaleString()} 筆 · ${live.recording.name}`
    : "尚未錄製或已結束。";
  const table = el("table"),
    head = el("tr");
  ["訊號", "筆數", "最小", "最大", "平均", "RMS", "待讀"].forEach((t) =>
    head.append(el("th", t)),
  );
  table.append(head);
  for (const s of live.series || []) {
    const row = el("tr");
    const signal = state.signals.find((x) => x.id === s.id);
    [
      signal?.name || s.id,
      s.count,
      s.min,
      s.max,
      s.mean,
      s.rms,
      s.pending,
    ].forEach((v, i) => row.append(el("td", i ? fmt(v) : v)));
    table.append(row);
  }
  $("statistics").replaceChildren(table);
  const records = $("recordings");
  records.replaceChildren();
  records.classList.remove("empty");
  for (const r of live.recordings || []) {
    const row = el("div", undefined, "record-row"),
      a = el("a", "下載 CSV");
    a.href = "/api/recordings/" + encodeURIComponent(r.id);
    a.download = r.name;
    row.append(el("span", `${r.name} · ${r.rows.toLocaleString()} 筆`), a);
    records.append(row);
  }
  if (!records.childNodes.length) {
    records.classList.add("empty");
    records.textContent = "尚無完成的錄製檔。";
  }
  const events = $("events");
  events.replaceChildren();
  for (const e of [...(live.events || [])].reverse()) {
    const row = el("div", undefined, "event");
    row.append(
      el("time", new Date(e.time).toLocaleTimeString()),
      el("span", e.message),
    );
    events.append(row);
  }
  $("sdk-logs").textContent = (live.sdkLogs || []).join("\n");
  if (!paused) drawPlots();
  updateButtons();
}
function drawPlots() {
  if (!$("acquisition").classList.contains("active")) return;
  const box = $("plots");
  box.replaceChildren();
  box.classList.remove("empty");
  (live.series || []).forEach((s, i) => {
    const wrap = el("div", undefined, "plot"),
      label = el("div", undefined, "plot-label"),
      signal = state.signals.find((x) => x.id === s.id),
      canvas = el("canvas");
    label.append(
      el(
        "strong",
        (signal?.name || s.id) + (signal?.unit ? " / " + signal.unit : ""),
      ),
      el("span", `${s.count.toLocaleString()} samples`),
    );
    wrap.append(label, canvas);
    box.append(wrap);
    const width = Math.max(200, canvas.clientWidth),
      height = 180,
      ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    const pts = s.points || [],
      finite = pts.filter((p) => p[1] !== null && Number.isFinite(p[1]));
    if (!finite.length) {
      ctx.fillStyle = "#8fa3ad";
      ctx.fillText("等待訊號資料…", 48, 80);
      return;
    }
    let ymin = Math.min(...finite.map((p) => p[1])),
      ymax = Math.max(...finite.map((p) => p[1]));
    const pad = (ymax - ymin) * 0.12 || Math.max(0.1, Math.abs(ymax) * 0.1);
    ymin -= pad;
    ymax += pad;
    const xmin = pts[0][0],
      xmax = pts.at(-1)[0],
      xr = xmax - xmin || 1;
    ctx.font = "10px system-ui";
    for (let n = 0; n < 5; n++) {
      const y = 12 + n * 34;
      ctx.strokeStyle = "#e9eff2";
      ctx.beginPath();
      ctx.moveTo(54, y);
      ctx.lineTo(width - 10, y);
      ctx.stroke();
      ctx.fillStyle = "#7f959f";
      ctx.fillText((ymax - ((ymax - ymin) * n) / 4).toPrecision(3), 0, y + 3);
    }
    ctx.strokeStyle = colors[i % colors.length];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let begun = false;
    for (const p of pts) {
      if (p[1] === null) {
        begun = false;
        continue;
      }
      const x = 54 + ((p[0] - xmin) / xr) * (width - 66),
        y = 12 + ((ymax - p[1]) / (ymax - ymin)) * 136;
      if (begun) ctx.lineTo(x, y);
      else {
        ctx.moveTo(x, y);
        begun = true;
      }
    }
    ctx.stroke();
    ctx.fillStyle = "#7f959f";
    ctx.fillText(xmin.toFixed(3) + " s", 54, 170);
    ctx.fillText(xmax.toFixed(3) + " s", Math.max(54, width - 65), 170);
  });
  if (!box.childNodes.length) {
    box.classList.add("empty");
    box.textContent = "選擇訊號並開始擷取以顯示波形。";
  }
}
window.addEventListener("resize", () => {
  if (!paused) drawPlots();
});
async function poll() {
  try {
    const response = await fetch("/api/live");
    if (!response.ok) throw Error("無法讀取擷取狀態");
    live = await response.json();
    renderLive();
  } catch (e) {
    notice("後端連線中斷：" + e.message, true);
  } finally {
    setTimeout(poll, 500);
  }
}
(async () => {
  try {
    const r = await fetch("/api/session");
    const session = await r.json();
    token = session.token;
    await action(refresh);
    poll();
  } catch (e) {
    notice("無法啟動：" + e.message, true);
  }
})();
