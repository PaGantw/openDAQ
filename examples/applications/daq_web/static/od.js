"use strict";
(() => {
  let objects = [], chosen = new Set(), values = new Map(), reading = false, revision = 0;
  const status = (message) => $("od-status").textContent = message;
  function render() {
    const query = $("od-search").value.toLowerCase().trim(), box = $("od-table");
    const filtered = objects.filter(o => `${o.name} 0x${o.index.toString(16)} ${o.subindex} ${o.type} ${o.access}`.toLowerCase().includes(query));
    box.replaceChildren();
    const table = el("table"), header = el("tr"), body = el("tbody"), thead = el("thead");
    for (const title of ["選取", "名稱", "索引:子索引", "型別／存取", "數值", "狀態／讀取時間"]) header.append(el("th", title));
    thead.append(header); table.append(thead, body);
    for (const o of filtered) {
      const row = el("tr"), cell = el("td"), check = el("input"), result = values.get(o.id);
      check.type = "checkbox"; check.checked = chosen.has(o.id);
      check.setAttribute("aria-label", `${o.name} 0x${o.index.toString(16)}:${o.subindex}`);
      check.onchange = () => {
        if (check.checked && chosen.size >= 16) { check.checked = false; status("每次最多選取 16 項。"); return; }
        if (check.checked) chosen.add(o.id); else chosen.delete(o.id);
        revision++; selectedSettings(); drawTrends(); status(`共 ${objects.length} 個可讀物件，已選取 ${chosen.size} 項。`);
      };
      cell.append(check); row.append(cell);
      const value = result?.status === "ok" ? JSON.stringify(result.value) : "—";
      const state = !result ? "尚未讀取" : result.status === "ok" ? `成功 · ${result.observedAt}` : `讀取失敗 · ${result.error}`;
      for (const text of [o.name, `0x${o.index.toString(16).toUpperCase()}:${o.subindex}`, `${o.type} / ${o.access}`, value, state]) row.append(el("td", text));
      body.append(row);
    }
    box.append(table);
  }
  async function load(csv) {
    try {
      const result = await api("od_catalog", csv === undefined ? {} : {csv});
      objects = result.items; chosen.clear(); values.clear(); revision++; clearHistory(); render();
      if (restored) { const data = restored; restored = null; applyPreset(data); } else selectedSettings();
      status(`已載入 ${objects.length} 個可讀物件，請選取需要的數值。`);
    } catch (error) { status("匯入失敗：" + error.message); }
  }
  async function read() {
    if (reading) return;
    if (!chosen.size) { status("請先選取 1–16 個 OD 物件。"); return; }
    reading = true;
    const current = revision, ids = [...chosen];
    status(`正在讀取 ${ids.length} 項…`);
    try {
      const result = await api("od_read", {url: $("od-url").value.trim(), ids});
      if (current !== revision) return;
      for (const item of result.items) values.set(item.id, item);
      appendHistory(result.items);
      render();
      status(`本輪 ${result.items.filter(x => x.status === "ok").length} / ${result.items.length} 項成功。失敗項目不保留舊值。`);
    } catch (error) {
      if (current === revision) {
        const failures = ids.map(id => ({id, status: "error", value: null, error: error.message}));
        for (const item of failures) values.set(item.id, item);
        appendHistory(failures);
        render(); status("讀取失敗：" + error.message);
      }
    } finally { reading = false; }
  }
  $("od-load").onclick = () => load();
  $("od-file").onchange = async () => {
    const file = $("od-file").files[0];
    if (file) {
      if (file.size > 1024 * 1024) { status("CSV 不可超過 1 MiB。"); return; }
      await load(await file.text());
    }
  };
  $("od-search").oninput = render;
  $("od-read").onclick = read;
  $("od-url").oninput = () => { revision++; values.clear(); clearHistory(); render(); savePreset(); };
  $("od-clear").onclick = () => { revision++; chosen.clear(); values.clear(); $("od-auto").checked = false; clearHistory(); render(); selectedSettings(); status("已清除選取。"); };
  $("od-export").onclick = () => {
    const quote = (v) => {
      let text = String(v ?? "");
      if (/^[=+@\-\t\r\n]/.test(text)) text = "'" + text;
      return '"' + text.replaceAll('"', '""') + '"';
    };
    const rows = [["index", "subindex", "name", "type", "value", "status", "observed_at_utc", "error"]];
    for (const o of objects.filter(x => chosen.has(x.id))) {
      const r = values.get(o.id);
      rows.push([`0x${o.index.toString(16)}`, o.subindex, o.name, o.type, r?.status === "ok" ? JSON.stringify(r.value) : "", r?.status || "not_read", r?.observedAt || "", r?.error || ""]);
    }
    const url = URL.createObjectURL(new Blob(["\uFEFF" + rows.map(row => row.map(quote).join(",")).join("\r\n")], {type:"text/csv;charset=utf-8"}));
    const link = el("a"); link.href = url; link.download = "digibox-od-values.csv"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const histories = new Map(), labels = new Map();
  let startTime = null, restored = null;
  const storageKey = 'digibox-od-preset-v1';
  const interval = () => Math.max(0.5, Math.min(60, Number($("od-interval").value) || 2));
  function preset() {
    return {version: 1, url: $("od-url").value.trim(), interval: interval(), ids: [...chosen], labels: Object.fromEntries(labels)};
  }
  function savePreset() { try { localStorage.setItem(storageKey, JSON.stringify(preset())); } catch (_) {} }
  function selectedSettings() {
    const box = $("od-selected"); box.replaceChildren();
    for (const o of objects.filter(x => chosen.has(x.id))) {
      const row = el("div", undefined, "button-row"), settings = labels.get(o.id) || {};
      row.append(el("span", `0x${o.index.toString(16)}:${o.subindex}`));
      for (const [key, title, fallback] of [["name", "顯示名稱", o.name], ["unit", "顯示單位", ""]]) {
        const label = el("label", title), input = el("input"); input.value = settings[key] ?? fallback;
        input.setAttribute("aria-label", `${o.id} ${title}`);
        input.onchange = () => { labels.set(o.id, {...(labels.get(o.id) || {}), [key]: input.value}); savePreset(); drawTrends(); };
        label.append(input); row.append(label);
      }
      box.append(row);
    }
    savePreset();
  }
  function clearHistory() { histories.clear(); startTime = null; drawTrends(); }
  function appendHistory(items) {
    if (startTime === null) {
      const timestamps = items.map(x => Date.parse(x.observedAt)).filter(Number.isFinite);
      startTime = timestamps.length ? Math.min(...timestamps) : Date.now();
    }
    for (const item of items) {
      const timestamp = item.observedAt || new Date().toISOString(), milliseconds = Date.parse(timestamp);
      if (!Number.isFinite(milliseconds)) continue;
      if (startTime === null) startTime = milliseconds;
      let value = item.value;
      if (Array.isArray(value) && value.length === 1) value = value[0];
      const type = objects.find(o => o.id === item.id)?.type;
      if ((type === "I64" || type === "U64") && typeof value === "string" && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))) value = Number(value);
      if (typeof value === 'boolean') value = Number(value);
      const numeric = item.status === 'ok' && typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
      const samples = histories.get(item.id) || [];
      samples.push({time: timestamp, seconds: (milliseconds - startTime) / 1000, value: numeric ? value : null,
        raw: item.value, status: item.status === 'ok' && !numeric ? 'not_numeric_scalar' : item.status, error: item.error || ''});
      if (samples.length > 3600) samples.splice(0, samples.length - 3600);
      histories.set(item.id, samples);
    }
    drawTrends();
  }
  function drawTrends() {
    const box = $("od-plots"); box.replaceChildren();
    const isActive = $("od-auto").checked;
    $("od-trend-status").textContent = `${isActive ? '持續讀取中' : '已停止／單次讀取'} · 已選 ${chosen.size} 項 · 輪次間隔 ${interval()} 秒`;
    let index = 0;
    for (const o of objects.filter(x => chosen.has(x.id))) {
      const settings = labels.get(o.id) || {}, samples = histories.get(o.id) || [], card = el("div");
      card.append(el("h4", `${settings.name || o.name}${settings.unit ? ' / ' + settings.unit : ''}`));
      const last = samples.at(-1);
      card.append(el("p", last ? `${last.status === 'ok' ? last.value : last.status === 'not_numeric_scalar' ? '此值無法作為數值曲線' : '讀取失敗：' + last.error} · ${last.time}` : '等待讀取資料', 'muted'));
      const canvas = el("canvas"); canvas.className = "wave-canvas od-wave-canvas"; canvas.dataset.count = String(samples.length); canvas.setAttribute("aria-label", (settings.name || o.name) + ' OD 趨勢');
      card.append(canvas); box.append(card);
      const points = samples.map(s => [s.seconds, s.value]), end = points.at(-1)?.[0] || 0;
      const span = $("od-window").value;
      const range = span === 'all' ? [points[0]?.[0] || 0, Math.max(end, (points[0]?.[0] || 0) + 1)] : [Math.max(0, end - Number(span)), Math.max(Number(span), end)];
      if (canvas.clientWidth) chart(canvas, points, range, colors[index++ % colors.length], {xunit: 's', height: 210});
    }
  }
  function exportCSV(filename, rows) {
    const quote = v => {
      let text = String(v ?? '');
      if (typeof v === 'string' && /^[=+@\-\t\r\n]/.test(text)) text = "'" + text;
      return '"' + text.replaceAll('"', '""') + '"';
    };
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(r => r.map(quote).join(',')).join('\r\n')], {type:'text/csv;charset=utf-8'}));
    const a = el('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function applyPreset(data) {
    if (data.version !== 1 || typeof data.url !== 'string' || !Array.isArray(data.ids) || data.ids.length > 16 || !data.ids.every(id => typeof id === 'string' && objects.some(o => o.id === id)) || !Number.isFinite(data.interval) || data.interval < 0.5 || data.interval > 60) throw Error('參數設定格式或物件位址不符');
    chosen = new Set(data.ids); labels.clear();
    for (const id of chosen) {
      const settings = data.labels?.[id];
      if (settings && typeof (settings.name ?? '') === 'string' && typeof (settings.unit ?? '') === 'string') labels.set(id, {name: settings.name || objects.find(o => o.id === id).name, unit: settings.unit || ''});
    }
    $("od-url").value = data.url; $("od-interval").value = data.interval;
    $("od-auto").checked = false; revision++; values.clear(); clearHistory(); render(); selectedSettings(); drawTrends();
  }
  $("od-trend-start").onclick = async () => {
    if (!chosen.size) { status('請先選取要繪圖的 OD 參數。'); return; }
    $("od-auto").checked = true; savePreset(); showTab('acquisition'); drawTrends(); await read();
  };
  $("od-trend-stop").onclick = () => { $("od-auto").checked = false; revision++; drawTrends(); };
  $("od-chart-stop").onclick = $("od-trend-stop").onclick;
  $("od-auto").onchange = () => { drawTrends(); if ($("od-auto").checked) read(); };
  $("od-interval").onchange = () => { $("od-interval").value = interval(); savePreset(); drawTrends(); };
  $("od-window").onchange = drawTrends;
  $("od-history-clear").onclick = clearHistory;
  $("od-history-export").onclick = () => {
    const rows = [['id', 'name', 'unit', 'observed_at_utc', 'relative_seconds', 'numeric_value', 'raw_value', 'status', 'error']];
    for (const id of chosen) for (const s of histories.get(id) || []) {
      const o = objects.find(x => x.id === id), settings = labels.get(id) || {};
      rows.push([id, settings.name || o?.name || id, settings.unit || '', s.time, s.seconds, s.value, JSON.stringify(s.raw), s.status, s.error]);
    }
    exportCSV('digibox-od-trends.csv', rows);
  };
  $("od-preset-save").onclick = () => download('digibox-od-preset.json', JSON.stringify(preset(), null, 2));
  $("od-preset-file").onchange = async () => {
    try { const file = $("od-preset-file").files[0]; if (!file) return; if (file.size > 65536) throw Error('設定檔過大'); applyPreset(JSON.parse(await file.text())); status('參數設定已匯入，按開始 OD 趨勢進行讀取。'); }
    catch (error) { status('設定匯入失敗：' + error.message); }
  };
  window.addEventListener('resize', drawTrends);
  document.querySelectorAll('.nav').forEach(button => button.addEventListener('click', () => requestAnimationFrame(drawTrends)));
  try { restored = JSON.parse(localStorage.getItem(storageKey)); } catch (_) {}

  async function pollOD() {
    if ($("od-auto").checked && chosen.size && document.visibilityState === "visible") await read();
    setTimeout(pollOD, interval() * 1000);
  }
  async function initializeOD() {
    if (!token) { setTimeout(initializeOD, 100); return; }
    await load(); pollOD();
  }
  initializeOD();
})();
