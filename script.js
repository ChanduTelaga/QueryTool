/* ══════════════════════════════════════════════════════
   STORAGE ABSTRACTION
   Uses Claude's window.storage (persists per-user, works when this
   file is opened as a Claude Artifact) when available, and
   transparently falls back to localStorage (persists when this file
   is downloaded and opened directly in a browser). This is what
   keeps Client Names / Query Formats / FQDN suffixes / History
   surviving a close-and-reopen in BOTH environments.
══════════════════════════════════════════════════════ */
const _hasCloudStorage =
  typeof window !== "undefined" &&
  !!window.storage &&
  typeof window.storage.get === "function";
async function storageGet(key, fallback) {
  if (_hasCloudStorage) {
    try {
      const r = await window.storage.get(key, false);
      return r && r.value !== undefined ? JSON.parse(r.value) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
async function storageSet(key, value) {
  if (_hasCloudStorage) {
    try {
      await window.storage.set(key, JSON.stringify(value), false);
      return;
    } catch (e) {
      /* fall through to local */
    }
  }
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* storage unavailable — ignore */
  }
}
async function storageDelete(key) {
  if (_hasCloudStorage) {
    try {
      await window.storage.delete(key, false);
      return;
    } catch (e) {
      /* fall through */
    }
  }
  try {
    localStorage.removeItem(key);
  } catch (e) {}
}

/* THEME SYSTEM */
const THEMES = [
  { id: "terminal-green", label: "Terminal Green", dot: "#00ff88" },
  { id: "midnight-slate", label: "Midnight Slate", dot: "#58a6ff" },
  { id: "graphite-pro", label: "Graphite Pro", dot: "#0a84ff" },
  { id: "cobalt-light", label: "Cobalt Light", dot: "#0F5FDC" },
  { id: "warm-paper", label: "Warm Paper", dot: "#c2692a" },
];
let currentTheme = "terminal-green";
function buildThemeSelect() {
  const sel = document.getElementById("themeSelect");
  sel.innerHTML = THEMES.map(
    (t) =>
      `<option value="${t.id}" ${t.id === currentTheme ? "selected" : ""}>${t.label}</option>`,
  ).join("");
}
function updateDotPreview(id) {
  const t = THEMES.find((x) => x.id === id),
    dot = document.getElementById("themeDotPreview");
  if (t && dot) {
    dot.style.background = t.dot;
    dot.style.boxShadow = `0 0 5px ${t.dot}55`;
  }
}
function applyTheme(id) {
  currentTheme = id;
  document.documentElement.setAttribute("data-theme", id);
  storageSet("qt_theme", id);
  updateDotPreview(id);
  const sel = document.getElementById("themeSelect");
  if (sel) sel.value = id;
}

/* ══════════════════════════════════════════════════════
   APP INIT — loads all persisted data BEFORE first render so
   Client Names / FQDN suffixes / Query Formats / History / Theme
   / Draft are correctly restored on every open.
══════════════════════════════════════════════════════ */
function showAppLoading(show) {
  const ov = document.getElementById("appLoadingOverlay");
  if (!ov) return;
  if (show) {
    ov.style.display = "flex";
    ov.style.opacity = "1";
  } else {
    ov.style.opacity = "0";
    setTimeout(() => {
      ov.style.display = "none";
    }, 320);
  }
}
async function initApp() {
  showAppLoading(true);
  currentTheme = await storageGet("qt_theme", "terminal-green");
  clients = await storageGet("qt_clients", clients);
  if (!clients.length) {
    const backups = await storageGet("qt_clients_backup", []);
    if (backups.length && backups[0].data && backups[0].data.length) {
      clients = backups[0].data;
      await storageSet("qt_clients", clients);
    }
  }
  fqdnSuffixes = await storageGet("qt_fqdn", fqdnSuffixes);
  const loadedFormats = await storageGet("qt_formats", queryFormats);
  // Keep any genuinely custom formats (ids outside the known built-in id range across every
  // version of this app), then always put the current 2 default formats in front. This makes
  // sure everyone converges on exactly the current defaults even if their browser storage still
  // has an older built-in set saved, while never touching formats a user added themselves.
  const customFormats = loadedFormats.filter(
    (f) => !LEGACY_BUILTIN_IDS.includes(f.id),
  );
  queryFormats = [...DEFAULT_FORMATS, ...customFormats];
  saveFormats();
  queryHistory = await storageGet("qt_history", queryHistory);
  const draft = await storageGet("qt_draft", "");

  buildThemeSelect();
  applyTheme(currentTheme);
  renderClients();
  renderFqdnRegistry();
  renderFormatList();
  document
    .getElementById("g-format-select")
    ?.addEventListener("change", updateFormatPreview);
  document
    .getElementById("bulk-format-select")
    ?.addEventListener("change", updateBulkFormatHint);
  updateBulkFormatHint();
  document.getElementById("v-format-select")?.addEventListener("change", () => {
    if (document.getElementById("v-input").value.trim())
      runValidation("standalone");
  });
  document
    .getElementById("adv-format-select")
    ?.addEventListener("change", () => {
      if (document.getElementById("adv-scripts").value.trim())
        runAdvancedValidation();
    });
  if (draft) document.getElementById("g-input").value = draft;
  updateLivePreview();
  syncBulkClientDropdown();
  syncAdvClientDropdown();
  setupBulkDrop();
  updateFqdnHint();
  setupPasteCleanup();
  showAppLoading(false);
}
document.addEventListener("DOMContentLoaded", initApp);

/* UTILS */
function esc(s) {
  return String(s || "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
/* Query-syntax safety: a literal " inside a Client Name or Description would terminate the
   quoted string early in the generated query, silently producing a broken/invalid suppression
   rule. Rather than guess at an escaping convention the downstream query engine may not support,
   we reject these values at the point of entry/use and ask the person to remove the character. */
function hasUnsafeQuote(s) {
  return typeof s === "string" && s.includes('"');
}
/* CSV/Formula-Injection safety (CWE-1236): a cell value starting with =, +, - or @ can be
   interpreted as a formula by Excel/Sheets when the exported file is opened. Prefixing with a
   single leading apostrophe neutralizes this while keeping the value readable as plain text. */
function csvSafeValue(v) {
  const s = String(v == null ? "" : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
let _tt;
function showToast(msg, type = "", dur = 2400) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast show" + (type ? " toast-" + type : "");
  clearTimeout(_tt);
  _tt = setTimeout(() => {
    t.classList.remove("show");
  }, dur);
}
function chunkArr(arr, size) {
  const o = [];
  for (let i = 0; i < arr.length; i += size) o.push(arr.slice(i, i + size));
  return o;
}
function flagInvalid(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.classList.remove("field-invalid");
  void el.offsetWidth; // restart animation
  el.classList.add("field-invalid");
  el.addEventListener(
    "animationend",
    () => el.classList.remove("field-invalid"),
    { once: true },
  );
  el.focus?.();
}

/* NAVIGATION */
let advValActive = false;
function switchPage(id) {
  document.querySelectorAll(".page").forEach((p) => {
    p.classList.remove("active");
    p.style.display = ""; // clear any inline override (e.g. from advanced validator toggle) so CSS class rules take over
  });
  document.getElementById("page-" + id).classList.add("active");
  document
    .querySelectorAll(".nav-item")
    .forEach((n) =>
      n.classList.remove(
        "active",
        "active-purple",
        "active-warn",
        "active-cyan",
      ),
    );
  const nav = document.getElementById("nav-" + id);
  if (nav) {
    if (id === "clients") nav.classList.add("active-purple");
    else if (id === "val") nav.classList.add("active-warn");
    else if (id === "bulk") nav.classList.add("active-cyan");
    else nav.classList.add("active");
  }
  // Navigating to any sidebar item always exits advanced validator mode — advanced mode is reached/exited only via its own toggle
  if (advValActive) {
    advValActive = false;
    document.getElementById("adv-toggle").classList.remove("on");
    const tog2 = document.getElementById("adv-toggle-2");
    if (tog2) tog2.classList.remove("on");
  }
}

/* REGISTRY */
// Clients & FQDN — in-memory defaults; initApp() overwrites these from storage before first render
let clients = [
  "Ashland",
  "Akzonobel",
  "Burberry",
  "Cambrex",
  "ItalianaPetroli",
  "JDE",
  "OneyBank",
  "SIGMA",
  "SMS",
  "Taylor Wimpey",
  "IAC",
];
let fqdnSuffixes = [".corp.local.com", ".corp.local", ".internal"];
function saveClients() {
  storageSet("qt_clients", clients);
  // Auto-backup safety net — keeps last 5 snapshots, self-heals if primary key is ever wiped
  storageGet("qt_clients_backup", []).then((backups) => {
    try {
      backups.unshift({ ts: Date.now(), data: clients });
      storageSet("qt_clients_backup", backups.slice(0, 5));
    } catch (e) {
      /* backup is best-effort, never block primary save */
    }
  });
}

/* ── Query Format Templates ──
   Only 2 built-in formats now: a plain Source-only default, and a Source+Description
   variant. Both use the "=" operator for External id (not MATCHES). {description} uses
   MATCHES, per spec, and must never be silently switched to "=". */
const DEFAULT_FORMATS = [
  {
    id: "f1",
    name: "Default (Source Only)",
    template: '(`External id` = "{client}") AND (`Source` IN({sources}))',
  },
  {
    id: "f2",
    name: "Source + Description",
    template:
      '((`External id` = "{client}") AND (`Source` IN({sources}))) AND (`Description` MATCHES "{description}")',
  },
];
// Every id any built-in format has ever used across every version of this app. On load we strip
// any of these out of a user's saved data and replace with the current DEFAULT_FORMATS — this is
// how old MATCHES-based "Standard"/"Host Only"/etc. formats get cleaned up automatically without
// touching formats a user added themselves via "+ Add" (which get timestamp-based ids and are
// never in this list).
const LEGACY_BUILTIN_IDS = ["f1", "f2", "f3", "f4", "f5"];
let queryFormats = JSON.parse(JSON.stringify(DEFAULT_FORMATS));
function saveFormats() {
  storageSet("qt_formats", queryFormats);
}
function saveFqdnSuffixes() {
  storageSet("qt_fqdn", fqdnSuffixes);
}
function renderClients() {
  document.getElementById("clientGrid").innerHTML = clients.length
    ? clients
        .map(
          (c, i) =>
            `<div class="client-chip">${esc(c)}<div class="del" onclick="deleteClient(${i})" role="button" tabindex="0" aria-label="Remove client ${esc(c)}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();deleteClient(${i});}">&#10005;</div></div>`,
        )
        .join("")
    : '<span style="font-size:11px;color:var(--text3);font-style:italic">No clients yet.</span>';
  const sel = document.getElementById("g-client"),
    prev = sel.value;
  sel.innerHTML =
    '<option value="" disabled>&#8212; SELECT CLIENT &#8212;</option>' +
    clients
      .map(
        (c) =>
          `<option value="${esc(c)}" ${c === prev ? "selected" : ""}>${esc(c)}</option>`,
      )
      .join("");
  if (!clients.includes(prev)) sel.value = "";
  syncBulkClientDropdown();
  syncAdvClientDropdown();
}
function renderFqdnRegistry() {
  document.getElementById("fqdnGrid").innerHTML = fqdnSuffixes.length
    ? fqdnSuffixes
        .map(
          (s, i) =>
            `<div class="client-chip">${esc(s)}<div class="del" onclick="deleteFqdn(${i})" role="button" tabindex="0" aria-label="Remove suffix ${esc(s)}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();deleteFqdn(${i});}">&#10005;</div></div>`,
        )
        .join("")
    : '<span style="font-size:11px;color:var(--text3);font-style:italic">No suffixes yet.</span>';
  const sel = document.getElementById("g-fqdn-select"),
    cv = document.getElementById("g-fqdn-custom").value.trim(),
    pv = cv ? "" : sel.value;
  sel.innerHTML =
    '<option value="">&#8212; None &#8212;</option>' +
    fqdnSuffixes
      .map(
        (s) =>
          `<option value="${esc(s)}" ${s === pv ? "selected" : ""}>${esc(s)}</option>`,
      )
      .join("");
  if (!cv && !fqdnSuffixes.includes(pv)) sel.value = "";
}
function onFqdnSelectChange() {
  document.getElementById("g-fqdn-custom").value = "";
  updateLivePreview();
}
function onFqdnCustomInput() {
  document.getElementById("g-fqdn-select").value = "";
  updateLivePreview();
}
function getFqdnSuffix() {
  const c = document.getElementById("g-fqdn-custom").value.trim();
  if (c) return c.startsWith(".") ? c : "." + c;
  return document.getElementById("g-fqdn-select").value || "";
}
function addFqdn() {
  const inp = document.getElementById("fqdnInput");
  let v = inp.value.trim();
  if (!v) return;
  if (!v.startsWith(".")) v = "." + v;
  if (fqdnSuffixes.includes(v)) {
    showToast("Already exists");
    return;
  }
  fqdnSuffixes.push(v);
  saveFqdnSuffixes();
  renderFqdnRegistry();
  inp.value = "";
  showToast(`"${v}" added`);
}
function deleteFqdn(i) {
  const s = fqdnSuffixes[i];
  fqdnSuffixes.splice(i, 1);
  saveFqdnSuffixes();
  renderFqdnRegistry();
  showToast(`"${s}" removed`);
  updateLivePreview();
}
function addClient() {
  const inp = document.getElementById("clientInput"),
    name = inp.value.trim();
  if (!name) return;
  if (hasUnsafeQuote(name)) {
    showToast('Client name cannot contain a " character', "warn");
    flagInvalid("clientInput");
    return;
  }
  if (clients.includes(name)) {
    showToast("Already exists");
    return;
  }
  clients.push(name);
  saveClients();
  renderClients();
  inp.value = "";
  showToast(`"${name}" added`);
}
function deleteClient(i) {
  const n = clients[i];
  clients.splice(i, 1);
  saveClients();
  renderClients();
  showToast(`"${n}" removed`);
}
function exportCSV(data, fname) {
  const b = new Blob([data.map(csvSafeValue).join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(b);
  a.download = fname;
  a.click();
}
function exportClients() {
  exportCSV(clients, "qt_clients.csv");
}
function exportFqdn() {
  exportCSV(fqdnSuffixes, "qt_fqdn.csv");
}
function handleImport(e, arr, sf, rf, px = "") {
  const file = e.target.files[0];
  if (!file) return;
  const r = new FileReader();
  r.onload = (ev) => {
    const lines = ev.target.result
      .split(/[\r\n,]+/)
      .map((l) => l.trim())
      .filter(Boolean);
    let added = 0,
      skipped = 0;
    lines.forEach((l) => {
      let v = px && !l.startsWith(px) ? px + l : l;
      if (hasUnsafeQuote(v)) {
        skipped++;
        return;
      }
      if (!arr.includes(v)) {
        arr.push(v);
        added++;
      }
    });
    sf();
    rf();
    showToast(
      skipped
        ? `Imported ${added} entries (${skipped} skipped - contained ")`
        : `Imported ${added} entries`,
    );
    e.target.value = "";
    updateLivePreview();
  };
  r.readAsText(file);
}
function importClients(e) {
  handleImport(e, clients, saveClients, renderClients);
}
function backupClientsNow() {
  const payload = {
    exportedAt: new Date().toISOString(),
    clients,
    fqdnSuffixes,
    queryFormats,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `querytool_backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  showToast("Backup downloaded");
}
function restoreClientsFromFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const r = new FileReader();
  r.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if (Array.isArray(data.clients) && data.clients.length) {
        clients = data.clients.filter((c) => !hasUnsafeQuote(c));
        saveClients();
        renderClients();
      }
      if (Array.isArray(data.fqdnSuffixes) && data.fqdnSuffixes.length) {
        fqdnSuffixes = data.fqdnSuffixes.filter((s) => !hasUnsafeQuote(s));
        saveFqdnSuffixes();
        renderFqdnRegistry();
      }
      if (Array.isArray(data.queryFormats) && data.queryFormats.length) {
        const custom = data.queryFormats.filter(
          (f) => !LEGACY_BUILTIN_IDS.includes(f.id),
        );
        queryFormats = [...DEFAULT_FORMATS, ...custom];
        saveFormats();
        renderFormatList();
      }
      showToast("Restored from backup");
    } catch (err) {
      showToast("Invalid backup file");
    }
    e.target.value = "";
  };
  r.readAsText(file);
}
function importFqdn(e) {
  handleImport(e, fqdnSuffixes, saveFqdnSuffixes, renderFqdnRegistry, ".");
}
document.getElementById("clientInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addClient();
});
document.getElementById("fqdnInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addFqdn();
});
// NOTE: renderClients()/renderFqdnRegistry() are called from initApp() after storage loads —
// calling them here too would just show the in-memory defaults for an instant, which is fine,
// but initApp() is the source of truth for what's actually persisted.

/* HISTORY */
let queryHistory = [];
function persistHistory() {
  storageSet("qt_history", queryHistory);
}
function saveHistory(client, max, fqdn, input, count, extra) {
  queryHistory.unshift({
    date: new Date().toLocaleString(),
    client,
    max,
    fqdn,
    input,
    queriesGenerated: count,
    ...(extra || {}),
  });
  if (queryHistory.length > 15) queryHistory.pop();
  persistHistory();
}
function showHistory() {
  renderHistoryModal();
  document.getElementById("histModal").style.display = "grid";
}
function renderHistoryModal() {
  const mb = document.getElementById("histBody");
  if (!queryHistory.length) {
    mb.innerHTML = '<div class="modal-empty">NO SESSIONS FOUND</div>';
    return;
  }
  mb.innerHTML = queryHistory
    .map(
      (h, i) => `
    <div class="hist-card ${h.isBulk ? "bulk-entry" : ""}" onclick="loadHistory(${i})">
      <div class="hist-card-body">
        <div class="hist-meta"><span>${h.date}</span><span class="hist-queries">${h.queriesGenerated} queries${h.isBulk ? " &middot; BULK" : ""}</span></div>
        <div class="hist-details">${h.isBulk ? "&#9647;" : ""} ${h.client || "N/A"} | ${h.isBulk ? h.input : h.input.split("\n").filter((l) => l.trim()).length + " hosts"}</div>
      </div>
      <button class="hist-delete" onclick="deleteHistory(event,${i})" title="Delete">&#10005;</button>
    </div>`,
    )
    .join("");
}
function deleteHistory(e, i) {
  e.stopPropagation();
  queryHistory.splice(i, 1);
  persistHistory();
  renderHistoryModal();
  showToast("Entry deleted");
}
function clearAllHistory() {
  if (!queryHistory.length) {
    showToast("Nothing to clear");
    return;
  }
  queryHistory = [];
  persistHistory();
  renderHistoryModal();
  showToast("History cleared");
}
function closeHistory() {
  document.getElementById("histModal").style.display = "none";
}
function onModalOverlayClick(e) {
  if (e.target === e.currentTarget) closeHistory();
}
function loadHistory(i) {
  const h = queryHistory[i];
  if (h.isBulk) {
    switchPage("bulk");
    closeHistory();
    showToast("Bulk session &#8212; re-upload file to regenerate");
    return;
  }
  if (h.client) document.getElementById("g-client").value = h.client;
  document.getElementById("g-max-slots").value = h.max;
  document.getElementById("g-input").value = h.input;
  if (h.fqdn) {
    if (fqdnSuffixes.includes(h.fqdn)) {
      document.getElementById("g-fqdn-select").value = h.fqdn;
      document.getElementById("g-fqdn-custom").value = "";
    } else {
      document.getElementById("g-fqdn-custom").value = h.fqdn;
      document.getElementById("g-fqdn-select").value = "";
    }
  }
  closeHistory();
  updateLivePreview();
  showToast("Session loaded");
}

/* LIVE METER */
function updateLivePreview() {
  const raw = document.getElementById("g-input").value;
  storageSet("qt_draft", raw);
  const max = parseInt(document.getElementById("g-max-slots").value) || 10,
    suffix = getFqdnSuffix();
  const ipRe = /^(\d{1,3}\.){3}\d{1,3}$/,
    dateRe = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
  let hostnames = [],
    ips = [];
  for (const line of raw.split("\n")) {
    const v = line.trim();
    if (!v || dateRe.test(v)) continue;
    (ipRe.test(v) ? ips : hostnames).push(v);
  }
  const seen = new Set(),
    uniqueHosts = [];
  for (const h of hostnames) {
    const k = h.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      uniqueHosts.push(h);
    }
  }
  const uniqueIps = [...new Set(ips)];
  let slots = uniqueIps.length,
    tokHtml = uniqueIps
      .slice(0, 30)
      .map((ip) => `<span class="tok tok-ip">${esc(ip)}</span>`)
      .join(""),
    cnt = uniqueIps.length;
  for (const h of uniqueHosts) {
    const isMixed = h !== h.toUpperCase() && h !== h.toLowerCase(),
      isFqdn = suffix && h.toLowerCase().endsWith(suffix.toLowerCase());
    slots += isFqdn ? (isMixed ? 6 : 4) : isMixed ? 3 : 2;
    const cls = isFqdn ? "tok-fqdn" : isMixed ? "tok-mixed" : "tok-plain";
    if (cnt < 30) tokHtml += `<span class="tok ${cls}">${esc(h)}</span>`;
    cnt++;
  }
  if (cnt > 30)
    tokHtml += `<span class="tok" style="background:var(--surface3)">+${cnt - 30} more</span>`;
  const est = slots > 0 ? Math.ceil(slots / max) : 0;
  document.getElementById("lp-queries").textContent = est;
  document.getElementById("lp-slots").textContent = slots;
  document.getElementById("lp-tokens").innerHTML =
    tokHtml ||
    '<span style="color:var(--text4);font-size:10px">Awaiting input...</span>';
}
["g-input", "g-max-slots"].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("input", updateLivePreview);
});

/* PASTE CLEANUP: trim/dedupe/drop-blank-lines on paste into the Script Tool input */
function cleanHostInput(raw) {
  const seen = new Set(),
    out = [];
  for (const rawLine of raw.split(/\r\n|\r|\n/)) {
    const v = rawLine.trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out.join("\n");
}
function setupPasteCleanup() {
  const el = document.getElementById("g-input");
  if (!el) return;
  el.addEventListener("paste", () => {
    setTimeout(() => {
      const before = el.value;
      const cleaned = cleanHostInput(before);
      if (cleaned !== before) {
        el.value = cleaned;
        showToast("Pasted list cleaned & deduplicated", "success");
      }
      updateLivePreview();
    }, 0);
  });
}

/* GENERATOR */
const FIELD = "External id";
let gTabQueries = { combined: [], upper: [], lower: [], ips: [] },
  gActiveTab = "combined";
function buildQuery(client, items) {
  const fid = document.getElementById("g-format-select")?.value || "f1";
  const desc = document.getElementById("g-description")?.value.trim() || "";
  return renderFormatQuery(fid, client, items, desc);
}
function generate() {
  const client = document.getElementById("g-client").value;
  if (!client) {
    showToast("Select a client first", "warn");
    flagInvalid("g-client");
    return;
  }
  const fid = document.getElementById("g-format-select")?.value || "f1";
  const descVal = document.getElementById("g-description")?.value.trim() || "";
  if (formatSupportsDescription(fid) && !descVal) {
    showToast("Selected format requires a Description value", "warn");
    flagInvalid("g-description");
    return;
  }
  if (hasUnsafeQuote(client)) {
    showToast(
      'Client name contains a " character and would break the query - please fix it in the Client Registry',
      "error",
    );
    flagInvalid("g-client");
    return;
  }
  if (hasUnsafeQuote(descVal)) {
    showToast(
      'Description cannot contain a " character - remove it and try again',
      "warn",
    );
    flagInvalid("g-description");
    return;
  }
  const MAX = parseInt(document.getElementById("g-max-slots").value) || 10,
    raw = document.getElementById("g-input").value;
  const ipRe = /^(\d{1,3}\.){3}\d{1,3}$/,
    dateRe = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
  const hostnames = [],
    ips = [];
  for (const line of raw.split("\n")) {
    const v = line.trim();
    if (!v || dateRe.test(v)) continue;
    (ipRe.test(v) ? ips : hostnames).push(v);
  }
  if (!hostnames.length && !ips.length) {
    document.getElementById("g-outputCard").style.display = "none";
    showToast("No valid input", "warn");
    flagInvalid("g-input");
    return;
  }
  const suffix = getFqdnSuffix(),
    seen = new Set(),
    uniqueHosts = [];
  for (const h of hostnames) {
    const k = h.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      uniqueHosts.push(h);
    }
  }
  const uniqueIps = [...new Set(ips)],
    upperItems = [],
    lowerItems = [],
    asIsItems = [];
  let fqdnCount = 0,
    plainCount = 0;
  for (const h of uniqueHosts) {
    const isMixed = h !== h.toUpperCase() && h !== h.toLowerCase(),
      isFqdn = suffix && h.toLowerCase().endsWith(suffix.toLowerCase());
    if (isFqdn) {
      const short = h.slice(0, h.length - suffix.length);
      upperItems.push(h.toUpperCase(), short.toUpperCase());
      lowerItems.push(h.toLowerCase(), short.toLowerCase());
      if (isMixed) asIsItems.push(h, short);
      fqdnCount++;
    } else {
      upperItems.push(h.toUpperCase());
      lowerItems.push(h.toLowerCase());
      if (isMixed) asIsItems.push(h);
      plainCount++;
    }
  }
  const allItems = [...upperItems, ...lowerItems, ...asIsItems, ...uniqueIps];
  gTabQueries = {
    combined: chunkArr(allItems, MAX).map((c) => buildQuery(client, c)),
    upper: chunkArr(upperItems, MAX).map((c) => buildQuery(client, c)),
    lower: chunkArr(lowerItems, MAX).map((c) => buildQuery(client, c)),
    ips: chunkArr(uniqueIps, MAX).map((c) => buildQuery(client, c)),
  };
  saveHistory(client, MAX, suffix, raw, gTabQueries.combined.length);
  document.getElementById("g-statsBar").innerHTML = [
    { v: plainCount, l: "Plain" },
    { v: fqdnCount, l: "FQDNs" },
    { v: uniqueIps.length, l: "IPs" },
    { v: asIsItems.length, l: "Mixed", hide: !asIsItems.length },
    { v: allItems.length, l: "Slots" },
    { v: gTabQueries.combined.length, l: "Queries" },
  ]
    .filter((x) => !x.hide)
    .map(
      (x) =>
        `<div class="stat-item"><span class="stat-val">${x.v}</span><span class="stat-label">${x.l}</span></div>`,
    )
    .join("");
  renderGenTab(
    "combined",
    gTabQueries.combined,
    "qbadge-combined",
    "Combined",
    MAX,
  );
  renderGenTab("upper", gTabQueries.upper, "qbadge-upper", "Upper", MAX);
  renderGenTab("lower", gTabQueries.lower, "qbadge-lower", "Lower", MAX);
  renderGenTab("ips", gTabQueries.ips, "qbadge-ips", "IPs", MAX);
  document.getElementById("g-outputCard").style.display = "block";
  document.getElementById("inline-val-anchor").innerHTML = "";
  switchTab("combined");
  showToast(
    `${gTabQueries.combined.length} quer${gTabQueries.combined.length === 1 ? "y" : "ies"} generated`,
    "success",
  );
}
function renderGenTab(tabId, queries, badgeClass, label, max) {
  const el = document.getElementById("gpanel-" + tabId);
  if (!queries.length) {
    el.innerHTML =
      '<div style="color:var(--text3);padding:14px;font:500 11px var(--mono)">No entries.</div>';
    return;
  }
  el.innerHTML = queries
    .map((q, i) => {
      const c = (q.match(/","/g) || []).length + 1;
      return `<div class="query-block"><div class="query-meta"><span class="qbadge ${badgeClass}">${label} ${i + 1}</span><span>${c}/${max} slots</span></div><textarea class="query-edit" data-tab="${tabId}" data-idx="${i}" spellcheck="false" oninput="onGenQueryEdit(this)">${esc(q)}</textarea></div>`;
    })
    .join("");
  el.querySelectorAll("textarea.query-edit").forEach(autoResizeTA);
}
function autoResizeTA(ta) {
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + 2 + "px";
}
function onGenQueryEdit(ta) {
  const tab = ta.dataset.tab,
    idx = parseInt(ta.dataset.idx, 10);
  if (gTabQueries[tab]) gTabQueries[tab][idx] = ta.value;
  ta.classList.add("edited");
  autoResizeTA(ta);
}
function switchTab(tab) {
  gActiveTab = tab;
  document
    .querySelectorAll("#g-tabBar .tab-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document
    .querySelectorAll('[id^="gpanel-"]')
    .forEach((p) => p.classList.toggle("active", p.id === "gpanel-" + tab));
  const btn = document.getElementById("g-copyBtn");
  btn.textContent = "Copy Tab";
  btn.classList.remove("copied");
}
function copyActiveTab() {
  const q = gTabQueries[gActiveTab] || [];
  if (!q.length) return;
  navigator.clipboard.writeText(q.join("\n\n"));
  const btn = document.getElementById("g-copyBtn");
  btn.textContent = "Copied!";
  btn.classList.add("copied");
  setTimeout(() => {
    btn.textContent = "Copy Tab";
    btn.classList.remove("copied");
  }, 2200);
}
function validateGenerated() {
  if (!gTabQueries.combined.length) {
    showToast("No scripts generated", "warn");
    return;
  }
  const fid = document.getElementById("g-format-select")?.value;
  runValidation("inline", gTabQueries.combined.join("\n"), fid);
  setTimeout(
    () =>
      document
        .getElementById("inline-val-anchor")
        .scrollIntoView({ behavior: "smooth", block: "start" }),
    80,
  );
}
function clearGenerator() {
  document.getElementById("g-input").value = "";
  storageDelete("qt_draft");
  updateLivePreview();
  document.getElementById("g-outputCard").style.display = "none";
  document.getElementById("inline-val-anchor").innerHTML = "";
}

/* VALIDATOR ENGINE */
/* Dynamic format matcher — builds a matcher (regex + group roles) from any
   Query Format Template so the Validator, Advanced Validator and Bulk
   Creation modules can all validate/parse against whichever format the
   user has selected, not just a single hardcoded format. */
function escapeRegexLit(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function buildFormatMatcher(template) {
  const tokenRe = /\{(client|sources|field|description)\}/g;
  let lastIndex = 0,
    pattern = "",
    groupKinds = [],
    m;
  while ((m = tokenRe.exec(template)) !== null) {
    pattern += escapeRegexLit(template.slice(lastIndex, m.index));
    const tok = m[1];
    if (tok === "client") {
      pattern += '([^"]*)';
      groupKinds.push("client");
    } else if (tok === "sources") {
      pattern += '("[^"]*"(?:\\s*,\\s*"[^"]*")*)';
      groupKinds.push("sources");
    } else if (tok === "description") {
      pattern += '([^"]*)';
      groupKinds.push("description");
    } else if (tok === "field") {
      pattern += escapeRegexLit(FIELD);
    }
    lastIndex = tokenRe.lastIndex;
  }
  pattern += escapeRegexLit(template.slice(lastIndex));
  let regex = null;
  try {
    regex = new RegExp("^" + pattern + "$");
  } catch (e) {
    regex = null;
  }
  return {
    regex,
    groupKinds,
    hasClient: groupKinds.includes("client"),
    hasSources: groupKinds.includes("sources"),
    hasDescription: groupKinds.includes("description"),
  };
}
function extractFromMatch(match, groupKinds) {
  let client = null,
    sourcesRaw = null,
    description = null;
  groupKinds.forEach((kind, i) => {
    const val = match[i + 1];
    if (kind === "client" && client === null) client = val;
    if (kind === "sources" && sourcesRaw === null) sourcesRaw = val;
    if (kind === "description" && description === null) description = val;
  });
  return { client, sourcesRaw, description };
}
function getFormatById(id) {
  return (
    queryFormats.find((f) => f.id === id) ||
    queryFormats[0] ||
    DEFAULT_FORMATS[0]
  );
}
function formatSupportsDescription(id) {
  const f = getFormatById(id);
  return !!f && f.template.includes("{description}");
}
function renderFormatQuery(formatId, client, items, description) {
  const fmt = getFormatById(formatId);
  const sources = items.map((v) => `"${v}"`).join(",");
  return fmt.template
    .replace(/\{client\}/g, client)
    .replace(/\{sources\}/g, sources)
    .replace(/\{field\}/g, FIELD)
    .replace(/\{description\}/g, description != null ? description : "");
}
const valState = {
  standalone: { results: [], fixedLines: [], formatId: "f1" },
  inline: { results: [], fixedLines: [], formatId: "f1" },
};
function levenshtein(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
  return dp[a.length][b.length];
}
function getSuggestions(bad, n = 4) {
  return clients
    .map((c) => ({
      name: c,
      score: 1 - levenshtein(bad, c) / Math.max(bad.length, c.length),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .filter((s) => s.score > 0.1);
}
function validateLine(text, idx, formatId) {
  const row = {
    index: idx + 1,
    input: text,
    result: "PASS",
    issues: [],
    spaceMap: [],
    clientName: null,
  };
  if (!text || !text.trim()) {
    row.result = "SKIP";
    return row;
  }
  const fmt = getFormatById(formatId || "f1");
  const matcher = buildFormatMatcher(fmt.template);
  if (!matcher.regex) {
    row.result = "FAIL";
    row.issues.push({ type: "format" });
    return row;
  }
  const m = matcher.regex.exec(text);
  if (!m) {
    row.result = "FAIL";
    row.issues.push({ type: "format" });
  } else if (matcher.hasClient) {
    const ext = extractFromMatch(m, matcher.groupKinds);
    row.clientName = ext.client;
    if (!clients.includes(row.clientName)) {
      row.result = "FAIL";
      row.issues.push({ type: "client" });
    }
  }
  const qRe = /"([^"]*)"/g;
  let qm;
  while ((qm = qRe.exec(text)) !== null) {
    const v = qm[1],
      lead = (v.match(/^( +)/) || [""])[0].length,
      trail = (v.match(/( +)$/) || [""])[0].length;
    if (lead || trail) {
      row.spaceMap.push({
        value: v,
        leadSpaces: lead,
        trailSpaces: trail,
        start: qm.index,
        end: qm.index + qm[0].length,
      });
      row.result = "FAIL";
    }
  }
  return row;
}
function buildHighlighted(text, spaceMap) {
  if (!spaceMap.length) return esc(text);
  let result = "",
    cursor = 0;
  for (const seg of [...spaceMap].sort((a, b) => a.start - b.start)) {
    result += esc(text.slice(cursor, seg.start + 1));
    const v = seg.value;
    let inner = "",
      i = 0;
    while (i < v.length && v[i] === " " && i < seg.leadSpaces) {
      inner += `<span class="sp-lead" title="Leading space">&middot;</span>`;
      i++;
    }
    const me = v.length - seg.trailSpaces;
    inner += esc(v.slice(i, me));
    for (let j = me; j < v.length; j++)
      inner += `<span class="sp-trail" title="Trailing space">&middot;</span>`;
    result += inner + esc(text[seg.end - 1]);
    cursor = seg.end;
  }
  return result + esc(text.slice(cursor));
}
function fixSpaces(t) {
  return t.replace(/"([^"]*)"/g, (_, v) => `"${v.trim()}"`);
}
function replaceClientName(t, name, oldName) {
  if (oldName != null && oldName !== "") {
    const pat = new RegExp('"' + escapeRegexLit(oldName) + '"');
    if (pat.test(t)) return t.replace(pat, '"' + name + '"');
  }
  return t.replace(/((?:MATCHES|=)\s*")([^"]*)(")/, `$1${name}$3`);
}
function runValidation(mode, rawText, formatId) {
  if (mode === "standalone") {
    rawText = document.getElementById("v-input").value;
    formatId = document.getElementById("v-format-select")?.value;
    if (!rawText.trim()) {
      showToast("Nothing to validate", "warn");
      return;
    }
  }
  if (!formatId) formatId = queryFormats[0]?.id || "f1";
  const st = valState[mode];
  st.results = rawText.split("\n").map((l, i) => validateLine(l, i, formatId));
  st.fixedLines = [];
  st.formatId = formatId;
  renderValResults(mode);
  getFixCard(mode).style.display = "none";
}
function getAnchor(mode) {
  return document.getElementById(
    mode === "inline" ? "inline-val-anchor" : "standalone-val-anchor",
  );
}
function getFixCard(mode) {
  return document.getElementById(mode + "-fixCard");
}
function renderValResults(mode) {
  const st = valState[mode],
    res = st.results;
  const fmtName = esc(getFormatById(st.formatId).name);
  const pass = res.filter((r) => r.result === "PASS").length,
    fail = res.filter((r) => r.result === "FAIL").length,
    skip = res.filter((r) => r.result === "SKIP").length;
  const stats = `<div class="stat-row-inline"><div class="spi">Total <span class="spi-val">${res.length}</span></div><div class="spi">Pass <span class="spi-val pass">${pass}</span></div>${fail ? `<div class="spi">Fail <span class="spi-val fail">${fail}</span></div>` : ""} ${skip ? `<div class="spi">Skip <span class="spi-val warn">${skip}</span></div>` : ""}<div class="spi" style="margin-left:auto">Format <span class="spi-val" style="color:var(--accent2)">${fmtName}</span></div></div>`;
  const rows = res
    .map((r) => {
      if (r.result === "SKIP")
        return `<tr style="opacity:.35"><td class="col-sno">${r.index}</td><td><span style="color:var(--text3);font-style:italic;font-size:11px">empty</span></td><td class="col-result"><span class="badge badge-skip">SKIP</span></td><td>&mdash;</td></tr>`;
      const badge =
        r.result === "PASS"
          ? '<span class="badge badge-pass">PASS</span>'
          : '<span class="badge badge-fail">FAIL</span>';
      const hl = buildHighlighted(r.input, r.spaceMap);
      let detail =
        r.result === "PASS"
          ? '<span class="detail-pill pill-ok">All checks passed</span>'
          : (() => {
              const pills = [];
              for (const iss of r.issues) {
                if (iss.type === "format")
                  pills.push(
                    `<span class="detail-pill pill-fmt">Format mismatch &mdash; expected "${fmtName}"</span>`,
                  );
                if (iss.type === "client")
                  pills.push(
                    `<span class="detail-pill pill-client">Unknown client: ${esc(r.clientName)}</span>`,
                  );
              }
              for (const seg of r.spaceMap) {
                if (seg.leadSpaces)
                  pills.push(
                    `<span class="detail-pill pill-lead">&#8629;${seg.leadSpaces} leading in "${esc(seg.value)}"</span>`,
                  );
                if (seg.trailSpaces)
                  pills.push(
                    `<span class="detail-pill pill-trail">${seg.trailSpaces} trailing&#8627; in "${esc(seg.value)}"</span>`,
                  );
              }
              return `<div class="detail-row">${pills.join("")}</div>`;
            })();
      const bg = r.result === "FAIL" ? "background:rgba(255,58,92,.015)" : "";
      return `<tr style="${bg}"><td class="col-sno">${r.index}</td><td><div class="script-display">${hl}</div></td><td class="col-result">${badge}</td><td>${detail}</td></tr>`;
    })
    .join("");
  const toolbar =
    fail === 0
      ? `<button class="btn btn-fix" onclick="copyAllPassed('${mode}')">&#9658; Copy All Passed</button>`
      : `<button class="btn btn-fix" onclick="showFixed('${mode}')">&#10022; Fix Spaces &amp; Clients</button>`;
  getAnchor(mode).innerHTML =
    `<div class="card" id="${mode}-resultsCard"><div class="card-title ${mode === "inline" ? "" : "amber"}">Validation Results</div>${stats}<div class="table-wrap"><table><thead><tr><th class="col-sno">#</th><th>Script <span style="color:var(--text3);font-size:8px;margin-left:5px">// spaces highlighted</span></th><th class="col-result">Status</th><th style="min-width:175px">Details</th></tr></thead><tbody>${rows}</tbody></table></div><div class="legend"><div class="legend-item"><div class="legend-dot" style="background:rgba(255,124,42,.6)"></div>Leading space</div><div class="legend-item"><div class="legend-dot" style="background:rgba(255,79,160,.6)"></div>Trailing space</div><div class="legend-item"><div class="legend-dot" style="background:var(--fail-bg);border:1px solid var(--fail-border)"></div>Format error</div><div class="legend-item"><div class="legend-dot" style="background:var(--warn-bg);border:1px solid var(--warn-border)"></div>Unknown client</div></div><div class="toolbar">${toolbar}</div></div><div id="${mode}-fixCard" style="display:none"></div>`;
}
function showFixed(mode) {
  const st = valState[mode];
  const fmt = getFormatById(st.formatId);
  const matcher = buildFormatMatcher(fmt.template);
  st.fixedLines = st.results
    .filter((r) => r.result !== "SKIP")
    .map((r) => {
      const fixed = fixSpaces(r.input);
      let cn = null,
        ok = true;
      if (matcher.hasClient && matcher.regex) {
        const m = matcher.regex.exec(fixed);
        cn = m ? extractFromMatch(m, matcher.groupKinds).client : r.clientName;
        ok = cn ? clients.includes(cn) : true;
      }
      return {
        rowIndex: r.index,
        text: fixed,
        originalInput: r.input,
        originalClientName: cn,
        needsPick: !!cn && !ok,
        resolved: false,
        resolvedWith: null,
      };
    });
  renderFixedOutput(mode);
  getFixCard(mode).style.display = "block";
  getFixCard(mode).scrollIntoView({ behavior: "smooth", block: "start" });
  showToast("Spaces cleared", "success");
}
function renderFixedOutput(mode) {
  const st = valState[mode],
    lines = st.fixedLines;
  const pending = lines.filter((l) => l.needsPick && !l.resolved).length;
  const pendingBadge =
    pending > 0
      ? `<span style="background:var(--warn-bg);color:var(--warn);border:1px solid var(--warn-border);padding:3px 9px;font:700 10px var(--mono);border-radius:var(--radius)">&#9888; ${pending} client${pending > 1 ? "s" : ""} need fix</span>`
      : "";
  const rowsHtml = lines
    .map((line, idx) => {
      const isResolved = line.resolved,
        needsPick = line.needsPick && !isResolved,
        isChanged = line.text !== line.originalInput;
      let cls = "fixed-row";
      if (isResolved) cls += " resolved";
      else if (needsPick) cls += " needs-client";
      else if (isChanged) cls += " changed";
      const resolvedTag = isResolved
        ? `<span class="resolved-tag">&#10003; ${esc(line.resolvedWith)}</span>`
        : "";
      let picker = "";
      if (needsPick) {
        const sugg = getSuggestions(line.originalClientName);
        const chips = sugg
          .map(
            (s, si) =>
              `<div class="suggestion-chip ${si === 0 ? "best" : ""}" onclick="applyClient('${mode}',${idx},'${esc(s.name)}')">${esc(s.name)}<span class="score"> ${Math.round(s.score * 100)}%</span></div>`,
          )
          .join("");
        picker = `<div class="client-picker"><div class="client-picker-label">Replace <span class="bad-name">${esc(line.originalClientName)}</span>:</div><div class="suggestion-chips">${chips || '<span style="color:var(--text3);font-size:10px">No close matches</span>'}</div><div class="picker-divider"></div><div class="custom-input-wrap"><input class="custom-client-input" id="${mode}_cc_${idx}" type="text" placeholder="Type name&#8230;" list="${mode}_cdl_${idx}"/><datalist id="${mode}_cdl_${idx}">${clients.map((c) => `<option value="${esc(c)}">`).join("")}</datalist><button class="apply-custom-btn" onclick="applyCustomClient('${mode}',${idx})">Apply</button></div></div>`;
      }
      let textDisplay = `<div style="color:var(--text2)">${esc(line.text)}</div>`;
      if (isChanged || isResolved)
        textDisplay = `<div class="diff-orig">${esc(line.originalInput)}</div><div class="diff-new">${esc(line.text)}</div>`;
      return `<div class="${cls}"><div class="fixed-row-top"><div class="fixed-row-num">${line.rowIndex}</div><div class="fixed-row-text">${textDisplay}</div><div class="fixed-row-actions">${resolvedTag}<button class="copy-line-btn" onclick="copyFixedLine('${mode}',${idx})" title="Copy">&#8853;</button></div></div>${picker}</div>`;
    })
    .join("");
  getFixCard(mode).innerHTML =
    `<div class="card"><div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:14px;"><div class="card-title" style="margin:0">Fixed Output</div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">${pendingBadge}<button class="btn btn-secondary btn-sm" onclick="copyAllFixed('${mode}')">&#9658; Copy All</button></div></div><div style="font:500 10px var(--mono);color:var(--text3);margin-bottom:12px;padding:7px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);line-height:1.9;">&#10003; Spaces removed &nbsp;&middot;&nbsp; &#9888; Unknown clients highlighted &mdash; select suggestion or type replacement<br><span style="opacity:.55">Strikethrough = original &nbsp;&middot;&nbsp; Green = corrected</span></div><div class="fixed-output">${rowsHtml}</div></div>`;
}
function applyClient(mode, idx, name) {
  const line = valState[mode].fixedLines[idx];
  line.text = replaceClientName(line.text, name, line.originalClientName);
  line.resolved = true;
  line.resolvedWith = name;
  line.needsPick = false;
  renderFixedOutput(mode);
  showToast(`Applied "${name}"`, "success");
}
function applyCustomClient(mode, idx) {
  const el = document.getElementById(`${mode}_cc_${idx}`),
    name = el ? el.value.trim() : "";
  if (!name) {
    showToast("Enter a name first");
    return;
  }
  if (hasUnsafeQuote(name)) {
    showToast('Client name cannot contain a " character', "warn");
    return;
  }
  applyClient(mode, idx, name);
}
function copyFixedLine(mode, idx) {
  navigator.clipboard
    .writeText(valState[mode].fixedLines[idx].text)
    .then(() => showToast("Copied"));
}
function copyAllFixed(mode) {
  navigator.clipboard
    .writeText(valState[mode].fixedLines.map((l) => l.text).join("\n"))
    .then(() => showToast("All copied"));
}
function copyAllPassed(mode) {
  navigator.clipboard
    .writeText(
      valState[mode].results
        .filter((r) => r.result === "PASS")
        .map((r) => r.input)
        .join("\n"),
    )
    .then(() => showToast("Passed scripts copied"));
}
function clearValInput() {
  document.getElementById("v-input").value = "";
  document.getElementById("standalone-val-anchor").innerHTML = "";
}
function loadSample() {
  const goodClient = clients[0] || "Ashland";
  const fid = queryFormats[0]?.id || "f1";
  const good = renderFormatQuery(
    fid,
    goodClient,
    ["web", "app"],
    "Sample description",
  );
  const bad = renderFormatQuery(
    fid,
    " Harish",
    ["web", "app"],
    "Sample description",
  );
  document.getElementById("v-input").value = good + "\n" + bad;
  runValidation("standalone");
}

/* ══════════════════════════════════════════════════════
   CHANGE 1: QUERY FORMAT TEMPLATES
══════════════════════════════════════════════════════ */
function renderFormatList() {
  const list = document.getElementById("format-list");
  if (!list) return;
  list.innerHTML = queryFormats
    .map((f, i) => {
      const isBuiltIn = DEFAULT_FORMATS.some((df) => df.id === f.id);
      return `
    <div class="fmt-list-row ${i === 0 ? "active-fmt" : ""}">
      <span class="fmt-list-name">${esc(f.name)}</span>
      <span class="fmt-list-tpl">${esc(f.template)}</span>
      <div class="fmt-list-actions">
        ${!isBuiltIn ? `<button class="btn btn-secondary btn-sm" onclick="deleteQueryFormat('${f.id}')" aria-label="Delete format ${esc(f.name)}">&#10005;</button>` : '<span style="font:500 9px var(--mono);color:var(--text3)">DEFAULT</span>'}
      </div>
    </div>`;
    })
    .join("");
  renderFormatSelect();
}

const FORMAT_SELECT_IDS = [
  "g-format-select",
  "v-format-select",
  "adv-format-select",
  "bulk-format-select",
];
function renderFormatSelect() {
  FORMAT_SELECT_IDS.forEach((id) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value || queryFormats[0]?.id || "f1";
    sel.innerHTML = queryFormats
      .map(
        (f) =>
          `<option value="${f.id}" ${f.id === prev ? "selected" : ""}>${esc(f.name)}</option>`,
      )
      .join("");
  });
  updateFormatPreview();
}

function updateFormatPreview() {
  const sel = document.getElementById("g-format-select");
  const prev = document.getElementById("g-format-preview");
  if (!sel || !prev) return;
  const f = queryFormats.find((x) => x.id === sel.value) || queryFormats[0];
  const descVal =
    (document.getElementById("g-description")?.value || "").trim() ||
    "Some Description";
  if (f)
    prev.textContent = f.template
      .replace("{client}", "ClientName")
      .replace("{sources}", '"HOST1","HOST2"')
      .replace("{description}", descVal);
  const supportsDesc = !!(f && f.template.includes("{description}"));
  const row = document.getElementById("g-desc-row");
  if (row) row.style.display = supportsDesc ? "grid" : "none";
  if (!supportsDesc) {
    const d = document.getElementById("g-description");
    if (d) d.value = "";
  }
}

function updateBulkFormatHint() {
  const fid = document.getElementById("bulk-format-select")?.value;
  const supportsDesc = formatSupportsDescription(fid);
  const group = document.getElementById("bulk-desc-group");
  const row = document.getElementById("bulk-format-row");
  if (group) group.style.display = supportsDesc ? "block" : "none";
  if (row) row.style.gridTemplateColumns = supportsDesc ? "1fr 1fr" : "1fr";
  if (!supportsDesc) {
    const d = document.getElementById("bulk-description");
    if (d) d.value = "";
  }
}
function addQueryFormat() {
  const name = document.getElementById("fmt-name-input").value.trim();
  const tpl = document.getElementById("fmt-tpl-input").value.trim();
  if (!name || !tpl) {
    showToast("Enter both name and template");
    return;
  }
  if (!tpl.includes("{sources}")) {
    showToast("Template must include {sources}");
    return;
  }
  const id = "f" + Date.now();
  queryFormats.push({ id, name, template: tpl });
  saveFormats();
  renderFormatList();
  document.getElementById("fmt-name-input").value = "";
  document.getElementById("fmt-tpl-input").value = "";
  showToast(`Format "${name}" added`);
}

function deleteQueryFormat(id) {
  if (DEFAULT_FORMATS.some((df) => df.id === id)) {
    showToast("Cannot delete a default format", "warn");
    return;
  }
  queryFormats = queryFormats.filter((f) => f.id !== id);
  saveFormats();
  renderFormatList();
  showToast("Format removed");
}

// Format UI is initialized from initApp() after storage loads.

/* ══════════════════════════════════════════════════════
   CHANGE 2: ADVANCED VALIDATOR
══════════════════════════════════════════════════════ */
function syncAdvClientDropdown() {
  const sel = document.getElementById("adv-client");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML =
    '<option value="" disabled>&#8212; SELECT CLIENT &#8212;</option>' +
    clients
      .map(
        (c) =>
          `<option value="${esc(c)}" ${c === prev ? "selected" : ""}>${esc(c)}</option>`,
      )
      .join("");
  if (!clients.includes(prev)) sel.value = "";
}

function toggleAdvancedVal() {
  advValActive = !advValActive;
  const tog = document.getElementById("adv-toggle");
  const tog2 = document.getElementById("adv-toggle-2");
  const std = document.getElementById("page-val");
  const adv = document.getElementById("page-adv-val");
  if (advValActive) {
    tog.classList.add("on");
    if (tog2) tog2.classList.add("on");
    // Use the same class-based system as switchPage — no inline styles, single source of truth
    document.querySelectorAll(".page").forEach((p) => {
      p.classList.remove("active");
      p.style.display = "";
    });
    adv.classList.add("active");
    syncAdvClientDropdown();
    // switch nav highlight
    document
      .querySelectorAll(".nav-item")
      .forEach((n) =>
        n.classList.remove(
          "active",
          "active-purple",
          "active-warn",
          "active-cyan",
        ),
      );
    document.getElementById("nav-val").classList.add("active-warn");
  } else {
    tog.classList.remove("on");
    if (tog2) tog2.classList.remove("on");
    document.querySelectorAll(".page").forEach((p) => {
      p.classList.remove("active");
      p.style.display = "";
    });
    std.classList.add("active");
    document
      .querySelectorAll(".nav-item")
      .forEach((n) =>
        n.classList.remove(
          "active",
          "active-purple",
          "active-warn",
          "active-cyan",
        ),
      );
    document.getElementById("nav-val").classList.add("active-warn");
  }
}

function clearAdvVal() {
  document.getElementById("adv-hosts").value = "";
  document.getElementById("adv-scripts").value = "";
  document.getElementById("adv-val-anchor").innerHTML = "";
}

function runAdvancedValidation() {
  const clientSel = document.getElementById("adv-client").value;
  const hostsRaw = document.getElementById("adv-hosts").value;
  const scriptsRaw = document.getElementById("adv-scripts").value;
  const mode = document.getElementById("adv-mode").value;
  const formatId =
    document.getElementById("adv-format-select")?.value ||
    queryFormats[0]?.id ||
    "f1";
  const fmt = getFormatById(formatId);
  const matcher = buildFormatMatcher(fmt.template);

  if (!clientSel) {
    showToast("Select expected client first", "warn");
    flagInvalid("adv-client");
    return;
  }
  if (!scriptsRaw.trim()) {
    showToast("Paste scripts to validate", "warn");
    flagInvalid("adv-scripts");
    return;
  }

  const expectedHosts = hostsRaw
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
  const scriptLines = scriptsRaw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // For each script parse out client name and all sources
  const scriptResults = scriptLines.map((line, idx) => {
    const m = matcher.regex ? matcher.regex.exec(line) : null;
    if (!m)
      return {
        idx: idx + 1,
        line,
        valid: false,
        client: null,
        sources: [],
        clientMatch: false,
        issues: ["Format mismatch"],
      };
    const ext = extractFromMatch(m, matcher.groupKinds);
    const client = matcher.hasClient ? ext.client : clientSel;
    const sourcesRaw = ext.sourcesRaw || "";
    const sources = (sourcesRaw.match(/"([^"]*)"/g) || []).map((s) =>
      s.replace(/"/g, "").trim().toLowerCase(),
    );
    const clientMatch = matcher.hasClient ? client === clientSel : true;
    const issues = [];
    if (matcher.hasClient && !clientMatch)
      issues.push(`Client mismatch: expected "${clientSel}" got "${client}"`);
    // Check for leading/trailing spaces in client or sources
    if (matcher.hasClient) {
      const clientSpaces = client !== client.trim();
      if (clientSpaces) issues.push("Client name has leading/trailing spaces");
    }
    sources.forEach((s) => {
      if (s !== s.trim()) issues.push(`Source "${s}" has spaces`);
    });
    return {
      idx: idx + 1,
      line,
      valid: true,
      client,
      sources,
      clientMatch,
      issues,
    };
  });

  // Per-host coverage check
  const hostResults = expectedHosts.map((host) => {
    const appearsIn = scriptResults
      .filter((r) => r.sources && r.sources.includes(host))
      .map((r) => r.idx);
    return { host, found: appearsIn.length > 0, inScripts: appearsIn };
  });

  const allFound = hostResults.every((h) => h.found);
  const anyFound = hostResults.some((h) => h.found);
  const clientAllMatch = scriptResults.every((r) => !r.valid || r.clientMatch);
  const overallPass = (mode === "all" ? allFound : anyFound) && clientAllMatch;

  // Render
  const anchor = document.getElementById("adv-val-anchor");

  const hostHtml = expectedHosts.length
    ? `
    <div class="adv-section-title">Host Coverage</div>
    <div class="host-check-grid">${hostResults
      .map(
        (h) => `
      <div class="host-check-row ${h.found ? "found" : "missing"}">
        <span class="hcr-host">${esc(h.host)}</span>
        <span class="hcr-status ${h.found ? "hcr-found" : "hcr-missing"}">${h.found ? "&#10003; FOUND" : "&#10005; MISSING"}</span>
        <span class="hcr-scripts">${h.found ? "in script(s): " + h.inScripts.join(", ") : "not in any script"}</span>
      </div>`,
      )
      .join("")}
    </div>`
    : '<div style="font:500 10px var(--mono);color:var(--text3);margin-bottom:10px;">No expected hosts specified — skipping coverage check.</div>';

  const scriptHtml = `
    <div class="adv-section-title">Script-by-Script Results</div>
    <div class="table-wrap"><table>
      <thead><tr>
        <th class="col-sno">#</th>
        <th>Script</th>
        <th style="width:90px;text-align:center">Client</th>
        <th style="min-width:160px">Issues</th>
      </tr></thead>
      <tbody>${scriptResults
        .map((r) => {
          const fmtBadge = r.valid
            ? ""
            : `<span class="badge badge-fail" title="Expected format: ${esc(fmt.name)}">FORMAT</span>`;
          const clientBadge = r.valid
            ? r.clientMatch
              ? '<span class="badge badge-pass">&#10003;</span>'
              : '<span class="badge badge-fail">&#10005;</span>'
            : "—";
          const issues = r.issues.length
            ? r.issues
                .map(
                  (i) =>
                    `<span class="detail-pill pill-client">${esc(i)}</span>`,
                )
                .join(" ")
            : '<span class="detail-pill pill-ok">All OK</span>';
          return `<tr ${r.issues.length ? 'style="background:rgba(255,58,92,.015)"' : ""}>
          <td class="col-sno">${r.idx}</td>
          <td><div class="script-display">${esc(r.line.slice(0, 120))}${r.line.length > 120 ? "…" : ""}</div></td>
          <td style="text-align:center">${clientBadge} ${fmtBadge}</td>
          <td><div class="detail-row">${issues}</div></td>
        </tr>`;
        })
        .join("")}</tbody>
    </table></div>`;

  const summaryColor = overallPass ? "var(--pass)" : "var(--fail)";
  const summaryText = overallPass
    ? "&#10003; ALL CHECKS PASSED"
    : "&#10005; ISSUES DETECTED";
  const coverageSummary = expectedHosts.length
    ? `${hostResults.filter((h) => h.found).length}/${hostResults.length} hosts found`
    : "No hosts specified";

  anchor.innerHTML = `<div class="card">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap;">
      <span style="font:700 12px var(--display);color:${summaryColor};letter-spacing:2px;">${summaryText}</span>
      <span style="font:500 10px var(--mono);color:var(--text3)">${coverageSummary} &middot; ${scriptResults.filter((r) => r.clientMatch).length}/${scriptLines.length} client match</span>
      <span style="font:500 10px var(--mono);color:var(--accent2);margin-left:auto">Format: ${esc(fmt.name)}</span>
    </div>
    ${hostHtml}${scriptHtml}
  </div>`;
}

/* ══════════════════════════════════════════════════════
   CHANGE 6: FQDN hint show/hide
══════════════════════════════════════════════════════ */
function updateFqdnHint() {
  const hint = document.getElementById("fqdn-hint");
  if (!hint) return;
  const suffix = getFqdnSuffix();
  hint.style.display = suffix ? "block" : "none";
}
// Patch existing FQDN change handlers
const _origFqdnSelect = onFqdnSelectChange;
onFqdnSelectChange = function () {
  _origFqdnSelect();
  updateFqdnHint();
};
const _origFqdnCustom = onFqdnCustomInput;
onFqdnCustomInput = function () {
  _origFqdnCustom();
  updateFqdnHint();
};

/* ══════════════════════════════════════════════════════
   BULK ENGINE helpers (carried from previous version)
══════════════════════════════════════════════════════ */
let bulkRecords = [],
  bulkScripts = [],
  bulkGroups = [];

function syncBulkClientDropdown() {
  const sel = document.getElementById("bulk-client");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML =
    '<option value="" disabled>&#8212; SELECT CLIENT &#8212;</option>' +
    clients
      .map(
        (c) =>
          `<option value="${esc(c)}" ${c === prev ? "selected" : ""}>${esc(c)}</option>`,
      )
      .join("");
  if (!clients.includes(prev)) sel.value = "";
}
function setupBulkDrop() {
  const dz = document.getElementById("bulkDropZone");
  if (!dz) return;
  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("drag-over");
  });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag-over"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("drag-over");
    const f = e.dataTransfer.files[0];
    if (f) bulkHandleFile(f);
  });
}
function bulkHandleFile(file) {
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    showToast("File exceeds 10 MB limit");
    return;
  }
  const ext = file.name.split(".").pop().toLowerCase();
  if (!["xlsx", "xls", "csv"].includes(ext)) {
    showToast("Unsupported format");
    return;
  }
  bulkSetProgress(5, "READING FILE...");
  document.getElementById("bulk-progress-wrap").style.display = "block";
  const reader = new FileReader();
  if (ext === "csv") {
    reader.onload = (e) => bulkParseCSV(e.target.result, file.name);
    reader.readAsText(file);
  } else {
    reader.onload = (e) =>
      bulkParseXLSX(new Uint8Array(e.target.result), file.name);
    reader.readAsArrayBuffer(file);
  }
}
function bulkParseCSV(text, fname) {
  bulkSetProgress(20, "PARSING CSV...");
  const lines = text.split(/\r?\n/);
  if (!lines[0]) {
    showToast("Empty file");
    return;
  }
  const rawHeaders = lines[0]
    .split(",")
    .map((h) => h.trim().replace(/^"|"$/g, ""));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    if (cols.every((c) => !c)) continue;
    const obj = {};
    rawHeaders.forEach((h, j) => {
      obj[normKey(h)] = cols[j] || "";
    });
    rows.push(obj);
  }
  bulkValidateRows(rows, fname);
}
function bulkParseXLSX(buffer, fname) {
  bulkSetProgress(20, "PARSING XLSX...");
  try {
    const decoder = new TextDecoder();
    const entries = zipReadEntries(buffer);
    let sharedStrings = [],
      sheetXML = "";
    for (const entry of entries) {
      if (entry.name === "xl/sharedStrings.xml")
        sharedStrings = parseSharedStrings(decoder.decode(entry.data));
      if (entry.name === "xl/worksheets/sheet1.xml")
        sheetXML = decoder.decode(entry.data);
    }
    if (!sheetXML) {
      showToast("Could not read worksheet");
      bulkSetProgress(0, "ERROR");
      return;
    }
    const rows = parseSheetXML(sheetXML, sharedStrings);
    if (rows.length < 2) {
      showToast("No data rows found");
      return;
    }
    const rawHeaders = rows[0].map((h) => (h || "").toString().trim());
    const objRows = rows
      .slice(1)
      .map((row) => {
        const obj = {};
        rawHeaders.forEach((h, j) => {
          obj[normKey(h)] = (row[j] || "").toString().trim();
        });
        return obj;
      })
      .filter((r) => Object.values(r).some((v) => v));
    bulkValidateRows(objRows, fname);
  } catch (e) {
    console.error(e);
    showToast("XLSX parse error \u2014 try CSV");
    bulkSetProgress(0, "ERROR");
  }
}
function zipReadEntries(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const entries = [];
  let pos = 0;
  while (pos < u8.length - 4) {
    if (
      u8[pos] === 0x50 &&
      u8[pos + 1] === 0x4b &&
      u8[pos + 2] === 0x03 &&
      u8[pos + 3] === 0x04
    ) {
      const csize =
        u8[pos + 18] |
        (u8[pos + 19] << 8) |
        (u8[pos + 20] << 16) |
        (u8[pos + 21] << 24);
      const namelen = u8[pos + 26] | (u8[pos + 27] << 8);
      const exlen = u8[pos + 28] | (u8[pos + 29] << 8);
      const name = new TextDecoder().decode(
        u8.slice(pos + 30, pos + 30 + namelen),
      );
      const dataStart = pos + 30 + namelen + exlen;
      entries.push({ name, data: u8.slice(dataStart, dataStart + csize) });
      pos = dataStart + csize;
    } else {
      pos++;
    }
  }
  return entries;
}
function parseSharedStrings(xml) {
  const arr = [];
  const re = /<si>[\s\S]*?<\/si>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    arr.push(
      (m[0].match(/<t[^>]*>([^<]*)<\/t>/g) || [])
        .map((t) => t.replace(/<[^>]+>/g, ""))
        .join(""),
    );
  }
  return arr;
}
function parseSheetXML(xml, ss) {
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml)) !== null) {
    const cells = [];
    const cellRe = /<c r="([A-Z]+)(\d+)"([^>]*)>([\s\S]*?)<\/c>/g;
    let cm;
    while ((cm = cellRe.exec(rm[1])) !== null) {
      const col = cm[1],
        t = cm[3],
        inner = cm[4];
      const vMatch = inner.match(/<v>([^<]*)<\/v>/);
      let val = vMatch ? vMatch[1] : "";
      if (t.includes('t="s"') && ss[parseInt(val)] !== undefined)
        val = ss[parseInt(val)];
      let ci = 0;
      for (let i = 0; i < col.length; i++)
        ci = ci * 26 + (col.charCodeAt(i) - 64);
      cells[ci - 1] = val;
    }
    rows.push(cells);
  }
  return rows;
}
const COL_MAP = {
  hostname: [
    "hostname",
    "host",
    "server",
    "servername",
    "name",
    "hostnames",
    "host name",
  ],
  ipaddress: ["ipaddress", "ip", "ip address", "ipaddr", "ip_address"],
  startdate: ["startdate", "start date", "start_date"],
  starttime: ["starttime", "start time", "start_time"],
  enddate: ["enddate", "end date", "end_date"],
  endtime: ["endtime", "end time", "end_time"],
  startdatetime: [
    "startdatetime",
    "start datetime",
    "start_datetime",
    "startdt",
  ],
  enddatetime: ["enddatetime", "end datetime", "end_datetime", "enddt"],
  clientname: ["clientname", "client", "client name", "client_name"],
};
function normKey(raw) {
  const k = raw.toLowerCase().replace(/\s+/g, "");
  for (const [canon, aliases] of Object.entries(COL_MAP)) {
    if (aliases.includes(k) || aliases.includes(raw.toLowerCase()))
      return canon;
  }
  return k;
}

const DEFAULT_TIME = "00:00:00";
const _parseLog = [];
function _logParse(input, result) {
  if (document.getElementById("bulk-debug-mode")?.checked) {
    _parseLog.push({ input, result: result ? fmtDT(result) : "FAILED" });
  }
}
const _MONTHS = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};
function _applyAmPm(h, ampm) {
  if (!ampm) return h;
  const ap = ampm.toUpperCase();
  if (ap === "AM" && h === 12) return 0;
  if (ap === "PM" && h !== 12) return h + 12;
  return h;
}
function _mkDate(y, mo, d, h, min, s) {
  return new Date(y, mo - 1, d, h, min, s || 0);
}

function parseDateTime(dateStr, timeStr) {
  const combined = timeStr
    ? (dateStr || "").trim() + " " + (timeStr || "").trim()
    : (dateStr || "").trim();
  // Strip timezone abbreviations and UTC offsets
  const raw = combined
    .trim()
    .replace(
      /\s+(?:IST|UTC|GMT|EST|CST|PST|MST|EDT|CDT|PDT|MDT|CET|EET|BST|JST|AEST|AEDT|NZST|HKT|SGT|WIB|WIT|ICT)$/i,
      "",
    )
    .replace(/\s+[+-]\d{2}:?\d{2}$/, "")
    .trim();
  if (!raw) {
    _logParse(raw, null);
    return null;
  }
  let m,
    d,
    y,
    mo,
    h = 0,
    min = 0,
    s = 0,
    ampm = "";
  // YYYY-MM-DD
  m = raw.match(
    /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(\s*[AaPp][Mm])?)?$/,
  );
  if (m) {
    y = +m[1];
    mo = +m[2];
    d = +m[3];
    h = m[4] ? +m[4] : 0;
    min = m[5] ? +m[5] : 0;
    s = m[6] ? +m[6] : 0;
    ampm = (m[7] || "").trim();
    h = _applyAmPm(h, ampm);
    const dt = _mkDate(y, mo, d, h, min, s);
    _logParse(raw, dt);
    return dt;
  }
  // DD-MM-YYYY or DD/MM/YYYY
  m = raw.match(
    /^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(\s*[AaPp][Mm])?)?$/,
  );
  if (m) {
    d = +m[1];
    mo = +m[2];
    y = +m[3];
    h = m[4] ? +m[4] : 0;
    min = m[5] ? +m[5] : 0;
    s = m[6] ? +m[6] : 0;
    ampm = (m[7] || "").trim();
    h = _applyAmPm(h, ampm);
    const dt = _mkDate(y, mo, d, h, min, s);
    _logParse(raw, dt);
    return dt;
  }
  // DD MMM YYYY
  m = raw.match(
    /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(\s*[AaPp][Mm])?)?$/,
  );
  if (m) {
    d = +m[1];
    mo = _MONTHS[m[2].toLowerCase()];
    y = +m[3];
    h = m[4] ? +m[4] : 0;
    min = m[5] ? +m[5] : 0;
    s = m[6] ? +m[6] : 0;
    ampm = (m[7] || "").trim();
    if (mo) {
      h = _applyAmPm(h, ampm);
      const dt = _mkDate(y, mo, d, h, min, s);
      _logParse(raw, dt);
      return dt;
    }
  }
  // MMM DD YYYY
  m = raw.match(
    /^([A-Za-z]+)\s+(\d{1,2})\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(\s*[AaPp][Mm])?)?$/,
  );
  if (m) {
    mo = _MONTHS[m[1].toLowerCase()];
    d = +m[2];
    y = +m[3];
    h = m[4] ? +m[4] : 0;
    min = m[5] ? +m[5] : 0;
    s = m[6] ? +m[6] : 0;
    ampm = (m[7] || "").trim();
    if (mo) {
      h = _applyAmPm(h, ampm);
      const dt = _mkDate(y, mo, d, h, min, s);
      _logParse(raw, dt);
      return dt;
    }
  }
  // DD-Mon-YYYY
  m = raw.match(
    /^(\d{1,2})[-\/]([A-Za-z]+)[-\/](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(\s*[AaPp][Mm])?)?$/,
  );
  if (m) {
    d = +m[1];
    mo = _MONTHS[m[2].slice(0, 3).toLowerCase()];
    y = +m[3];
    h = m[4] ? +m[4] : 0;
    min = m[5] ? +m[5] : 0;
    s = m[6] ? +m[6] : 0;
    ampm = (m[7] || "").trim();
    if (mo) {
      h = _applyAmPm(h, ampm);
      const dt = _mkDate(y, mo, d, h, min, s);
      _logParse(raw, dt);
      return dt;
    }
  }
  // Time only
  m = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(\s*[AaPp][Mm])?$/);
  if (m) {
    h = +m[1];
    min = +m[2];
    s = m[3] ? +m[3] : 0;
    ampm = (m[4] || "").trim();
    h = _applyAmPm(h, ampm);
    const now = new Date();
    const dt = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      h,
      min,
      s,
    );
    _logParse(raw, dt);
    return dt;
  }
  _logParse(raw, null);
  return null;
}
function parseDateTimeError(raw, fieldName, rowNum) {
  return `Row ${rowNum}: Invalid date/time${fieldName ? " (" + fieldName + ")" : ""}: "${raw}".\nSupported: DD-MM-YYYY HH:mm \u00b7 DD/MM/YYYY HH:mm \u00b7 YYYY-MM-DD HH:mm \u00b7 DD MMM YYYY HH:mm \u00b7 MMM DD YYYY HH:mm \u00b7 (+ timezone suffix stripped automatically)`;
}
function fmtDT(d) {
  if (!d || isNaN(d)) return "\u2014";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function isValidIP(s) {
  return (
    /^(\d{1,3}\.){3}\d{1,3}$/.test(s) &&
    s.split(".").every((n) => parseInt(n) <= 255)
  );
}

function detectTimingPattern(rows) {
  const hasTimingCols =
    rows.length > 0 &&
    ("startdate" in rows[0] ||
      "startdatetime" in rows[0] ||
      "starttime" in rows[0] ||
      "enddatetime" in rows[0]);
  if (!hasTimingCols)
    return {
      mode: "none",
      defaultStart: null,
      defaultEnd: null,
      rowTimings: rows.map(() => ({ s: null, e: null })),
    };
  const rowTimings = rows.map((r) => {
    let s = null,
      e = null;
    if (r.startdatetime) s = parseDateTime(r.startdatetime, "");
    else if (r.startdate || r.starttime)
      s = parseDateTime(r.startdate || "", r.starttime || "");
    if (r.enddatetime) e = parseDateTime(r.enddatetime, "");
    else if (r.enddate || r.endtime)
      e = parseDateTime(r.enddate || "", r.endtime || "");
    return { s, e };
  });
  const filled = rowTimings.filter(
    (t) => t.s && !isNaN(t.s) && t.e && !isNaN(t.e),
  );
  if (filled.length === 1 && rowTimings[0].s && !isNaN(rowTimings[0].s)) {
    if (rowTimings.slice(1).every((t) => !t.s || isNaN(t.s)))
      return {
        mode: "default",
        defaultStart: rowTimings[0].s,
        defaultEnd: rowTimings[0].e,
        rowTimings,
      };
  }
  if (!filled.length)
    return { mode: "none", defaultStart: null, defaultEnd: null, rowTimings };
  const keys = filled.map((t) => fmtDT(t.s) + "|" + fmtDT(t.e));
  const uniqueKeys = [...new Set(keys)];
  if (uniqueKeys.length === 1 && filled.length === rowTimings.length)
    return {
      mode: "uniform",
      defaultStart: filled[0].s,
      defaultEnd: filled[0].e,
      rowTimings,
    };
  return { mode: "grouped", defaultStart: null, defaultEnd: null, rowTimings };
}

function bulkValidateRows(rawRows, fname) {
  bulkSetProgress(40, "VALIDATING...");
  _parseLog.length = 0;
  if (rawRows.length > 10000) {
    showToast("Truncating to 10,000 rows");
    rawRows = rawRows.slice(0, 10000);
  }
  const timing = detectTimingPattern(rawRows);
  document.getElementById("bulk-timing-override").style.display =
    timing.mode === "none" ? "block" : "none";
  const maxDurHrs =
    parseFloat(document.getElementById("bulk-max-dur").value) || 0;
  const records = [],
    previewRows = [];
  rawRows.forEach((r, idx) => {
    const rowNum = idx + 2;
    const errors = [],
      warnings = [];
    const hostname = (r.hostname || "").trim();
    if (!hostname) errors.push("Missing HostName");
    const ip = (r.ipaddress || "").trim();
    if (ip && !isValidIP(ip)) errors.push(`Invalid IP: ${ip}`);
    let { s: startDT, e: endDT } = timing.rowTimings[idx];
    if (timing.mode === "default") {
      startDT = timing.defaultStart;
      endDT = timing.defaultEnd;
    }
    const rawStart =
      r.startdatetime ||
      (r.startdate || "") + (r.starttime ? " " + r.starttime : "");
    const rawEnd =
      r.enddatetime || (r.enddate || "") + (r.endtime ? " " + r.endtime : "");
    if (timing.mode !== "none") {
      if (!startDT || isNaN(startDT))
        errors.push(parseDateTimeError(rawStart, "StartDateTime", rowNum));
      if (!endDT || isNaN(endDT))
        errors.push(parseDateTimeError(rawEnd, "EndDateTime", rowNum));
      if (startDT && endDT && !isNaN(startDT) && !isNaN(endDT)) {
        if (endDT <= startDT) errors.push("End must be after Start");
        const dur = (endDT - startDT) / 3600000;
        if (dur === 0) errors.push("Zero duration");
        if (maxDurHrs > 0 && dur > maxDurHrs)
          errors.push(`Duration ${dur.toFixed(1)}h exceeds max ${maxDurHrs}h`);
      }
    }
    if (timing.mode === "grouped" && (!startDT || isNaN(startDT || NaN)))
      errors.push("Missing timing");
    const rowClient = (r.clientname || "").trim();
    if (hasUnsafeQuote(hostname))
      errors.push('HostName contains an invalid " character');
    if (rowClient && hasUnsafeQuote(rowClient))
      errors.push('ClientName contains an invalid " character');
    else if (rowClient && !clients.includes(rowClient))
      warnings.push(`Unknown client: ${rowClient}`);
    if (rawStart.trim())
      previewRows.push({
        orig: rawStart.trim(),
        parsed: startDT && !isNaN(startDT) ? fmtDT(startDT) : null,
        fail: !startDT || isNaN(startDT),
      });
    if (rawEnd.trim())
      previewRows.push({
        orig: rawEnd.trim(),
        parsed: endDT && !isNaN(endDT) ? fmtDT(endDT) : null,
        fail: !endDT || isNaN(endDT),
      });
    records.push({
      rowNum,
      hostname,
      ip,
      startDT,
      endDT,
      rowClient,
      errors,
      warnings,
      status: errors.length ? "ERROR" : warnings.length ? "WARN" : "OK",
    });
  });
  // Duplicate detection
  const seen = {};
  for (const r of records) {
    const key = `${r.hostname.toLowerCase()}|${fmtDT(r.startDT)}|${fmtDT(r.endDT)}`;
    if (seen[key]) r.warnings.push("Duplicate entry");
    else seen[key] = true;
  }
  // Overlap
  const byHost = {};
  for (const r of records.filter((r) => r.status !== "ERROR" && r.startDT)) {
    const h = r.hostname.toLowerCase();
    (byHost[h] = byHost[h] || []).push(r);
  }
  for (const [, group] of Object.entries(byHost)) {
    group.sort((a, b) => a.startDT - b.startDT);
    for (let i = 0; i < group.length - 1; i++) {
      if (
        group[i].endDT &&
        group[i + 1].startDT &&
        group[i].endDT > group[i + 1].startDT
      ) {
        group[i].warnings.push("Overlaps with row " + group[i + 1].rowNum);
        group[i + 1].warnings.push("Overlaps with row " + group[i].rowNum);
        if (group[i].status === "OK") group[i].status = "WARN";
        if (group[i + 1].status === "OK") group[i + 1].status = "WARN";
      }
    }
  }
  for (const r of records) {
    if (r.errors.length) r.status = "ERROR";
    else if (r.warnings.length) r.status = "WARN";
  }
  bulkRecords = records;
  const total = records.length,
    valid = records.filter((r) => r.status !== "ERROR").length,
    invalid = records.filter((r) => r.status === "ERROR").length,
    warn = records.filter((r) => r.status === "WARN").length;
  const usEl = document.getElementById("bulk-upload-status");
  usEl.style.display = "flex";
  usEl.innerHTML = `<div class="us-item"><span class="us-key">FILE</span><span class="us-val">${esc(fname)}</span></div><div class="us-item"><span class="us-key">TOTAL</span><span class="us-val">${total}</span></div><div class="us-item"><span class="us-key">VALID</span><span class="us-val">${valid}</span></div>${invalid ? `<div class="us-item"><span class="us-key">ERRORS</span><span class="us-val bad">${invalid}</span></div>` : ""}${warn ? `<div class="us-item"><span class="us-key">WARNINGS</span><span class="us-val warn">${warn}</span></div>` : ""}`;
  bulkSetProgress(55, "TIMING ANALYSIS...");
  renderGroupingPanel(timing, records);
  bulkSetProgress(65, "PREVIEW...");
  renderParsedPreview(previewRows);
  if (document.getElementById("bulk-debug-mode")?.checked) renderDebugLog();
  bulkSetProgress(75, "VALIDATION COMPLETE");
  renderBulkValGrid(records);
  bulkSetProgress(85, "READY");
  showToast(`${fname} \u2014 ${valid}/${total} valid`);
  bulkRecords._timingMode = timing.mode;
  bulkRecords._timingDefault = { s: timing.defaultStart, e: timing.defaultEnd };
}

function renderGroupingPanel(timing, records) {
  const anchor = document.getElementById("bulk-grouping-anchor");
  const modeInfo = {
    none: {
      cls: "gm-default",
      label: "BASIC TEMPLATE",
      desc: "No scheduling columns. Scripts generated for all hostnames. Optionally enter a timing window above.",
    },
    default: {
      cls: "gm-default",
      label: "DEFAULT TIMING",
      desc: "First row timing applied to all hosts as one group.",
    },
    uniform: {
      cls: "gm-uniform",
      label: "UNIFORM TIMING",
      desc: "All rows share identical timing — combined into one group.",
    },
    grouped: {
      cls: "gm-grouped",
      label: "TIME-BASED GROUPS",
      desc: "Rows have different timings — scripts separated by schedule group.",
    },
  };
  const info = modeInfo[timing.mode] || modeInfo.grouped;
  let previewHtml = "";
  if (timing.mode === "grouped") {
    const groupMap = {};
    for (const r of records.filter((r) => r.status !== "ERROR" && r.startDT)) {
      const key = fmtDT(r.startDT) + "|" + fmtDT(r.endDT);
      (groupMap[key] = groupMap[key] || {
        s: r.startDT,
        e: r.endDT,
        hosts: [],
      }).hosts.push(r.hostname);
    }
    const groups = Object.values(groupMap).sort((a, b) => a.s - b.s);
    previewHtml =
      `<div class="group-preview">` +
      groups
        .map(
          (g, i) =>
            `<div class="group-row"><span class="group-label">Group ${i + 1}</span><span class="group-time">${fmtDT(g.s)} \u2192 ${fmtDT(g.e)}</span><span class="group-hosts">${g.hosts.slice(0, 5).map(esc).join(", ")}${g.hosts.length > 5 ? " +" + (g.hosts.length - 5) + " more" : ""}</span><span class="group-count">${g.hosts.length} host${g.hosts.length === 1 ? "" : "s"}</span></div>`,
        )
        .join("") +
      `</div>`;
  } else if (timing.mode === "default" || timing.mode === "uniform") {
    const s = timing.defaultStart,
      e = timing.defaultEnd;
    const allHosts = records
      .filter((r) => r.status !== "ERROR")
      .map((r) => r.hostname);
    previewHtml = `<div class="group-preview"><div class="group-row"><span class="group-label">All hosts</span><span class="group-time">${fmtDT(s)} \u2192 ${fmtDT(e)}</span><span class="group-hosts">${allHosts.slice(0, 6).map(esc).join(", ")}${allHosts.length > 6 ? " +" + (allHosts.length - 6) + " more" : ""}</span><span class="group-count">${allHosts.length} host${allHosts.length === 1 ? "" : "s"}</span></div></div>`;
  }
  anchor.innerHTML = `<div class="grouping-panel"><span class="grouping-mode ${info.cls}">${info.label}</span><div class="grouping-desc">${info.desc}</div>${previewHtml}</div>`;
}

function renderParsedPreview(previewRows) {
  const anchor = document.getElementById("bulk-preview-anchor");
  if (!previewRows.length) {
    anchor.innerHTML = "";
    return;
  }
  const seen = new Set(),
    unique = [];
  for (const p of previewRows) {
    if (!seen.has(p.orig)) {
      seen.add(p.orig);
      unique.push(p);
    }
  }
  if (!unique.length) {
    anchor.innerHTML = "";
    return;
  }
  const rowsHtml = unique
    .map((p) => {
      const parsedText = p.fail
        ? `<span style="color:var(--fail)">&#10005; Failed</span>`
        : esc(p.parsed || "\u2014");
      return `<div class="pp-row"><span class="pp-orig">${esc(p.orig)}</span><span class="pp-arr">\u2192</span><span class="pp-parsed ${p.fail ? "fail" : ""}">${parsedText}</span></div>`;
    })
    .join("");
  anchor.innerHTML = `<div class="card" id="bulk-preview-card"><div class="collapsible-header" onclick="toggleCollapse('bulk-preview-body','bulk-preview-toggle')"><div class="card-title cyan" style="margin:0">Parsed Date/Time Preview</div><span class="collapse-toggle" id="bulk-preview-toggle">[collapse]</span></div><div class="collapsible-body" id="bulk-preview-body" style="max-height:600px;"><div class="parse-preview" style="margin-top:12px;"><div class="pp-row pp-head"><span>Original Value</span><span></span><span>Interpreted As</span></div>${rowsHtml}</div></div></div>`;
}

function renderDebugLog() {
  const anchor = document.getElementById("bulk-preview-anchor");
  if (!_parseLog.length) return;
  const logHtml = _parseLog
    .map((e) => `Input: ${e.input}\nParsed As: ${e.result}`)
    .join("\n\n");
  const existing = document.getElementById("bulk-debug-card");
  if (existing) existing.remove();
  const div = document.createElement("div");
  div.id = "bulk-debug-card";
  div.innerHTML = `<div class="card" style="margin-top:0;"><div class="card-title" style="margin-bottom:8px;">Debug Log</div><div class="debug-log">${esc(logHtml)}</div></div>`;
  anchor.appendChild(div);
}

function toggleCollapse(bodyId, toggleId, forceCollapsed) {
  const body = document.getElementById(bodyId);
  const toggle = document.getElementById(toggleId);
  if (!body) return;
  const willCollapse =
    forceCollapsed !== undefined
      ? forceCollapsed
      : !body.classList.contains("collapsed");
  if (willCollapse) {
    body.style.maxHeight = body.scrollHeight + "px";
    requestAnimationFrame(() => {
      body.style.maxHeight = "0";
      body.classList.add("collapsed");
    });
    if (toggle) toggle.textContent = "[expand]";
  } else {
    body.classList.remove("collapsed");
    body.style.maxHeight = body.scrollHeight + "px";
    setTimeout(() => {
      body.style.maxHeight = "none";
    }, 300);
    if (toggle) toggle.textContent = "[collapse]";
  }
}

function copyToClipboard(text, successMsg) {
  successMsg = successMsg || "Copied!";
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(() => showToast(successMsg))
      .catch(() => copyFallback(text, successMsg));
  } else {
    copyFallback(text, successMsg);
  }
}
function copyFallback(text, msg) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0;top:0;left:0;";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand("copy");
    showToast(msg);
  } catch (e) {
    showToast("Copy not supported");
  }
  document.body.removeChild(ta);
}

function renderBulkValGrid(records) {
  const anchor = document.getElementById("bulk-val-anchor");
  if (!records.length) {
    anchor.innerHTML = "";
    return;
  }
  const rowsHtml = records
    .map((r) => {
      const sc =
        r.status === "ERROR"
          ? "var(--fail)"
          : r.status === "WARN"
            ? "var(--warn)"
            : "var(--pass)";
      const issues = [
        ...r.errors.map(
          (e) => `<span style="color:var(--fail)">${esc(e)}</span>`,
        ),
        ...r.warnings.map(
          (w) => `<span style="color:var(--warn)">${esc(w)}</span>`,
        ),
      ].join("<br>");
      const fix = r.errors.length
        ? "Correct field(s)"
        : r.warnings.length
          ? "Review"
          : "\u2014";
      return `<div class="bvg-row"><span style="color:var(--text3)">${r.rowNum}</span><span style="color:${sc};font:700 9px var(--display);letter-spacing:1px">${r.status}</span><span style="font:11px var(--mono);color:var(--text2)">${esc(r.hostname || "\u2014")}<br><span style="color:var(--text3);font-size:10px">${esc(r.ip || "")} ${r.startDT ? fmtDT(r.startDT) : ""} ${r.endDT ? "\u2192 " + fmtDT(r.endDT) : ""}</span>${issues ? "<br>" + issues : ""}</span><span style="font:10px var(--mono);color:var(--text3)">${fix}</span></div>`;
    })
    .join("");
  anchor.innerHTML = `<div class="card" id="bulk-val-card"><div class="collapsible-header" onclick="toggleCollapse('bulk-val-body','bulk-val-toggle')"><div class="card-title cyan" style="margin:0">Validation Report</div><span class="collapse-toggle" id="bulk-val-toggle">[collapse]</span></div><div class="collapsible-body" id="bulk-val-body" style="max-height:900px;"><div class="table-wrap" style="border-radius:var(--radius);margin-top:12px;"><div class="bvg-row bvg-head"><span>#</span><span>STATUS</span><span>RECORD</span><span>SUGGESTED FIX</span></div>${rowsHtml}</div></div></div>`;
}

function bulkGenerate() {
  const clientSel = document.getElementById("bulk-client").value;
  if (!clientSel) {
    showToast("Select a client first", "warn");
    flagInvalid("bulk-client");
    return;
  }
  if (!bulkRecords.length) {
    showToast("Upload a file first", "warn");
    flagInvalid("bulkDropZone");
    return;
  }
  const timingMode = bulkRecords._timingMode || "none";
  const bulkFid =
    document.getElementById("bulk-format-select")?.value ||
    queryFormats[0]?.id ||
    "f1";
  const bulkDesc =
    document.getElementById("bulk-description")?.value.trim() || "";
  if (formatSupportsDescription(bulkFid) && !bulkDesc) {
    showToast("Selected format requires a Description value", "warn");
    flagInvalid("bulk-description");
    return;
  }
  if (hasUnsafeQuote(bulkDesc)) {
    showToast(
      'Description cannot contain a " character - remove it and try again',
      "warn",
    );
    flagInvalid("bulk-description");
    return;
  }
  let globalStart = null,
    globalEnd = null;
  if (timingMode === "none") {
    const rawS = document.getElementById("bulk-default-start").value.trim();
    const rawE = document.getElementById("bulk-default-end").value.trim();
    if (rawS || rawE) {
      globalStart = parseDateTime(rawS, "");
      globalEnd = parseDateTime(rawE, "");
      if (rawS && (!globalStart || isNaN(globalStart))) {
        showToast("\u26a0 Start format not recognised", "error");
        return;
      }
      if (rawE && (!globalEnd || isNaN(globalEnd))) {
        showToast("\u26a0 End format not recognised", "error");
        return;
      }
      if (globalStart && globalEnd && globalEnd <= globalStart) {
        showToast("\u26a0 End must be after Start", "error");
        return;
      }
    }
  }
  const workingRecords = bulkRecords.map((r) => {
    const rec = { ...r };
    if (timingMode === "none") {
      rec.startDT = globalStart || null;
      rec.endDT = globalEnd || null;
    }
    if (timingMode === "default") {
      rec.startDT = bulkRecords._timingDefault.s;
      rec.endDT = bulkRecords._timingDefault.e;
    }
    return rec;
  });
  const validRecs = workingRecords.filter((r) => r.status !== "ERROR");
  if (!validRecs.length) {
    showToast("No valid records", "error");
    return;
  }
  bulkSetProgress(87, "GENERATING...");
  const MAX = parseInt(document.getElementById("bulk-max-slots").value) || 10;
  const ipRe = /^(\d{1,3}\.){3}\d{1,3}$/,
    suffix = getFqdnSuffix();
  function buildSlots(rec) {
    const hosts = [],
      ips = [];
    if (rec.hostname) {
      if (ipRe.test(rec.hostname)) ips.push(rec.hostname);
      else hosts.push(rec.hostname);
    }
    if (rec.ip && isValidIP(rec.ip)) ips.push(rec.ip);
    const upper = [],
      lower = [],
      asIs = [];
    for (const h of hosts) {
      const isMixed = h !== h.toUpperCase() && h !== h.toLowerCase(),
        hasDot = h.includes(".");
      if (hasDot) {
        const bare = h.split(".")[0];
        upper.push(h.toUpperCase(), bare.toUpperCase());
        lower.push(h.toLowerCase(), bare.toLowerCase());
        if (isMixed) asIs.push(h, bare);
      } else if (suffix) {
        const full = h + suffix;
        upper.push(full.toUpperCase(), h.toUpperCase());
        lower.push(full.toLowerCase(), h.toLowerCase());
        if (isMixed) asIs.push(full, h);
      } else {
        upper.push(h.toUpperCase());
        lower.push(h.toLowerCase());
        if (isMixed) asIs.push(h);
      }
    }
    return [...upper, ...lower, ...asIs, ...ips];
  }
  bulkGroups = [];
  if (
    timingMode === "none" ||
    timingMode === "default" ||
    timingMode === "uniform"
  ) {
    const allSlots = [];
    validRecs.forEach((rec) => allSlots.push(...buildSlots(rec)));
    const deduped = [...new Set(allSlots)];
    const clientName = validRecs[0].rowClient || clientSel;
    const queries = chunkArr(deduped, MAX).map((items) =>
      renderFormatQuery(bulkFid, clientName, items, bulkDesc),
    );
    const startDT =
      timingMode === "none" ? globalStart : validRecs[0].startDT || null;
    const endDT =
      timingMode === "none" ? globalEnd : validRecs[0].endDT || null;
    bulkGroups.push({
      label: "Group 1",
      mode:
        timingMode === "uniform"
          ? "UNIFORM TIMING"
          : timingMode === "default"
            ? "DEFAULT TIMING"
            : globalStart
              ? "GLOBAL TIMING"
              : "BASIC (NO TIMING)",
      startDT,
      endDT,
      records: validRecs,
      queries,
      clientName,
    });
  } else {
    const groupMap = {};
    for (const rec of validRecs) {
      if (!rec.startDT || isNaN(rec.startDT)) continue;
      const key = fmtDT(rec.startDT) + "|" + fmtDT(rec.endDT);
      if (!groupMap[key])
        groupMap[key] = { startDT: rec.startDT, endDT: rec.endDT, records: [] };
      groupMap[key].records.push(rec);
    }
    Object.keys(groupMap)
      .sort((a, b) => groupMap[a].startDT - groupMap[b].startDT)
      .forEach((key, gi) => {
        const grp = groupMap[key];
        const allSlots = [];
        grp.records.forEach((rec) => allSlots.push(...buildSlots(rec)));
        const deduped = [...new Set(allSlots)];
        const clientName = grp.records[0].rowClient || clientSel;
        const queries = chunkArr(deduped, MAX).map((items) =>
          renderFormatQuery(bulkFid, clientName, items, bulkDesc),
        );
        bulkGroups.push({
          label: `Group ${gi + 1}`,
          mode: "TIME WINDOW",
          startDT: grp.startDT,
          endDT: grp.endDT,
          records: grp.records,
          queries,
          clientName,
        });
      });
  }
  bulkScripts = [];
  for (const grp of bulkGroups) {
    for (const rec of grp.records) {
      bulkScripts.push({
        rec: { ...rec, startDT: grp.startDT, endDT: grp.endDT },
        queries: chunkArr([...new Set(buildSlots(rec))], MAX).map((items) =>
          renderFormatQuery(bulkFid, grp.clientName, items, bulkDesc),
        ),
        clientName: grp.clientName,
        groupLabel: grp.label,
      });
    }
  }
  bulkSetProgress(95, "VALIDATING OUTPUT...");
  const allLines = bulkGroups.flatMap((g) => g.queries);
  runValidation("inline", allLines.join("\n"), bulkFid);
  bulkSetProgress(100, "COMPLETE");
  renderBulkOutput();
  const totalQ = bulkGroups.reduce((s, g) => s + g.queries.length, 0);
  saveHistory(
    clientSel,
    MAX,
    suffix,
    `[BULK] ${validRecs.length} records`,
    totalQ,
    {
      isBulk: true,
      fileName:
        document.getElementById("bulkFileInput").files[0]?.name || "bulk",
    },
  );
  showToast(
    `${totalQ} scripts in ${bulkGroups.length} group${bulkGroups.length === 1 ? "" : "s"} from ${validRecs.length} records`,
    "success",
  );
}

function renderBulkOutput() {
  const anchor = document.getElementById("bulk-output-anchor");
  if (!bulkGroups.length) {
    anchor.innerHTML = "";
    return;
  }
  const MAX_LABEL = document.getElementById("bulk-max-slots").value;
  const groupsHtml = bulkGroups
    .map((grp, gi) => {
      const dur =
        grp.startDT && grp.endDT
          ? ((grp.endDT - grp.startDT) / 3600000).toFixed(1) + "h"
          : "\u2014";
      const headerHtml = `<div class="bulk-group-header"><span class="bgh-label">${esc(grp.label)}</span><span class="bgh-time">${fmtDT(grp.startDT)} \u2192 ${fmtDT(grp.endDT)} (${dur})</span><span style="font:500 10px var(--mono);color:var(--text3)">${grp.mode}</span><span class="bgh-count">${grp.queries.length} QUER${grp.queries.length === 1 ? "Y" : "IES"} &middot; ${grp.records.length} HOST${grp.records.length === 1 ? "" : "S"}</span><button class="query-copy-btn" id="grp-copy-${gi}" onclick="bulkCopyGroup(${gi})">&#8853; Copy Group</button></div>`;
      const queriesHtml = grp.queries
        .map((q, qi) => {
          const btnId = `qcopy_${gi}_${qi}`;
          return `<div class="query-block" style="margin-bottom:8px;"><div class="query-meta"><span class="qbadge qbadge-combined">${esc(grp.label)}_${qi + 1}</span><span style="color:var(--text3)">${(q.match(/","/g) || []).length + 1}/${MAX_LABEL} slots</span><button class="query-copy-btn" id="${btnId}" onclick="bulkCopyQuery(${gi},${qi},'${btnId}')">&#8853; Copy</button></div><pre>${esc(q)}</pre></div>`;
        })
        .join("");
      return headerHtml + queriesHtml;
    })
    .join("");
  const totalQ = bulkGroups.reduce((s, g) => s + g.queries.length, 0);
  anchor.innerHTML = `<div class="card bulk-output-active" id="bulk-output-card"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:14px;"><div class="card-title" style="margin:0">&#9647; Generated Scripts</div><span style="font:500 10px var(--mono);color:var(--text3)">${totalQ} scripts &middot; ${bulkGroups.length} group${bulkGroups.length === 1 ? "" : "s"} &middot; ${bulkGroups.reduce((s, g) => s + g.records.length, 0)} hosts</span></div>${groupsHtml}<div class="bulk-action-bar"><button class="btn btn-cyan btn-sm" onclick="bulkCopyAll()">&#8853; Copy All Scripts</button><button class="btn btn-fix btn-sm" onclick="bulkExport('txt')">&#8681; .txt</button><button class="btn btn-fix btn-sm" onclick="bulkExport('sh')">&#8681; .sh</button><button class="btn btn-fix btn-sm" onclick="bulkExport('bat')">&#8681; .bat</button><button class="btn btn-fix btn-sm" onclick="bulkExport('csv')">&#8681; .csv</button><button class="btn btn-secondary btn-sm" onclick="bulkExportReport()">&#8681; Report</button></div></div>`;
  toggleCollapse("bulk-val-body", "bulk-val-toggle", true);
  setTimeout(() => {
    const card = document.getElementById("bulk-output-card");
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      setTimeout(() => card.classList.remove("bulk-output-active"), 3000);
    }
  }, 120);
}

function bulkCopyQuery(gi, qi, btnId) {
  const q = bulkGroups[gi]?.queries[qi];
  if (!q) return;
  copyToClipboard(q, "Script copied");
  const btn = document.getElementById(btnId);
  if (btn) {
    btn.textContent = "Copied!";
    btn.classList.add("done");
    setTimeout(() => {
      btn.textContent = "\u2295 Copy";
      btn.classList.remove("done");
    }, 2000);
  }
}
function bulkCopyGroup(gi) {
  const grp = bulkGroups[gi];
  if (!grp) return;
  copyToClipboard(grp.queries.join("\n\n"), `${grp.label} copied`);
  const btn = document.getElementById("grp-copy-" + gi);
  if (btn) {
    btn.textContent = "Copied!";
    btn.classList.add("done");
    setTimeout(() => {
      btn.textContent = "\u2295 Copy Group";
      btn.classList.remove("done");
    }, 2000);
  }
}
function bulkCopyAll() {
  const all = bulkGroups.flatMap((g) => g.queries).join("\n\n");
  copyToClipboard(
    all,
    `All ${bulkGroups.reduce((s, g) => s + g.queries.length, 0)} scripts copied`,
  );
}

function bulkExport(fmt) {
  if (!bulkGroups.length) {
    showToast("Nothing to export");
    return;
  }
  let content = "",
    mime = "text/plain",
    ext = fmt;
  if (fmt === "txt") {
    content = bulkGroups
      .map(
        (grp) =>
          `# ${grp.label} | ${fmtDT(grp.startDT)} \u2192 ${fmtDT(grp.endDT)} | ${grp.records.length} hosts\n` +
          grp.queries.join("\n"),
      )
      .join("\n\n");
  } else if (fmt === "sh") {
    content =
      "#!/bin/bash\n# QueryTool v5.2\n\n" +
      bulkGroups
        .map(
          (grp) =>
            `# ${grp.label} | ${fmtDT(grp.startDT)} \u2192 ${fmtDT(grp.endDT)}\n` +
            grp.queries
              .map((q) => `echo '${q.replace(/'/g, "'\\''")}'`)
              .join("\n"),
        )
        .join("\n\n");
    mime = "text/x-sh";
  } else if (fmt === "bat") {
    content =
      "@echo off\nREM QueryTool v5.2\n\n" +
      bulkGroups
        .map(
          (grp) =>
            `REM ${grp.label} | ${fmtDT(grp.startDT)} -> ${fmtDT(grp.endDT)}\n` +
            grp.queries
              .map((q) => `echo ${q.replace(/[&<>|^]/g, "^$&")}`)
              .join("\n"),
        )
        .join("\n\n");
  } else if (fmt === "csv") {
    const bulkFid =
      document.getElementById("bulk-format-select")?.value ||
      queryFormats[0]?.id ||
      "f1";
    const bulkDesc =
      document.getElementById("bulk-description")?.value.trim() || "";
    const rows = [
      [
        "Group",
        "Row",
        "HostName",
        "IP",
        "StartDateTime",
        "EndDateTime",
        "QueryIndex",
        "Script",
      ],
    ];
    bulkGroups.forEach((grp) => {
      grp.records.forEach((rec) => {
        const allS = [
          rec.hostname.toUpperCase(),
          rec.hostname.toLowerCase(),
          ...(rec.ip && isValidIP(rec.ip) ? [rec.ip] : []),
        ];
        chunkArr(
          allS,
          parseInt(document.getElementById("bulk-max-slots").value) || 10,
        ).forEach((items, qi) => {
          const q = renderFormatQuery(bulkFid, grp.clientName, items, bulkDesc);
          rows.push([
            grp.label,
            rec.rowNum,
            csvSafeValue(rec.hostname),
            csvSafeValue(rec.ip),
            fmtDT(grp.startDT),
            fmtDT(grp.endDT),
            qi + 1,
            `"${csvSafeValue(q).replace(/"/g, '""')}"`,
          ]);
        });
      });
    });
    content = rows.map((r) => r.join(",")).join("\n");
    mime = "text/csv";
    ext = "csv";
  }
  const blob = new Blob([content], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bulk_scripts.${ext}`;
  a.click();
  showToast(`bulk_scripts.${ext} downloaded`);
}

function bulkExportReport() {
  if (!bulkRecords.length) {
    showToast("No validation data");
    return;
  }
  const rows = [
    [
      "Row",
      "HostName",
      "IP",
      "StartDateTime",
      "EndDateTime",
      "Group",
      "Status",
      "Errors",
      "Warnings",
    ],
  ];
  bulkRecords.forEach((r) => {
    const gl =
      bulkScripts.find((s) => s.rec.rowNum === r.rowNum)?.groupLabel || "";
    rows.push([
      r.rowNum,
      r.hostname,
      r.ip,
      fmtDT(r.startDT),
      fmtDT(r.endDT),
      gl,
      r.status,
      r.errors.join("; "),
      r.warnings.join("; "),
    ]);
  });
  const csv = rows
    .map((r) =>
      r.map((v) => `"${csvSafeValue(v).replace(/"/g, '""')}"`).join(","),
    )
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "bulk_validation_report.csv";
  a.click();
  showToast("Report downloaded");
}

function bulkDownloadTemplate(type) {
  let csv, fname;
  if (type === "basic") {
    csv = [
      "HostName,IPAddress",
      "SERVER01,192.168.1.10",
      "server02.corp.local,",
      "WEBHOST03,10.20.30.40",
      "DB-SERVER04,",
    ].join("\n");
    fname = "bulk_template_basic.csv";
  } else {
    csv = [
      "HostName,IPAddress,StartDate,StartTime,EndDate,EndTime,ClientName",
      "SERVER01,192.168.1.10,23/05/2026,10:30 PM IST,23/05/2026,11:30 PM IST,",
      "server02.corp.local,,23/05/2026,10:30 PM IST,23/05/2026,11:30 PM IST,",
      "WEBHOST03,10.20.30.40,24/05/2026,02:00 PM,24/05/2026,06:00 PM,",
      "DB-SERVER04,,25/05/2026,09:00 AM,25/05/2026,11:00 AM,",
    ].join("\n");
    fname = "bulk_template_advanced.csv";
  }
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  a.click();
  showToast(`${fname} downloaded`);
}

function bulkSetProgress(pct, label) {
  const bar = document.getElementById("bulk-prog-bar"),
    lbl = document.getElementById("bulk-prog-label");
  if (bar) bar.style.width = pct + "%";
  if (lbl) lbl.textContent = label;
}

function bulkReset() {
  bulkRecords = [];
  bulkScripts = [];
  bulkGroups = [];
  _parseLog.length = 0;
  [
    "bulk-upload-status",
    "bulk-grouping-anchor",
    "bulk-preview-anchor",
    "bulk-val-anchor",
    "bulk-output-anchor",
    "inline-val-anchor",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.style.display = "";
      el.innerHTML = "";
    }
  });
  document.getElementById("bulk-upload-status").style.display = "none";
  document.getElementById("bulk-progress-wrap").style.display = "none";
  document.getElementById("bulk-prog-bar").style.width = "0%";
  document.getElementById("bulkFileInput").value = "";
  document.getElementById("bulk-timing-override").style.display = "none";
  showToast("Reset");
}

/* (bulk/adv/format init now happens once, in initApp()) */

/* KEYBOARD SHORTCUTS */
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "Enter") {
    if (document.getElementById("page-val").classList.contains("active"))
      runValidation("standalone");
    if (document.getElementById("page-adv-val").classList.contains("active"))
      runAdvancedValidation();
    if (document.getElementById("page-tool").classList.contains("active"))
      generate();
  }
  if (e.altKey) {
    const k = e.key.toLowerCase();
    if (k === "g") {
      e.preventDefault();
      generate();
    }
    if (k === "1") {
      e.preventDefault();
      switchTab("combined");
    }
    if (k === "2") {
      e.preventDefault();
      switchTab("upper");
    }
    if (k === "3") {
      e.preventDefault();
      switchTab("lower");
    }
    if (k === "4") {
      e.preventDefault();
      switchTab("ips");
    }
    if (k === "c") {
      e.preventDefault();
      if (document.getElementById("page-tool").classList.contains("active"))
        copyActiveTab();
    }
  }
});
