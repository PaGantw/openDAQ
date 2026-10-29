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
let frozenSeries = [];
let lastChainRefresh = 0;
const viewRanges = new Map(),
  plotCursors = new Map();
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
  $("select-visible").disabled = busy || !!live.running;
  $("clear-signals").disabled = busy || !!live.running;
  document
    .querySelectorAll("[data-property-save]")
    .forEach((b) => (b.disabled = busy || !!live.running));
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
  if (id === "acquisition") {
    renderSignals();
    drawPlots();
  }
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
  renderChain();
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
  await renderChannelSettings();
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
function filteredSignals() {
  const query = $("signal-search").value.toLocaleLowerCase().trim();
  return state.signals.filter((s) =>
    (s.name + " " + s.id).toLocaleLowerCase().includes(query),
  );
}
function renderSignals() {
  const box = $("signals");
  box.replaceChildren();
  box.classList.remove("empty");
  for (const s of filteredSignals()) {
    const row = el("div", undefined, "signal-row"),
      label = el("label", undefined, "signal-option"),
      check = el("input");
    check.type = "checkbox";
    check.checked = selected.has(s.id);
    check.disabled = !!live.running || s.readable === false;
    check.onchange = () => {
      if (check.checked && selected.size >= 16) {
        check.checked = false;
        notice("最多選擇 16 個訊號。", true);
        return;
      }
      if (check.checked) selected.add(s.id);
      else selected.delete(s.id);
      $("selected-count").textContent = `已選取 ${selected.size} / 16`;
    };
    const text = el("span", s.name + (s.unit ? " · " + s.unit : ""));
    text.append(
      el(
        "small",
        s.kind === "time"
          ? "TIME／時間軸"
          : s.kind === "vector"
            ? "向量／頻譜"
            : s.readable === false
              ? "目前不支援的資料型態"
              : "純量數值",
      ),
    );
    text.append(el("small", s.id));
    label.append(check, text);
    const settings = button("設定", async () => {
      const owner = state.nodes
        .filter((n) => n.kind === "channel" && s.id.startsWith(n.id + "/"))
        .sort((a, b) => b.id.length - a.id.length)[0];
      if (owner) {
        $("channel-target").value = owner.id;
        $("channel-settings").open = true;
        await properties(owner.id, $("channel-properties"));
      } else {
        currentComponent = s.id;
        $("component").value = s.id;
        showTab("devices");
        await properties();
      }
    });
    settings.setAttribute("aria-label", s.name + " 通道設定");
    row.append(label, settings);
    box.append(row);
  }
  $("selected-count").textContent = `已選取 ${selected.size} / 16`;
  if (!box.childNodes.length) {
    box.classList.add("empty");
    box.textContent = state.signals.length
      ? "沒有符合搜尋的訊號。"
      : "連線裝置後選擇訊號。";
  }
}
async function renderChannelSettings() {
  const selector = $("channel-target"),
    previous = selector.value;
  selector.replaceChildren();
  for (const channel of state.nodes.filter((n) => n.kind === "channel")) {
    const o = el("option", channel.name + " / " + channel.id);
    o.value = channel.id;
    selector.append(o);
  }
  if ([...selector.options].some((o) => o.value === previous))
    selector.value = previous;
  if (selector.value) await properties(selector.value, $("channel-properties"));
  else $("channel-properties").textContent = "尚無可用通道。";
}
$("channel-target").onchange = () =>
  action(() => properties($("channel-target").value, $("channel-properties")));
$("signal-search").oninput = renderSignals;
$("select-visible").onclick = () => {
  if (live.running) return;
  for (const s of filteredSignals()) {
    if (s.readable === false) continue;
    if (selected.size >= 16) break;
    selected.add(s.id);
  }
  renderSignals();
};
$("clear-signals").onclick = () => {
  if (live.running) return;
  selected.clear();
  renderSignals();
};
async function properties(id = currentComponent, target = $("properties")) {
  if (!id) return;
  const result = await api("properties", { id }),
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
          await api("set", { id, name: p.name, value });
          await properties(id, target);
          notice(p.name + " 已更新。");
        }),
      );
    }
    if (controls.querySelector("button"))
      controls.querySelector("button").dataset.propertySave = "true";
    row.append(name, cell, controls);
    table.append(row);
  }
  target.replaceChildren(table);
  updateButtons();
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
    resumeView();
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
function renderChain() {
  const box = $("live-chain");
  box.replaceChildren();
  for (const block of state.blocks) {
    const card = el("div", undefined, "chain-card");
    card.append(el("strong", block.name));
    for (const port of block.ports) {
      const source = state.signals.find((s) => s.id === port.signal);
      card.append(
        el(
          "p",
          `${source?.name || port.signal || "未接線"} → ${port.name} → ${block.name}`,
          "chain-link",
        ),
      );
    }
    for (const id of block.outputs || []) {
      const signal = state.signals.find((s) => s.id === id),
        series = (live.series || []).find((s) => s.id === id);
      const row = el("div", undefined, "chain-output");
      const status = series
        ? series.error
          ? "錯誤：" + series.error
          : series.kind === "vector"
            ? `${series.count} frames／${series.frame?.values.length || 0} 點`
            : `${fmt(series.rawPoints?.at(-1)?.[1] ?? series.points?.at(-1)?.[1])} ${signal?.unit || ""} · ${series.count} samples`
        : "未選為擷取訊號";
      row.append(
        el("span", `${signal?.name || id} → ${status}`),
        button("監看輸出", async () => {
          if (!selected.has(id) && live.running)
            throw Error("請先停止擷取，再加入這個輸出訊號。");
          selected.add(id);
          renderSignals();
          showTab("acquisition");
        }),
      );
      card.append(row);
      if (series) {
        const points =
          series.kind === "vector" && series.frame
            ? series.frame.axis.map((x, i) => [x, series.frame.values[i]])
            : series.points;
        if (points?.length > 1) {
          const c = el("canvas");
          c.className = "chain-preview";
          c.setAttribute("aria-label", (signal?.name || id) + " 即時輸出");
          card.append(c);
          box.append(card);
          chart(c, points, [points[0][0], points.at(-1)[0] || 1], "#0784a0", {
            height: 160,
            xunit:
              series.kind === "vector" ? series.frame.axisUnit || "index" : "s",
          });
        }
      }
    }
    box.append(card);
  }
  if (!state.blocks.length)
    box.textContent = "尚無功能方塊。新增並接線後會顯示即時訊號鏈。";
  $("chain-status").textContent = live.running
    ? "擷取中 · 即時更新"
    : "待命 · 接線狀態";
}
$("export-signals").onclick = () =>
  action(async () =>
    download(
      "opendaq-signals.json",
      JSON.stringify(await api("state"), null, 2),
    ),
  );
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
  [
    "訊號",
    "筆數／幀數",
    "最小",
    "最大",
    "峰對峰",
    "平均",
    "RMS",
    "待讀",
  ].forEach((t) => head.append(el("th", t)));
  table.append(head);
  for (const s of live.series || []) {
    const row = el("tr");
    const signal = state.signals.find((x) => x.id === s.id);
    [
      signal?.name || s.id,
      s.count,
      s.min,
      s.max,
      s.min === null || s.max === null ? null : s.max - s.min,
      s.kind === "vector" ? null : s.mean,
      s.kind === "vector" ? null : s.rms,
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
  if ($("processing").classList.contains("active")) renderChain();
  updateButtons();
}
function displaySeries() {
  return paused ? frozenSeries : live.series || [];
}
function freezeView() {
  if (!paused) frozenSeries = structuredClone(live.series || []);
  paused = true;
  $("pause-plot").textContent = "繼續畫面";
  $("view-status").textContent = "畫面已凍結；擷取與錄製仍持續。";
}
function resumeView() {
  paused = false;
  frozenSeries = [];
  viewRanges.clear();
  plotCursors.clear();
  $("pause-plot").textContent = "暫停畫面";
  $("view-status").textContent = "即時畫面";
  drawPlots();
}
function plotRange(series) {
  const points = series.points || [];
  if (!points.length) return null;
  const end = points.at(-1)[0],
    begin = points[0][0];
  const duration = $("time-window").value;
  return (
    viewRanges.get(series.id) || [
      duration === "all" ? begin : Math.max(0, end - Number(duration)),
      duration === "all"
        ? end > begin
          ? end
          : begin + 1
        : Math.max(Number(duration), end),
    ]
  );
}
function chart(canvas, points, range, color, options = {}) {
  const width = Math.max(220, canvas.clientWidth),
    height = options.height || 210;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  const left = 64,
    right = width - 12,
    top = 16,
    bottom = height - 30;
  const xmin = range[0],
    xmax = range[1],
    span = xmax - xmin || 1;
  const visible = points.filter(
    (p) => p[0] >= xmin && p[0] <= xmax && Number.isFinite(p[1]),
  );
  let ymin = options.ymin,
    ymax = options.ymax;
  if (!Number.isFinite(ymin) || !Number.isFinite(ymax)) {
    ymin = visible.length ? Math.min(...visible.map((p) => p[1])) : -1;
    ymax = visible.length ? Math.max(...visible.map((p) => p[1])) : 1;
    const pad = (ymax - ymin) * 0.12 || Math.max(0.1, Math.abs(ymax) * 0.1);
    ymin -= pad;
    ymax += pad;
  }
  const x = (t) => left + ((t - xmin) / span) * (right - left);
  const y = (value) =>
    bottom - ((value - ymin) / (ymax - ymin)) * (bottom - top);
  ctx.font = "10px system-ui";
  for (let n = 0; n <= 4; n++) {
    const yy = top + (n * (bottom - top)) / 4;
    ctx.strokeStyle = "#e9eff2";
    ctx.beginPath();
    ctx.moveTo(left, yy);
    ctx.lineTo(right, yy);
    ctx.stroke();
    ctx.fillStyle = "#6a8491";
    ctx.fillText((ymax - (n * (ymax - ymin)) / 4).toPrecision(4), 0, yy + 3);
  }
  ctx.fillStyle = "#6a8491";
  ctx.fillText(
    xmin.toFixed(3) + " " + (options.xunit || "s"),
    left,
    height - 8,
  );
  const last = xmax.toFixed(3) + " " + (options.xunit || "s");
  ctx.fillText(
    last,
    Math.max(left, right - ctx.measureText(last).width),
    height - 8,
  );
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, right - left, bottom - top);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  let begun = false;
  for (const p of points) {
    if (!Number.isFinite(p[1])) {
      begun = false;
      continue;
    }
    if (p[0] < xmin || p[0] > xmax) continue;
    if (begun) ctx.lineTo(x(p[0]), y(p[1]));
    else {
      ctx.moveTo(x(p[0]), y(p[1]));
      begun = true;
    }
  }
  ctx.stroke();
  for (const [name, point] of Object.entries(options.cursors || {})) {
    if (!point || point[0] < xmin || point[0] > xmax) continue;
    ctx.strokeStyle = name === "a" ? "#d75c32" : "#8054aa";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x(point[0]), top);
    ctx.lineTo(x(point[0]), bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.arc(x(point[0]), y(point[1]), 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(name.toUpperCase(), x(point[0]) + 5, top + 12);
  }
  if (options.drag) {
    ctx.fillStyle = "#0784a02a";
    ctx.fillRect(
      x(options.drag[0]),
      top,
      x(options.drag[1]) - x(options.drag[0]),
      bottom - top,
    );
  }
  ctx.restore();
  if (!visible.length) {
    ctx.fillStyle = "#8095a0";
    ctx.fillText("此時窗沒有可顯示的資料", left + 8, top + 35);
  }
  return {
    left,
    right,
    timeAt: (pixel) =>
      xmin + Math.max(0, Math.min(1, (pixel - left) / (right - left))) * span,
  };
}
function cursorText(readout, series, unit) {
  const xunit =
    series.kind === "vector" ? series.frame?.axisUnit || "index" : "s";
  const cursors = plotCursors.get(series.id) || {},
    parts = [];
  for (const key of ["a", "b"])
    if (cursors[key])
      parts.push(
        `${key.toUpperCase()}: ${cursors[key][0].toFixed(6)} ${xunit} / ${fmt(cursors[key][1])} ${unit}`,
      );
  if (cursors.a && cursors.b) {
    const dt = cursors.b[0] - cursors.a[0],
      dv = cursors.b[1] - cursors.a[1];
    parts.push(
      `Δ${xunit === "s" ? "t" : "X"} ${dt.toFixed(6)} ${xunit} · ΔY ${fmt(dv)} ${unit}${xunit === "s" ? " · 1/|Δt| " + (dt ? fmt(1 / Math.abs(dt)) + " Hz" : "—") : ""}`,
    );
  }
  readout.textContent = parts.join("  |  ") || "尚未放置游標";
}
function attachPlot(canvas, readout, series, unit, range, color, yOptions) {
  let drag = null,
    geometry;
  const paint = () => {
    geometry = chart(canvas, series.points, range, color, {
      ...yOptions,
      xunit: series.kind === "vector" ? series.frame?.axisUnit || "index" : "s",
      cursors: plotCursors.get(series.id),
      drag: drag ? [drag.time, drag.current] : null,
    });
    cursorText(readout, series, unit);
  };
  const position = (e) => e.clientX - canvas.getBoundingClientRect().left;
  function cursor(time) {
    const key = $("plot-tool").value;
    if (key === "zoom") return;
    const points = series.points.filter(
      (p) => p[0] >= range[0] && p[0] <= range[1],
    );
    const point = DAQAnalysis.nearest(points, time);
    if (point) {
      const c = plotCursors.get(series.id) || {};
      c[key] = point;
      plotCursors.set(series.id, c);
      paint();
    }
  }
  paint();
  canvas.onpointerdown = (e) => {
    if (e.button !== 0) return;
    freezeView();
    canvas.focus();
    if ($("plot-tool").value !== "zoom") {
      cursor(geometry.timeAt(position(e)));
      return;
    }
    const pixel = position(e);
    drag = {
      pixel,
      time: geometry.timeAt(pixel),
      current: geometry.timeAt(pixel),
    };
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointermove = (e) => {
    if (drag) {
      drag.current = geometry.timeAt(position(e));
      paint();
    }
  };
  canvas.onpointerup = (e) => {
    if (!drag) return;
    const start = drag;
    drag = null;
    if (canvas.hasPointerCapture(e.pointerId))
      canvas.releasePointerCapture(e.pointerId);
    if (
      Math.abs(position(e) - start.pixel) > 5 &&
      Math.abs(start.current - start.time) > 0
    ) {
      viewRanges.set(series.id, [
        Math.min(start.time, start.current),
        Math.max(start.time, start.current),
      ]);
      drawPlots();
    } else paint();
  };
  canvas.onpointercancel = () => {
    drag = null;
    paint();
  };
  canvas.onwheel = (e) => {
    e.preventDefault();
    freezeView();
    const center = geometry.timeAt(position(e)),
      factor = e.deltaY > 0 ? 1.35 : 1 / 1.35;
    const lower = series.points[0]?.[0] ?? range[0],
      upper = series.points.at(-1)?.[0] ?? range[1];
    const lo = Math.max(lower, center - (center - range[0]) * factor),
      hi = Math.min(upper, center + (range[1] - center) * factor);
    const step =
      series.points.length > 1
        ? (upper - lower) / (series.points.length - 1)
        : 1;
    if (hi - lo >= step * 2) {
      viewRanges.set(series.id, [lo, hi]);
      drawPlots();
    }
  };
  canvas.ondblclick = () => {
    viewRanges.delete(series.id);
    plotCursors.delete(series.id);
    drawPlots();
  };
  canvas.onkeydown = (e) => {
    if (
      !["ArrowLeft", "ArrowRight"].includes(e.key) ||
      $("plot-tool").value === "zoom"
    )
      return;
    e.preventDefault();
    freezeView();
    const points = series.points.filter(
      (p) => p[0] >= range[0] && p[0] <= range[1] && Number.isFinite(p[1]),
    );
    if (!points.length) return;
    const key = $("plot-tool").value,
      current = plotCursors.get(series.id)?.[key];
    let i = current
      ? points.findIndex((p) => p[0] === current[0])
      : Math.floor(points.length / 2);
    i = Math.max(
      0,
      Math.min(points.length - 1, i + (e.key === "ArrowRight" ? 1 : -1)),
    );
    cursor(points[i][0]);
  };
}
function drawPlots() {
  if (!$("acquisition").classList.contains("active")) return;
  const box = $("plots");
  box.replaceChildren();
  box.classList.remove("empty");
  box.classList.toggle("plot-columns", $("plot-layout").value === "columns");
  let yOptions = {};
  if ($("y-mode").value === "fixed") {
    const ymin = Number($("y-min").value),
      ymax = Number($("y-max").value);
    if (
      !$("y-min").value.trim() ||
      !$("y-max").value.trim() ||
      !Number.isFinite(ymin) ||
      !Number.isFinite(ymax) ||
      ymin >= ymax
    ) {
      $("view-status").textContent =
        "縱軸設定無效：請輸入有限數值，且 Y 最小必須小於 Y 最大。";
      drawSpectrum();
      return;
    }
    yOptions = { ymin, ymax };
  }
  $("view-status").textContent = paused
    ? "畫面已凍結；擷取與錄製仍持續。"
    : "即時畫面";
  displaySeries().forEach((original, i) => {
    let s =
      original.kind === "vector"
        ? {
            ...original,
            points: original.frame
              ? original.frame.axis.map((x, i) => [x, original.frame.values[i]])
              : [],
          }
        : original;
    const wrap = el("div", undefined, "plot"),
      label = el("div", undefined, "plot-label"),
      canvas = el("canvas"),
      readout = el("p", undefined, "cursor-readout");
    const signal = state.signals.find((x) => x.id === s.id),
      unit = signal?.unit || "";
    label.append(
      el("strong", (signal?.name || s.id) + (unit ? " / " + unit : "")),
      el(
        "span",
        `${s.count.toLocaleString()} ${s.kind === "vector" ? "frames" : "samples"}`,
      ),
    );
    canvas.className = "wave-canvas";
    canvas.tabIndex = 0;
    canvas.dataset.signal = s.id;
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      (signal?.name || s.id) + " 波形，使用工具列選擇縮放或游標",
    );
    readout.setAttribute("role", "status");
    wrap.append(label, canvas, readout);
    box.append(wrap);
    const range =
      s.kind === "vector"
        ? viewRanges.get(s.id) ||
          (s.points.length ? [s.points[0][0], s.points.at(-1)[0] || 1] : null)
        : plotRange(s);
    if (
      s.kind !== "vector" &&
      range &&
      s.rawPoints?.length &&
      range[0] >= s.rawPoints[0][0]
    )
      s = { ...s, points: s.rawPoints };
    if (s.error) {
      readout.textContent = "讀取失敗：" + s.error;
      readout.classList.add("plot-error");
      return;
    }
    if (
      range &&
      $("show-cursors").checked &&
      (!paused || !plotCursors.has(s.id))
    ) {
      const lo = Math.max(range[0], s.points[0]?.[0] ?? range[0]),
        hi = Math.min(range[1], s.points.at(-1)?.[0] ?? range[1]);
      const a = DAQAnalysis.nearest(s.points, lo + (hi - lo) / 3),
        b = DAQAnalysis.nearest(s.points, lo + ((hi - lo) * 2) / 3);
      if (a && b) plotCursors.set(s.id, { a, b });
    }
    if (range)
      attachPlot(
        canvas,
        readout,
        s,
        unit,
        range,
        colors[i % colors.length],
        yOptions,
      );
    else readout.textContent = "等待訊號資料…";
  });
  if (!box.childNodes.length) {
    box.classList.add("empty");
    box.textContent = "選擇訊號並開始擷取以顯示波形。";
  }
  drawSpectrum();
}
function drawSpectrum() {
  const selector = $("spectrum-signal"),
    series = displaySeries().filter(
      (s) => s.kind !== "vector" && s.kind !== "time",
    ),
    previous = selector.value;
  const keys = series.map((s) => s.id).join("\n");
  if (selector.dataset.keys !== keys) {
    selector.replaceChildren();
    for (const s of series) {
      const signal = state.signals.find((x) => x.id === s.id),
        o = el("option", signal?.name || s.id);
      o.value = s.id;
      selector.append(o);
    }
    if (series.some((s) => s.id === previous)) selector.value = previous;
    selector.dataset.keys = keys;
  }
  const s = series.find((s) => s.id === selector.value),
    canvas = $("spectrum-canvas"),
    status = $("spectrum-status");
  if (!s) {
    canvas.hidden = true;
    status.textContent = displaySeries().length
      ? "本機 FFT 請選擇純量數值；TIME 與已計算的向量不重複做 FFT。"
      : "開始擷取後顯示頻譜。";
    return;
  }
  const result = DAQAnalysis.spectrum(
    s.rawPoints || s.points,
    Number($("fft-size").value),
    $("fft-window").value,
    $("fft-dc").checked,
  );
  if (result.error) {
    canvas.hidden = true;
    status.textContent = result.error;
    delete status.dataset.peak;
    return;
  }
  const unit = state.signals.find((x) => x.id === s.id)?.unit || "unit",
    db = $("fft-scale").value === "db";
  const points = db
    ? result.bins.map(([f, a]) => [f, 20 * Math.log10(Math.max(a, 1e-12))])
    : result.bins;
  canvas.hidden = false;
  chart(canvas, points, [0, result.sampleRate / 2], "#8054aa", {
    xunit: "Hz",
    height: 260,
    ...(db
      ? {}
      : {
          ymin: 0,
          ymax: Math.max(...result.bins.map((p) => p[1])) * 1.12 || 1,
        }),
  });
  status.dataset.peak = String(result.peakFrequency ?? "");
  status.dataset.sampleRate = String(result.sampleRate);
  status.textContent = `Fs ${fmt(result.sampleRate)} Hz · N ${result.size} · Δf ${fmt(result.resolution)} Hz · 峰值 ${result.peakFrequency === null ? "—" : fmt(result.peakFrequency) + " Hz"} / ${fmt(result.peakAmplitude)} ${unit}（峰值，非 RMS） · ${db ? "顯示 dB re 1 " + unit : "線性振幅 / " + unit}`;
}
$("pause-plot").onclick = () => {
  if (paused) resumeView();
  else {
    freezeView();
    drawPlots();
  }
};
for (const id of ["plot-layout", "time-window", "y-mode", "y-min", "y-max"])
  $(id).onchange = () => {
    if (id === "time-window") viewRanges.clear();
    drawPlots();
  };
for (const id of [
  "spectrum-signal",
  "fft-size",
  "fft-window",
  "fft-scale",
  "fft-dc",
])
  $(id).onchange = drawSpectrum;
$("reset-view").onclick = () => {
  viewRanges.clear();
  plotCursors.clear();
  $("show-cursors").checked = false;
  drawPlots();
};
$("show-cursors").onchange = () => {
  if ($("show-cursors").checked) freezeView();
  else plotCursors.clear();
  drawPlots();
};
$("plot-tool").onchange = () => {
  if ($("plot-tool").value !== "zoom") {
    $("show-cursors").checked = true;
    freezeView();
    drawPlots();
  }
};
window.addEventListener("resize", drawPlots);

async function poll() {
  try {
    const response = await fetch("/api/live");
    if (!response.ok) throw Error("無法讀取擷取狀態");
    live = await response.json();
    renderLive();
    if (
      !busy &&
      Date.now() - lastChainRefresh > 1000 &&
      ($("processing").classList.contains("active") || !live.running)
    ) {
      lastChainRefresh = Date.now();
      const fresh = await api("state");
      const signature = (s) =>
        s.signals.map((v) => v.id + ":" + v.kind + ":" + v.readable).join("|");
      const changed = signature(fresh) !== signature(state);
      state = fresh;
      if (changed) renderSignals();
      if ($("processing").classList.contains("active")) renderChain();
    }
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
