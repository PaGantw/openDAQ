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
        revision++; status(`共 ${objects.length} 個可讀物件，已選取 ${chosen.size} 項。`);
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
      objects = result.items; chosen.clear(); values.clear(); revision++; render();
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
      render();
      status(`本輪 ${result.items.filter(x => x.status === "ok").length} / ${result.items.length} 項成功。失敗項目不保留舊值。`);
    } catch (error) {
      if (current === revision) {
        for (const id of ids) values.set(id, {status: "error", error: error.message});
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
  $("od-url").oninput = () => { revision++; values.clear(); render(); };
  $("od-clear").onclick = () => { revision++; chosen.clear(); values.clear(); $("od-auto").checked = false; render(); status("已清除選取。"); };
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
  async function pollOD() {
    if ($("od-auto").checked && chosen.size && document.visibilityState === "visible") await read();
    setTimeout(pollOD, 2000);
  }
  pollOD();
})();
