const T = window.__TAURI__;
const { invoke } = T.core;
const { listen } = T.event;
const $ = (id) => document.getElementById(id);

const RAM_OPTIONS = [1024, 2048, 3072, 4096, 6144, 8192];
const WORLD_COLOR = "#475569";
const FOLDER_COLOR = "#92400e";
const PLUGIN_COLOR = "#1d4ed8";
const DEFAULT_ICON = "./assets/world-icon.png";
const ACCESS_HINTS = {
  verified:
    "Players must be signed in with a real Minecraft account. Needs an internet connection.",
  anyone:
    "Any username can join without an account check. Fine for playing on this PC.",
};
const VIS_HINTS = {
  local: "Only this computer can join the world.",
  lan: "Players on your Wi-Fi or router can see and join the world.",
};

// ---------------- Helpers ----------------
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stem = (f) => f.replace(/\.(zip|jar)$/i, "");
const countLabel = (n) => `${n} world${n === 1 ? "" : "s"}`;
const mcLabel = (v) =>
  !v ? "" : v.includes("older") ? `Minecraft ${v}` : `Minecraft v${v}`;

function makeCard(cls, color, title, sub, image) {
  const el = h("div", cls);
  const bg = h("div", "card-bg");
  bg.style.backgroundImage = image
    ? `url("${image}")`
    : `linear-gradient(135deg, ${color}, #18181b)`;
  const text = h("div", "card-text");
  text.append(h("span", "map-name", title));
  if (sub) text.append(h("span", "item-count", sub));
  el.append(bg, text);
  return el;
}

function fmtDate(s) {
  if (!s) return "";
  const d = new Date(s * 1000),
    p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}  ${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}
function makeRow(f, icon, dateKey) {
  const el = h("div", "row");
  if (icon) {
    const bg = h("div", "row-bg");
    bg.style.backgroundImage = `url("${icon}")`;
    el.append(bg);
  }
  el.append(
    h("span", null, stem(f.file)),
    h("span", null, f.kind),
    h("span", null, fmtDate(f[dateKey]))
  );
  return el;
}
function headRow(dateLabel) {
  const r = h("div", "row row-head");
  r.append(
    h("span", null, "File name"),
    h("span", null, "Type"),
    h("span", null, dateLabel)
  );
  return r;
}

const SORTS = ["name", "date", "type"];
const prefs = {
  plugins: { view: "list", sort: "name" },
  play: {
    view: localStorage.getItem("ssmc_view_play") === "list" ? "list" : "grid",
    sort: "name",
  },
  worlds: {
    view: localStorage.getItem("ssmc_view_worlds") === "list" ? "list" : "grid",
    sort: "name",
  },
};
const tabKey = () => (tab === "worlds" ? "worlds" : "play");
const sortFiles = (arr, dateKey) => {
  const s = tab === "plugins" ? "name" : prefs[tabKey()].sort;
  return [...arr].sort((a, b) =>
    s === "date"
      ? b[dateKey] - a[dateKey]
      : s === "type"
      ? a.kind.localeCompare(b.kind) || a.file.localeCompare(b.file)
      : a.file.localeCompare(b.file)
  );
};

function segmented(opts, value, onPick) {
  const seg = h("div", "segmented");
  opts.forEach(([val, label]) => {
    const b = h("button", `seg${val === value ? " active" : ""}`, label);
    b.type = "button";
    b.addEventListener("click", () => {
      seg
        .querySelectorAll(".seg")
        .forEach((x) => x.classList.toggle("active", x === b));
      onPick(val);
    });
    seg.append(b);
  });
  return seg;
}

// ---------------- Dialogs ----------------
const dialogEl = $("dialog");
function showDialog({
  title,
  text,
  ok = "OK",
  cancel = "Cancel",
  single = false,
}) {
  return new Promise((resolve) => {
    $("dialog-title").textContent = title;
    $("dialog-text").textContent = text;
    $("dialog-ok").textContent = ok;
    $("dialog-cancel").textContent = cancel;
    $("dialog-cancel").hidden = single;
    dialogEl.hidden = false;
    const done = (v) => {
      dialogEl.hidden = true;
      resolve(v);
    };
    $("dialog-ok").onclick = () => done(true);
    $("dialog-cancel").onclick = () => done(false);
    $("dialog-ok").focus();
  });
}
const askConfirm = (title, text, ok = "OK") => showDialog({ title, text, ok });
const message = (title, text) => showDialog({ title, text, single: true });

const busyStart = (text) =>
  window.dispatchEvent(new CustomEvent("busy-start", { detail: { text } }));
const busyEnd = () => window.dispatchEvent(new Event("busy-end"));

// ---------------- Library + versions ----------------
let library = { maps: [], folders: [], plugins: [] };
let links = {};
let versions = [];
let serverVersion = localStorage.getItem("ssmc_version") || "1.8.8";

async function refreshLibrary() {
  try {
    library = await invoke("list_library");
    links = await invoke("get_links");
  } catch (e) {
    console.warn("list_library:", e);
  }
}
async function refreshVersions() {
  try {
    versions = await invoke("list_versions");
  } catch (e) {
    console.warn("list_versions:", e);
  }
  if (versions.length && !versions.some((v) => v.version === serverVersion))
    serverVersion = versions[0].version;
}

async function importFiles(kind, folder = null) {
  let picked;
  try {
    picked = await T.dialog.open({
      multiple: true,
      filters: [
        kind === "map"
          ? { name: "World files (.zip)", extensions: ["zip"] }
          : { name: "Plugins (.jar)", extensions: ["jar"] },
      ],
    });
  } catch (e) {
    await message("Could not open the file picker", String(e));
    return;
  }
  if (!picked) return;
  const paths = (Array.isArray(picked) ? picked : [picked]).map((p) =>
    typeof p === "string" ? p : p.path
  );
  try {
    await invoke("import_files", { kind, folder: folder || null, paths });
  } catch (e) {
    await message("Import failed", String(e));
    return;
  }
  await refreshLibrary();
  render(true);
}

const openFolder = (kind, folder = null) =>
  invoke("open_library", { kind, folder: folder || null }).catch((e) =>
    message("Could not open the folder", String(e))
  );

const dl = { active: false, ver: "", text: "", percent: 0 };
function applyDl() {
  $("dl-progress").hidden = !dl.active;
  $("dl-status").textContent = dl.text;
  $("dl-fill").style.width = `${dl.percent}%`;
  applyLoading();
}
async function downloadServer(ver) {
  if (dl.active)
    return message(
      "Download in progress",
      `Server ${dl.ver} is still downloading.`
    );
  Object.assign(dl, {
    active: true,
    ver,
    percent: 0,
    text: `Downloading server ${ver}...`,
  });
  applyDl();
  try {
    await invoke("install_server", { version: ver });
  } catch (e) {
    dl.active = false;
    applyDl();
    await message("Could not download the server", String(e));
    return;
  }
  dl.active = false;
  applyDl();
  await refreshVersions();
  fillPlayVersions();
  render(true);
}

// ---------------- State ----------------
const gamesView = $("games-view");
const grid = $("grid");
const searchInput = $("search-input");
const startBtn = $("start-btn");
const verPlay = $("ver-play");
const plugBtn = $("plugin-btn");
const HELP =
  "After the server starts, SSMC is added to the top of your Minecraft multiplayer list automatically.\n\n" +
  "Players on the same local network join with your computer's IP address (port 25565).\n\n" +
  "If the server isn't added automatically, add it yourself in Minecraft using that IP address.";

let tab = "play";
let query = "";
let pquery = "";
let sel = { map: null, plugins: new Set() };
let lan = false;
let running = null; // { map, plugins, lan, version }
let ignoreExitUntil = 0;
let stopTyped = false;
let curFolder = null;
const openFolders = new Set();
let step = "pick"; // pick | plugins | ready
let stepInit = false;
const playNext = h("button", "primary-btn continue", "Continue");
playNext.type = "button";
playNext.hidden = true;
$("play-scroll").insertBefore(playNext, $("console-slot"));
const playPlugins = h("div", "list");
playPlugins.id = "play-plugins";
playPlugins.hidden = true;
$("play-scroll").insertBefore(
  playPlugins,
  document.querySelector(".controls-bar")
);
const playPluginsTitle = h(
  "h2",
  "maps-title plugins-step-title",
  "Choose plugins"
);
playPluginsTitle.hidden = true;
$("play-scroll").insertBefore(playPluginsTitle, playPlugins);
function updateNext() {
  playNext.hidden = !((step === "pick" && sel.map) || step === "plugins");
  playNext.textContent =
    step === "plugins" && !sel.plugins.size
      ? "Continue without plugins"
      : "Continue";
}
function updateContinues() {
  document
    .querySelectorAll("#tab-worlds .continue, #tab-plugins .continue")
    .forEach((b) => (b.hidden = true));
}
const footer = h("div", "app-footer");
footer.innerHTML =
  'Not affiliated with, approved by, or associated with Mojang or Microsoft. Minecraft is a trademark of Mojang AB. &nbsp;·&nbsp; <a href="#" id="site-link">noblecratemc.com</a>';
document.querySelector(".controls-bar").append(footer);
$("site-link").addEventListener("click", (e) => {
  e.preventDefault();
  T.opener.openUrl("https://noblecratemc.com").catch(console.error);
});

const playSummary = h("div", "play-summary");
$("play-scroll").insertBefore(playSummary, $("console-slot"));
function renderSummary() {
  playSummary.innerHTML = "";
  const w = library.maps.find((m) => m.rel === sel.map);
  if (!w) {
    playSummary.append(
      h("span", "sum-hint", "Select a world to start the server")
    );
    return;
  }
  const imgWrap = h("div", "sum-img");
  const img = document.createElement("img");
  img.src = w.icon || DEFAULT_ICON;
  imgWrap.append(img, h("span", "sum-img-label", "Selected world"));
  const info = h("div", "sum-info");
  info.append(
    h("span", "map-name", stem(w.file)),
    h("span", "item-count", mcLabel(w.version))
  );
  const pl = h("div", "sum-plugins");
  pl.append(h("span", "sum-plugins-title", "Selected plugins"));
  const chips = h("div", "sum-chips");
  if (sel.plugins.size)
    [...sel.plugins].forEach((p) =>
      chips.append(h("span", "sum-chip", stem(p.split("/").pop())))
    );
  else chips.append(h("span", "sum-chip", "No plugins"));
  pl.append(chips);
  playSummary.append(imgWrap, info, pl);
}
playNext.addEventListener("click", () => {
  step = step === "pick" ? "plugins" : "ready";
  saveLast();
  render();
});
const consoleLines = [];
let consoleEl = null;
function pushLog(l) {
  consoleLines.push(l);
  if (consoleLines.length > 500) consoleLines.shift();
  if (consoleEl) {
    consoleEl.append(h("div", null, l));
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }
}
listen("server-log", (e) => pushLog(String(e.payload)));
const curVer = () => (running ? running.version : serverVersion);
const LAST = "ssmc_last";
function saveLast() {
  try {
    if (sel.map)
      localStorage.setItem(
        LAST,
        JSON.stringify({ map: sel.map, plugins: [...sel.plugins] })
      );
    else localStorage.removeItem(LAST);
  } catch {}
}
function restoreLast() {
  try {
    const l = JSON.parse(localStorage.getItem(LAST) || "null");
    if (l && library.maps.some((m) => m.rel === l.map))
      sel = {
        map: l.map,
        plugins: new Set(
          (l.plugins || []).filter((p) =>
            library.plugins.some((x) => x.rel === p)
          )
        ),
      };
  } catch {}
}

// ---------------- Loading on the Play page ----------------
const loading = { active: false, text: "", percent: 0 };
let loadingCreep = null;

function applyLoading() {
  const info = versions.find((x) => x.version === curVer());
  const installed = !!(info && info.installed);
  $("start-progress").hidden = !loading.active;
  $("start-status").textContent = loading.text;
  $("start-fill").style.width = `${loading.percent}%`;
  const dling = dl.active && curVer() === dl.ver;
  startBtn.textContent = loading.active
    ? "Starting..."
    : dling
    ? "Downloading..."
    : running
    ? "Stop server"
    : installed
    ? `Start Server\n${curVer()}`
    : "Download Server";
  startBtn.className =
    (running && !loading.active ? "danger-btn" : "primary-btn") + " big-btn";
  const locked = !running && installed && step !== "ready";
  startBtn.disabled = loading.active || dling || locked;
  verPlay.disabled = plugBtn.disabled = loading.active || !!running;
}
function loadingStart(text) {
  loading.active = true;
  loading.text = text;
  loading.percent = 0;
  applyLoading();
}
function loadingSet(text, percent) {
  loading.text = text;
  if (percent != null) loading.percent = Math.max(loading.percent, percent);
  applyLoading();
}
function loadingEnd() {
  clearInterval(loadingCreep);
  loadingCreep = null;
  loading.active = false;
  applyLoading();
}
function startLoadingCreep() {
  clearInterval(loadingCreep);
  loadingCreep = setInterval(() => {
    if (loading.active && loading.percent < 95) {
      loading.percent += (95 - loading.percent) * 0.05;
      applyLoading();
    }
  }, 1000);
}
listen("setup-progress", (e) => {
  const { stage, label, percent } = e.payload;
  if (loading.active) {
    loadingSet(label, percent);
    if (stage === "starting") startLoadingCreep();
  } else if (dl.active) {
    dl.text = label;
    dl.percent = Math.max(dl.percent, percent || 0);
    applyDl();
  }
});

// ---------------- Navigation ----------------
const matches = (text) => !query || text.toLowerCase().includes(query);
const emptyNote = (text) => h("p", "empty-note", text);
function setQuery(q) {
  query = q;
  searchInput.value = q;
}
function setTab(t) {
  fFocus = null;
  bulk.map.clear();
  bulk.plugin.clear();
  tab = t;
  setQuery("");
  render();
}
async function resetAll() {
  if (loading.active) return;
  if (running) {
    const ok = await askConfirm(
      "Stop the server and reset?",
      "This stops the running server and clears the selected world and plugins.",
      "Stop and reset"
    );
    if (!ok) return;
    await stopServer();
  }
  localStorage.removeItem(LAST);
  sel = { map: null, plugins: new Set() };
  lan = false;
  curFolder = null;
  pquery = "";
  step = "pick";
  $("plugin-search").value = "";
  setTab("play");
}
function pickWorld(f) {
  if (running)
    return message(
      "A server is running",
      "Stop the server to choose another world."
    );
  sel.map = sel.map === f.rel ? null : f.rel;
  render();
}

const leaf = (p) => p.split("/").pop();
const parentOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const flist = (kind) =>
  kind === "map" ? library.folders : library.plugin_folders || [];
const filesOf = (kind) => (kind === "map" ? library.maps : library.plugins);
const subsOf = (kind, path) =>
  flist(kind).filter((d) => parentOf(d.name) === path);
const folderEmpty = (kind, d) => d.count === 0 && !subsOf(kind, d.name).length;
let fFocus = null; // {kind, path}: empty folder the user last clicked

function folderIcon(d) {
  const first = library.maps.find(
    (m) => m.folder === d.name || m.folder.startsWith(d.name + "/")
  );
  return d.icon || (first && first.icon) || DEFAULT_ICON;
}
const isPickedWorld = (f) =>
  tab === "worlds" ? bulk.map.has(f.rel) : sel.map === f.rel;
function clickWorld(f) {
  if (tab === "worlds") return toggleBulk("map", f.rel);
  pickWorld(f);
}
function worldCard(f) {
  const el = makeCard(
    "map-card world-card",
    WORLD_COLOR,
    stem(f.file),
    mcLabel(f.version),
    f.icon || DEFAULT_ICON
  );
  el.classList.toggle("picked", isPickedWorld(f));
  updateNext();
  el.addEventListener("click", () => clickWorld(f));
  el.addEventListener("contextmenu", (e) => itemMenu("map", f, e));
  return el;
}
function worldRow(f) {
  const el = makeRow(f, f.icon || DEFAULT_ICON, "created");
  el.classList.toggle("picked", isPickedWorld(f));
  el.addEventListener("click", () => clickWorld(f));
  el.addEventListener("contextmenu", (e) => itemMenu("map", f, e));
  return el;
}
function folderCard(d) {
  const el = makeCard(
    "map-card world-card",
    FOLDER_COLOR,
    leaf(d.name),
    countLabel(d.count),
    folderIcon(d)
  );
  el.addEventListener("click", () => {
    curFolder = d.name;
    bulk.map.clear();
    setQuery("");
    render();
  });
  el.addEventListener("contextmenu", (e) => folderMenu("map", d, e));
  return el;
}

// ---------------- Main screen: worlds + folders ----------------

function renderGames() {
  const view = prefs[tabKey()].view;
  grid.innerHTML = "";
  grid.className = view === "grid" ? "grid" : "list";
  if (curFolder && !library.folders.some((d) => d.name === curFolder))
    curFolder = null;
  $("folder-name").textContent = curFolder
    ? curFolder.split("/").join(" / ")
    : tab === "worlds"
    ? "Worlds"
    : "Choose a map";
  $("folder-bar").hidden = !curFolder;
  $("empty-state").hidden =
    library.maps.length > 0 || library.folders.length > 0;

  const inDir = (m, d) =>
    m.folder === d.name || m.folder.startsWith(d.name + "/");
  const dirVisible = (d) =>
    matches(leaf(d.name)) ||
    library.maps.some((m) => inDir(m, d) && matches(stem(m.file)));
  const kids = (path) =>
    library.maps.filter(
      (m) => m.folder === path && (matches(stem(m.file)) || matches(leaf(path)))
    );

  const addDirList = (d, level) => {
    const files = kids(d.name);
    const subs = subsOf("map", d.name).filter(dirVisible);
    const open =
      openFolders.has(d.name) || (!!query && (files.length || subs.length));
    const row = makeRow(
      { file: d.name, kind: "Folder", created: 0 },
      folderIcon(d),
      "created"
    );
    row.querySelector("span").textContent = `${open ? "▾" : "▸"} ${leaf(
      d.name
    )}`;
    if (level) row.classList.add("child");
    row.addEventListener("click", () => {
      bulk.map.clear();
      fFocus = folderEmpty("map", d) ? { kind: "map", path: d.name } : null;
      if (openFolders.has(d.name)) openFolders.delete(d.name);
      else openFolders.add(d.name);
      render(true);
    });
    row.addEventListener("contextmenu", (e) => folderMenu("map", d, e));
    grid.append(row);
    if (!open) return;
    subs.forEach((s) => addDirList(s, level + 1));
    sortFiles(files, "created").forEach((k) => {
      const r = worldRow(k);
      r.classList.add("child");
      grid.append(r);
    });
  };

  if (curFolder) {
    const subList = subsOf("map", curFolder).filter(dirVisible);
    const files = sortFiles(
      library.maps.filter((m) => m.folder === curFolder),
      "created"
    ).filter((m) => matches(stem(m.file)));
    if (view === "list" && (files.length || subList.length))
      grid.append(headRow("Date created"));
    if (!files.length && !subList.length)
      grid.append(
        h(
          "p",
          "folder-empty",
          query
            ? "No worlds match your search."
            : "This folder is empty.\nGo to the Worlds tab and import or add worlds to it."
        )
      );
    subList.forEach((d) => {
      if (view === "grid") return grid.append(folderCard(d));
      const row = makeRow(
        { file: d.name, kind: "Folder", created: 0 },
        folderIcon(d),
        "created"
      );
      row.querySelector("span").textContent = `▸ ${leaf(d.name)}`;
      row.addEventListener("click", () => {
        curFolder = d.name;
        bulk.map.clear();
        setQuery("");
        render();
      });
      row.addEventListener("contextmenu", (e) => folderMenu("map", d, e));
      grid.append(row);
    });
    files.forEach((f) =>
      grid.append(view === "grid" ? worldCard(f) : worldRow(f))
    );
    return;
  }

  const roots = sortFiles(
    library.maps.filter((m) => !m.folder),
    "created"
  ).filter((m) => matches(stem(m.file)));
  const dirs = library.folders.filter(
    (d) => !d.name.includes("/") && dirVisible(d)
  );
  if (view === "grid") {
    dirs.forEach((d) => grid.append(folderCard(d)));
    roots.forEach((f) => grid.append(worldCard(f)));
    return;
  }
  if (dirs.length || roots.length) grid.append(headRow("Date created"));
  dirs.forEach((d) => addDirList(d, 0));
  roots.forEach((f) => grid.append(worldRow(f)));
}

// ---------------- Plugins + render ----------------
function pluginLabel() {
  const n = sel.plugins.size;
  return n === 0
    ? "No plugins"
    : n === 1
    ? stem([...sel.plugins][0].split("/").pop())
    : `${n} plugins`;
}
const openPFolders = new Set();
function renderPlugins(list = $("plugin-list")) {
  list.innerHTML = "";
  const p = prefs.plugins;
  $(
    "plugin-sort"
  ).textContent = `Sort: ${p.sort[0].toUpperCase()}${p.sort.slice(1)}`;
  const inTab = list.id === "plugin-list";
  const pm = (f) => !pquery || stem(f.file).toLowerCase().includes(pquery);
  const order = (arr) =>
    [...arr].sort((a, b) =>
      p.sort === "date"
        ? b.modified - a.modified
        : p.sort === "type"
        ? a.kind.localeCompare(b.kind) || a.file.localeCompare(b.file)
        : a.file.localeCompare(b.file)
    );
  const inDir = (f, d) =>
    f.folder === d.name || f.folder.startsWith(d.name + "/");
  const nameHit = (d) => leaf(d.name).toLowerCase().includes(pquery);
  const dirVisible = (d) =>
    !pquery || nameHit(d) || library.plugins.some((f) => inDir(f, d) && pm(f));
  const kidsOf = (d) =>
    library.plugins.filter((f) => f.folder === d.name && (pm(f) || nameHit(d)));
  const roots = order(library.plugins.filter((f) => !f.folder && pm(f)));
  const dirs = (library.plugin_folders || []).filter(
    (d) => !d.name.includes("/") && dirVisible(d)
  );
  if (!roots.length && !dirs.length) {
    list.append(
      emptyNote(
        pquery
          ? "No plugins match your search."
          : "No plugins yet. Use Import to add .jar files."
      )
    );
    return;
  }
  const pluginRow = (f) => {
    const el = makeRow(f, null, "modified");
    el.classList.toggle(
      "picked",
      inTab ? bulk.plugin.has(f.rel) : sel.plugins.has(f.rel)
    );
    el.addEventListener("click", () => {
      if (inTab) return toggleBulk("plugin", f.rel);
      if (sel.plugins.has(f.rel)) sel.plugins.delete(f.rel);
      else sel.plugins.add(f.rel);
      el.classList.toggle("picked", sel.plugins.has(f.rel));
      updateNext();
    });
    if (inTab)
      el.addEventListener("contextmenu", (e) => itemMenu("plugin", f, e));
    return el;
  };
  const addDir = (d, level) => {
    const kids = kidsOf(d);
    const subs = subsOf("plugin", d.name).filter(dirVisible);
    const open =
      openPFolders.has(d.name) || (!!pquery && (kids.length || subs.length));
    const row = makeRow(
      { file: d.name, kind: "Folder", modified: 0 },
      d.icon,
      "modified"
    );
    row.querySelector("span").textContent = `${open ? "▾" : "▸"} ${leaf(
      d.name
    )}`;
    if (level) row.classList.add("child");
    row.addEventListener("click", () => {
      if (openPFolders.has(d.name)) openPFolders.delete(d.name);
      else openPFolders.add(d.name);
      if (inTab) {
        bulk.plugin.clear();
        fFocus = folderEmpty("plugin", d)
          ? { kind: "plugin", path: d.name }
          : null;
        render(true);
      } else renderPlugins(list);
    });
    if (inTab)
      row.addEventListener("contextmenu", (e) => folderMenu("plugin", d, e));
    list.append(row);
    if (!open) return;
    subs.forEach((s) => addDir(s, level + 1));
    order(kids).forEach((k) => {
      const r = pluginRow(k);
      r.classList.add("child");
      list.append(r);
    });
  };
  list.append(headRow("Date modified"));
  dirs.forEach((d) => addDir(d, 0));
  roots.forEach((f) => list.append(pluginRow(f)));
  updateNext();
  updateContinues();
  renderSummary();
}

function fillPlayVersions() {
  verPlay.innerHTML = "";
  versions.forEach((x) =>
    verPlay.add(
      new Option(
        x.installed ? x.version : `${x.version} (not downloaded)`,
        x.version
      )
    )
  );
  verPlay.value = curVer();
}
function renderConsole() {
  const slot = $("console-slot");
  slot.innerHTML = "";
  consoleEl = null;
  if (!running) return;
  const con = h("div", "console");
  con.append(h("div", "console-head", "Server Console"));
  const log = h("div", "console-log");
  consoleLines.forEach((l) => log.append(h("div", null, l)));
  const row = h("div", "console-row");
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "command (stop, reload, op name...)";
  input.spellcheck = false;
  const send = h("button", "console-send", "ENTER");
  send.type = "button";
  const submit = async () => {
    const c = input.value.trim().replace(/^\//, "");
    if (!c) return;
    input.value = "";
    if (/^stop$/i.test(c)) stopTyped = true;
    pushLog(`> ${c}`);
    try {
      await invoke("send_command", { command: c });
    } catch (e) {
      pushLog(String(e));
    }
  };
  send.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  row.append(input, send);
  con.append(log, row);
  slot.append(con);
  consoleEl = log;
  requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
}
function updateHero() {
  const w = library.maps.find((m) => m.rel === sel.map);
  const hero = $("hero");
  hero.classList.toggle("empty", !w);
  hero.style.backgroundImage = w ? `url("${w.icon || DEFAULT_ICON}")` : "none";
  $("hero-name").textContent = w
    ? stem(w.file)
    : "Select a world to start the server";
  $("hero-sub").textContent = w ? mcLabel(w.version) : "";
}
let pmq = "";
function buildPluginMenu() {
  const m = $("plugin-menu");
  m.innerHTML = "";
  const search = document.createElement("input");
  search.type = "text";
  search.className = "plug-search";
  search.placeholder = "Search plugins...";
  search.spellcheck = false;
  search.value = pmq;
  m.append(search);

  const rows = [];
  library.plugins.forEach((f) => {
    const name = (f.folder ? f.folder + " / " : "") + stem(f.file);
    const row = h("label", "plug-item");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = sel.plugins.has(f.rel);
    cb.addEventListener("change", () => {
      if (cb.checked) sel.plugins.add(f.rel);
      else sel.plugins.delete(f.rel);
      $("plugin-label").textContent = pluginLabel();
      renderSummary();
      saveLast();
    });
    row.append(cb, h("span", null, name));
    m.append(row);
    rows.push([row, name.toLowerCase()]);
  });

  const none = emptyNote(
    library.plugins.length ? "No plugins match." : "No plugins yet."
  );
  m.append(none);

  const more = h("button", "plug-more", "Manage plugins");
  more.type = "button";
  more.addEventListener("click", () => {
    m.hidden = true;
    setTab("plugins");
  });
  m.append(more);

  const filter = () => {
    pmq = search.value.trim().toLowerCase();
    let shown = 0;
    rows.forEach(([row, n]) => {
      const ok = n.includes(pmq);
      row.hidden = !ok;
      if (ok) shown++;
    });
    none.hidden =
      shown > 0 || !library.plugins.length ? !!library.plugins.length : false;
  };
  search.addEventListener("input", filter);
  filter();
}

function render() {
  updateContinues();
  updateBulk();
  $("plugin-label").textContent = pluginLabel();
  ["play", "worlds", "plugins"].forEach((t) => {
    $("tab-" + t).hidden = tab !== t;
    document
      .querySelector(`.nav-tab[data-tab="${t}"]`)
      .classList.toggle("active", tab === t);
  });
  $("nav-actions").hidden = tab !== "play";
  $("world-actions").hidden = tab !== "worlds";
  if (tab === "plugins") return renderPlugins();
  (tab === "play" ? $("play-worlds") : $("worlds-host")).append(gamesView);
  if (tab === "play") {
    if (!stepInit && library.maps.length) {
      stepInit = true;
      if (running || sel.map) step = "ready";
    }
    if (running) step = "ready";
    $("play-worlds").hidden = step !== "pick";
    playPlugins.hidden = step !== "plugins";
    playPluginsTitle.hidden = step !== "plugins";
    $("console-slot").hidden = step !== "ready";
    if (step === "plugins") renderPlugins(playPlugins);
    updateNext();
    renderSummary();
    buildPluginMenu();
    fillPlayVersions();
    renderConsole();
  }
  const p = prefs[tabKey()];
  $("sort-toggle").textContent = `Sort: ${
    p.sort[0].toUpperCase() + p.sort.slice(1)
  }`;
  applyLoading();
  renderGames();
}

document
  .querySelectorAll(".nav-tab")
  .forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
plugBtn.addEventListener("click", () => {
  const m = $("plugin-menu");
  m.hidden = !m.hidden;
  plugBtn.parentElement.classList.toggle("open", !m.hidden);
  if (!m.hidden) m.querySelector(".plug-search")?.focus();
});
document.addEventListener("mousedown", (e) => {
  if (e.target.closest(".plug-wrap")) return;
  $("plugin-menu").hidden = true;
  plugBtn.parentElement.classList.remove("open");
});
$("hero").addEventListener("click", () => setTab("worlds"));
document.querySelectorAll(".continue").forEach((b) =>
  b.addEventListener("click", () => {
    saveLast();
    setTab("play");
  })
);
$("help-btn").addEventListener("click", () => message("Server list", HELP));
$("reset-btn").addEventListener("click", resetAll);
$("plugin-import").addEventListener("click", () => importFiles("plugin"));
$("plugin-sort").addEventListener("click", () => {
  const p = prefs.plugins;
  p.sort = SORTS[(SORTS.indexOf(p.sort) + 1) % SORTS.length];
  renderPlugins();
});
$("plugin-folder").addEventListener("click", () => openFolder("plugin"));
$("folder-back").addEventListener("click", () => {
  curFolder = parentOf(curFolder || "") || null;
  bulk.map.clear();
  setQuery("");
  render();
});
searchInput.addEventListener("input", (e) => {
  query = e.target.value.trim().toLowerCase();
  renderGames();
});
$("plugin-search").addEventListener("input", (e) => {
  pquery = e.target.value.trim().toLowerCase();
  renderPlugins();
});
function setVersion(v) {
  if (!v || v === serverVersion) return;
  serverVersion = v;
  localStorage.setItem("ssmc_version", v);
  fillPlayVersions();
  applyLoading();
}
verPlay.addEventListener("change", () => setVersion(verPlay.value));
startBtn.addEventListener("click", () => {
  if (running) return stopWithConfirm();
  const info = versions.find((x) => x.version === curVer());
  if (info && info.installed && step !== "ready") return;
  if (!(info && info.installed)) return downloadServer(curVer());
  if (!sel.map)
    return message("Choose a world", "Pick a world from the list below first.");
  startGameFlow();
});

// ---------------- Running a game ----------------
async function stopServer(overlay = true) {
  running = null;
  ignoreExitUntil = Date.now() + 5000;
  if (overlay) busyStart("Stopping the server...");
  try {
    await invoke("stop_server");
  } catch (e) {
    console.warn("stop_server:", e);
  }
  if (overlay) busyEnd();
}

async function stopWithConfirm() {
  const ok = await askConfirm(
    "Stop the server?",
    "This ends the current game for everyone connected.",
    "Stop server"
  );
  if (!ok) return;
  await stopServer();
  render();
}

async function startGameFlow() {
  if (loading.active) return;
  const s = sel;
  const pluginFiles = [...s.plugins].filter((f) =>
    library.plugins.some((p) => p.rel === f)
  );
  consoleLines.length = 0;
  loadingStart("Preparing your world...");
  try {
    await invoke("start_game", {
      version: serverVersion,
      mapFile: s.map,
      pluginFiles,
      lan,
    });
  } catch (e) {
    loadingEnd();
    await message("Could not start the server", String(e));
    return;
  }
  loadingSet("Server ready", 100);
  await sleep(400);
  loadingEnd();
  running = {
    map: s.map,
    plugins: new Set(pluginFiles),
    lan,
    version: serverVersion,
  };
  saveLast();
  render();
}

listen("server-exit", () => {
  if (!running) return;
  if (!stopTyped && Date.now() < ignoreExitUntil) return;
  const expected = stopTyped;
  stopTyped = false;
  running = null;
  render();
  if (!expected)
    message(
      "The server stopped",
      "The server stopped unexpectedly. Start it again to continue."
    );
});

// ---------------- Server settings window ----------------
const settingsEl = $("settings");
const ramSelect = $("ram-select");
const accessSeg = $("access-seg");
const accessHint = $("access-hint");
const verSelect = $("ver-select");

let access = "verified";
let loaded = { ram_mb: 2048, online_mode: true };
const lanSeg = $("lan-seg");
let lanPick = false;
function setLan(v) {
  lanPick = v;
  lanSeg
    .querySelectorAll(".seg")
    .forEach((b) =>
      b.classList.toggle("active", (b.dataset.value === "lan") === v)
    );
  $("lan-hint").textContent = VIS_HINTS[v ? "lan" : "local"];
  $("fw-btn").hidden = !v;
}
lanSeg.addEventListener("click", (e) => {
  const b = e.target.closest(".seg");
  if (b) setLan(b.dataset.value === "lan");
});
$("fw-btn").addEventListener("click", async () => {
  const r = $("fw-result");
  r.textContent = "Waiting for Windows...";
  try {
    await invoke("allow_firewall", { version: curVer() });
    r.textContent = "Done.";
  } catch (e) {
    r.textContent = String(e);
  }
});

function setAccess(value) {
  access = value;
  accessSeg
    .querySelectorAll(".seg")
    .forEach((b) => b.classList.toggle("active", b.dataset.value === value));
  accessHint.textContent = ACCESS_HINTS[value];
}
accessSeg.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg");
  if (btn) setAccess(btn.dataset.value);
});

function fillVersions() {
  const keep = verSelect.value;
  verSelect.innerHTML = "";
  versions.forEach((x) =>
    verSelect.add(
      new Option(
        x.installed ? `${x.version} (downloaded)` : x.version,
        x.version
      )
    )
  );
  if (keep) verSelect.value = keep;
}

async function openSettings() {
  try {
    loaded = await invoke("get_settings");
  } catch (e) {
    console.warn("get_settings:", e);
  }
  if (![...ramSelect.options].some((o) => Number(o.value) === loaded.ram_mb)) {
    ramSelect.add(
      new Option(`${(loaded.ram_mb / 1024).toFixed(1)} GB`, loaded.ram_mb)
    );
  }
  ramSelect.value = String(loaded.ram_mb);
  setAccess(loaded.online_mode ? "verified" : "anyone");
  await refreshVersions();
  fillVersions();
  verSelect.value = serverVersion;
  $("ver-hint").textContent = "";
  invoke("library_path")
    .then((p) => ($("lib-path").textContent = p))
    .catch(() => {});
  setLan(lan);
  $("fw-result").textContent = "";
  settingsEl.hidden = false;
}
const closeSettings = () => (settingsEl.hidden = true);

document.querySelector(".gear").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", closeSettings);
$("settings-cancel").addEventListener("click", closeSettings);
$("open-library").addEventListener("click", () => openFolder(null));
settingsEl.addEventListener("mousedown", (e) => {
  if (e.target === settingsEl) closeSettings();
});

$("ver-download").addEventListener("click", async () => {
  const v = verSelect.value;
  const info = versions.find((x) => x.version === v);
  if (info && info.installed) {
    $("ver-hint").textContent = `${v} is already downloaded.`;
    return;
  }
  await downloadServer(v);
  fillVersions();
  verSelect.value = v;
  fillPlayVersions();
  $("ver-hint").textContent = `${v} downloaded.`;
});

$("settings-save").addEventListener("click", async () => {
  const next = {
    ram_mb: Number(ramSelect.value),
    online_mode: access === "verified",
  };
  closeSettings();
  if (!running) setVersion(verSelect.value);
  const lanChanged = lanPick !== lan;
  lan = lanPick;
  const changed =
    next.ram_mb !== loaded.ram_mb ||
    next.online_mode !== loaded.online_mode ||
    lanChanged;
  try {
    await invoke("save_settings", { settings: next });
  } catch (e) {
    await message("Could not save the settings", String(e));
    return;
  }
  if (!changed || !running) return;

  const ok = await askConfirm(
    "Restart the server?",
    "The new settings apply after a restart. The world keeps its progress.",
    "Restart"
  );
  if (!ok) return;
  ignoreExitUntil = Date.now() + 8000;
  busyStart("Restarting the server...");
  try {
    await invoke("restart_server", {
      lan,
      version: running.version,
    });
  } catch (e) {
    running = null;
    busyEnd();
    render();
    await message("Could not restart the server", String(e));
    return;
  }
  busyEnd();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!dialogEl.hidden)
    ($("dialog-cancel").hidden ? $("dialog-ok") : $("dialog-cancel")).click();
  else if (!settingsEl.hidden) closeSettings();
  else if (curFolder) $("folder-back").click();
  else if (tab !== "play") setTab("play");
});

// ---------------- Main screen buttons ----------------
["toolbar-import", "empty-import"].forEach((id) =>
  $(id).addEventListener("click", () => importFiles("map", curFolder))
);
["toolbar-open-folder", "empty-open-folder"].forEach((id) =>
  $(id).addEventListener("click", () => openFolder("map", curFolder))
);
$("view-toggle").addEventListener("click", () => {
  const p = prefs[tabKey()];
  p.view = p.view === "grid" ? "list" : "grid";
  localStorage.setItem("ssmc_view_" + tabKey(), p.view);
  render();
});
$("sort-toggle").addEventListener("click", () => {
  const p = prefs[tabKey()];
  p.sort = SORTS[(SORTS.indexOf(p.sort) + 1) % SORTS.length];
  render();
});

window.addEventListener("focus", async () => {
  await refreshLibrary();
  render();
});

// ---------------- Window controls & dragging ----------------
const getWin = () => window.__TAURI__.window.getCurrentWindow();

$("close-btn").addEventListener("click", async () => {
  if (
    running &&
    !(await askConfirm(
      "Close the app?",
      "A server is running. Closing the app stops it.",
      "Stop and close"
    ))
  )
    return;
  getWin()
    .hide()
    .then(() => getWin().close())
    .catch(console.error);
});
$("minimize-btn").addEventListener("click", () => {
  getWin().minimize().catch(console.error);
});

document.querySelector(".panel-header").addEventListener("mousedown", (e) => {
  if (e.button !== 0 || e.target.closest("button")) return;
  getWin()
    .startDragging()
    .catch(() => {});
});

// ---------------- Bulk actions + context menus ----------------
const bulk = { map: new Set(), plugin: new Set() };
const svg = (inner) =>
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  inner +
  "</svg>";
const ICON_TRASH = svg(
  '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'
);
const ICON_FOLDER = svg(
  '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'
);
const ICON_RENAME = svg(
  '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>'
);
const ICON_BACK = svg(
  '<polyline points="14 9 9 4 4 9"/><path d="M20 20h-7a4 4 0 0 1-4-4V4"/>'
);

function toggleBulk(kind, rel) {
  fFocus = null;
  const s = bulk[kind];
  if (s.has(rel)) s.delete(rel);
  else s.add(rel);
  render(true);
}
function bulkInfo(kind) {
  const items = [...bulk[kind]]
    .map((r) => filesOf(kind).find((f) => f.rel === r))
    .filter(Boolean);
  const parents = new Set(items.map((f) => f.folder));
  return {
    items,
    n: items.length,
    parent: items.length ? items[0].folder : "",
    rename: items.length === 1,
    back: items.length > 0 && items.every((f) => f.folder),
    move:
      items.length > 0 && parents.size === 1 && !items[0].folder.includes("/"),
  };
}
function folderTarget(kind) {
  if (kind === "map" && tab === "worlds" && curFolder) {
    const d = library.folders.find((x) => x.name === curFolder);
    return d && folderEmpty("map", d) ? d.name : null;
  }
  if (fFocus && fFocus.kind === kind) {
    const d = flist(kind).find((x) => x.name === fFocus.path);
    if (d && folderEmpty(kind, d)) return d.name;
  }
  return null;
}
function visibleMaps() {
  if (curFolder)
    return library.maps.filter(
      (m) => m.folder === curFolder && matches(stem(m.file))
    );
  const open = (p) =>
    openFolders.has(p) && (!p.includes("/") || openFolders.has(parentOf(p)));
  return library.maps.filter(
    (m) =>
      matches(stem(m.file)) &&
      (!m.folder || (prefs.worlds.view === "list" && open(m.folder)))
  );
}
function visiblePlugins() {
  const pm = (f) => !pquery || stem(f.file).toLowerCase().includes(pquery);
  const open = (p) =>
    openPFolders.has(p) && (!p.includes("/") || openPFolders.has(parentOf(p)));
  return library.plugins.filter(
    (f) => pm(f) && (!f.folder || open(f.folder) || !!pquery)
  );
}
function selectAll(kind) {
  const vis = kind === "map" ? visibleMaps() : visiblePlugins();
  const s = bulk[kind];
  const every = vis.length && vis.every((f) => s.has(f.rel));
  vis.forEach((f) => (every ? s.delete(f.rel) : s.add(f.rel)));
  fFocus = null;
  render(true);
}

function makeBulkBar(kind, host) {
  const bar = h("div", "bulk-bar");
  bar.hidden = true;
  const mk = (cls, fn) => {
    const b = h("button", "bulk-btn " + cls);
    b.type = "button";
    b.addEventListener("click", fn);
    bar.append(b);
    return b;
  };
  const b = {
    kind,
    bar,
    del: mk("bulk-del", () => bulkDelete(kind)),
    ren: mk("", () => bulkRename(kind)),
    mv: mk("", () => bulkMove(kind)),
    back: mk("", () => bulkBack(kind)),
    all: mk("", () => selectAll(kind)),
    fdel: mk("bulk-del", () => folderDelete(kind, folderTarget(kind))),
    fren: mk("", () => folderRename(kind, folderTarget(kind))),
  };
  host.append(bar);
  return b;
}
const bars = [
  makeBulkBar("map", $("tab-worlds")),
  makeBulkBar("plugin", $("tab-plugins")),
];
function updateBulk() {
  bars.forEach((b) => {
    const k = b.kind,
      s = bulk[k];
    [...s].forEach((r) => filesOf(k).some((f) => f.rel === r) || s.delete(r));
    const i = bulkInfo(k);
    const show = s.size > 0;
    const ft = show ? null : folderTarget(k);
    b.bar.hidden = !show && !ft;
    b.del.hidden = !show;
    b.ren.hidden = !(show && i.rename);
    b.mv.hidden = !(show && i.move);
    b.back.hidden = !(show && i.back);
    b.all.hidden = !show;
    b.fdel.hidden = b.fren.hidden = !ft;
    b.del.innerHTML = `${ICON_TRASH}<span>Delete (${s.size})</span>`;
    b.ren.innerHTML = `${ICON_RENAME}<span>Rename</span>`;
    b.mv.innerHTML = `${ICON_FOLDER}<span>Add to folder</span>`;
    b.back.innerHTML = `${ICON_BACK}<span>Move to previous folder</span>`;
    const vis = k === "map" ? visibleMaps() : visiblePlugins();
    const every = vis.length && vis.every((f) => s.has(f.rel));
    b.all.innerHTML = `<span class="bulk-box">${
      every ? "&#10003;" : ""
    }</span><span>Select all</span>`;
    b.fdel.innerHTML = `${ICON_TRASH}<span>Delete folder</span>`;
    b.fren.innerHTML = `${ICON_RENAME}<span>Rename folder</span>`;
  });
}

// ----- item actions -----
async function bulkDelete(kind) {
  const s = bulk[kind];
  if (!s.size) return;
  const n = s.size;
  const what = kind === "map" ? "world" : "plugin";
  const ok = await askConfirm(
    `Delete ${n} ${what}${n === 1 ? "" : "s"}?`,
    "This permanently removes the selected files from your library.",
    "Delete"
  );
  if (!ok) return;
  try {
    await invoke("delete_items", { kind, rels: [...s] });
  } catch (e) {
    return message("Could not delete", String(e));
  }
  if (kind === "map") {
    if (sel.map && s.has(sel.map)) sel.map = null;
  } else s.forEach((r) => sel.plugins.delete(r));
  s.clear();
  await refreshLibrary();
  saveLast();
  render(true);
}
async function bulkRename(kind) {
  const i = bulkInfo(kind);
  if (!i.rename) return;
  const f = i.items[0];
  const ext = (f.file.match(/\.[^.]+$/) || [""])[0];
  const name = await askName(
    kind === "map" ? "Rename world" : "Rename plugin",
    stem(f.file),
    "Rename"
  );
  if (!name || name === stem(f.file)) return;
  try {
    await invoke("rename_item", { kind, rel: f.rel, newName: name });
  } catch (e) {
    return message("Could not rename", String(e));
  }
  const nr = (f.folder ? f.folder + "/" : "") + name + ext;
  if (sel.map === f.rel) sel.map = nr;
  if (sel.plugins.has(f.rel)) {
    sel.plugins.delete(f.rel);
    sel.plugins.add(nr);
  }
  bulk[kind].clear();
  await refreshLibrary();
  saveLast();
  render(true);
}
async function afterMove(kind, items, destOf) {
  const map = new Map(
    items.map((f) => {
      const d = destOf(f);
      return [f.rel, (d ? d + "/" : "") + f.file];
    })
  );
  if (kind === "map") {
    if (sel.map && map.has(sel.map)) sel.map = map.get(sel.map);
  } else sel.plugins = new Set([...sel.plugins].map((p) => map.get(p) || p));
  bulk[kind].clear();
  await refreshLibrary();
  saveLast();
  render(true);
}
async function bulkMove(kind) {
  const i = bulkInfo(kind);
  if (!i.move) return;
  const r = await openFolderModal(kind, i.parent);
  if (!r) return;
  const path = r.create
    ? i.parent
      ? i.parent + "/" + r.name
      : r.name
    : r.path;
  try {
    if (r.create)
      await invoke("create_folder", {
        kind,
        name: r.name,
        parent: i.parent || null,
        iconPath: r.iconPath || null,
      });
    await invoke("move_items", {
      kind,
      rels: i.items.map((f) => f.rel),
      folder: path,
    });
  } catch (e) {
    await message("Could not add to folder", String(e));
    await refreshLibrary();
    return render(true);
  }
  await afterMove(kind, i.items, () => path);
}
async function bulkBack(kind) {
  const i = bulkInfo(kind);
  if (!i.back) return;
  try {
    for (const f of i.items)
      await invoke("move_items", {
        kind,
        rels: [f.rel],
        folder: parentOf(f.folder),
      });
  } catch (e) {
    await message("Could not move", String(e));
    await refreshLibrary();
    return render(true);
  }
  await afterMove(kind, i.items, (f) => parentOf(f.folder));
}

// ----- folder actions -----
async function folderRename(kind, path) {
  if (!path) return;
  const name = await askName("Rename folder", leaf(path), "Rename");
  if (!name || name === leaf(path)) return;
  const par = parentOf(path);
  const np = par ? par + "/" + name : name;
  try {
    await invoke("rename_folder", { kind, path, newName: name });
  } catch (e) {
    return message("Could not rename the folder", String(e));
  }
  const fix = (r) => (r.startsWith(path + "/") ? np + r.slice(path.length) : r);
  if (sel.map) sel.map = fix(sel.map);
  sel.plugins = new Set([...sel.plugins].map(fix));
  if (curFolder && (curFolder === path || curFolder.startsWith(path + "/")))
    curFolder = np + curFolder.slice(path.length);
  openFolders.clear();
  openPFolders.clear();
  fFocus = null;
  bulk.map.clear();
  bulk.plugin.clear();
  await refreshLibrary();
  saveLast();
  render(true);
}
async function folderDelete(kind, path) {
  if (!path) return;
  const ok = await askConfirm(
    `Delete folder "${leaf(path)}"?`,
    "The folder is empty, so no files will be lost.",
    "Delete"
  );
  if (!ok) return;
  try {
    await invoke("delete_folder", { kind, path });
  } catch (e) {
    return message("Could not delete the folder", String(e));
  }
  if (curFolder === path) curFolder = parentOf(path) || null;
  fFocus = null;
  await refreshLibrary();
  render(true);
}

// ----- right-click menus -----
let ctxEl = null;
function closeCtx() {
  if (ctxEl) ctxEl.remove();
  ctxEl = null;
}
function showCtx(x, y, entries) {
  closeCtx();
  const m = h("div", "ctx-menu");
  entries.forEach(([label, fn, cls]) => {
    const b = h("button", "ctx-item " + (cls || ""), label);
    b.type = "button";
    b.addEventListener("click", () => {
      closeCtx();
      fn();
    });
    m.append(b);
  });
  document.body.append(m);
  m.style.left =
    Math.max(4, Math.min(x, innerWidth - m.offsetWidth - 4)) + "px";
  m.style.top =
    Math.max(4, Math.min(y, innerHeight - m.offsetHeight - 4)) + "px";
  ctxEl = m;
}
document.addEventListener("mousedown", (e) => {
  if (ctxEl && !ctxEl.contains(e.target)) closeCtx();
});
document.addEventListener("keydown", (e) => e.key === "Escape" && closeCtx());
window.addEventListener("blur", closeCtx);

function itemMenu(kind, f, e) {
  if (tab === "play") return;
  e.preventDefault();
  const s = bulk[kind];
  if (!s.has(f.rel)) {
    s.clear();
    s.add(f.rel);
    fFocus = null;
    render(true);
  }
  const i = bulkInfo(kind);
  const en = [[`Delete (${i.n})`, () => bulkDelete(kind), "ctx-danger"]];
  if (i.rename) en.push(["Rename", () => bulkRename(kind)]);
  if (i.move) en.push(["Add to folder", () => bulkMove(kind)]);
  if (i.back) en.push(["Move to previous folder", () => bulkBack(kind)]);
  en.push(["Select all", () => selectAll(kind)]);
  showCtx(e.clientX, e.clientY, en);
}
function folderMenu(kind, d, e) {
  if (tab === "play") return;
  e.preventDefault();
  const en = [["Rename folder", () => folderRename(kind, d.name)]];
  if (folderEmpty(kind, d))
    en.push(["Delete folder", () => folderDelete(kind, d.name), "ctx-danger"]);
  showCtx(e.clientX, e.clientY, en);
}

// ----- dialogs -----
function askName(title, initial, ok) {
  return new Promise((resolve) => {
    const ov = h("div", "modal");
    const card = h("div", "modal-card");
    ov.append(card);
    document.body.append(ov);
    const close = (v) => {
      ov.remove();
      resolve(v);
    };
    ov.addEventListener("mousedown", (e) => {
      if (e.target === ov) close(null);
    });
    const head = h("div", "modal-head");
    head.append(h("h2", null, title));
    const input = document.createElement("input");
    input.type = "text";
    input.className = "fp-input";
    input.value = initial;
    input.maxLength = 60;
    input.spellcheck = false;
    const okBtn = h("button", "primary-btn", ok);
    okBtn.type = "button";
    const cancel = h("button", "eula-secondary", "Cancel");
    cancel.type = "button";
    const act = h("div", "modal-actions");
    act.append(cancel, okBtn);
    const check = () => (okBtn.disabled = !input.value.trim());
    input.addEventListener("input", check);
    check();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !okBtn.disabled) okBtn.click();
      if (e.key === "Escape") close(null);
    });
    okBtn.onclick = () => close(input.value.trim());
    cancel.onclick = () => close(null);
    card.append(head, input, act);
    input.focus();
    input.select();
  });
}

function openFolderModal(kind, parent) {
  return new Promise((resolve) => {
    const folders = subsOf(kind, parent);
    const ov = h("div", "modal");
    const card = h("div", "modal-card");
    ov.append(card);
    document.body.append(ov);
    const close = (v) => {
      ov.remove();
      resolve(v);
    };
    ov.addEventListener("mousedown", (e) => {
      if (e.target === ov) close(null);
    });
    const btn = (cls, text, fn) => {
      const b = h("button", cls, text);
      b.type = "button";
      b.addEventListener("click", fn);
      return b;
    };
    const showList = () => {
      card.innerHTML = "";
      const head = h("div", "modal-head");
      head.append(h("h2", null, "Add to folder"));
      const list = h("div", "fp-list");
      folders.forEach((d) =>
        list.append(btn("fp-item", leaf(d.name), () => close({ path: d.name })))
      );
      if (!folders.length)
        list.append(
          h(
            "p",
            "modal-note",
            parent
              ? `No folders inside "${leaf(parent)}" yet. Create one below.`
              : "No folders yet. Create one below."
          )
        );
      const act = h("div", "modal-actions");
      act.append(
        btn("eula-secondary", "Cancel", () => close(null)),
        btn("primary-btn", "New folder", showForm)
      );
      card.append(head, list, act);
    };
    const showForm = () => {
      card.innerHTML = "";
      let iconPath = "";
      const head = h("div", "modal-head");
      head.append(
        h("h2", null, parent ? `New folder in ${leaf(parent)}` : "New folder")
      );
      const input = document.createElement("input");
      input.type = "text";
      input.className = "fp-input";
      input.placeholder = "Folder name";
      input.maxLength = 60;
      input.spellcheck = false;
      card.append(head, input);
      if (kind === "map") {
        const lbl = h(
          "span",
          "modal-note",
          "No icon (uses the first world's icon)"
        );
        const pick = btn(
          "eula-secondary",
          "Choose icon (optional)",
          async () => {
            try {
              const p = await T.dialog.open({
                multiple: false,
                filters: [
                  {
                    name: "Images",
                    extensions: ["png", "jpg", "jpeg", "webp"],
                  },
                ],
              });
              if (!p) return;
              iconPath = typeof p === "string" ? p : p.path;
              lbl.textContent = iconPath.split(/[\\/]/).pop();
            } catch (e) {
              message("Could not open the file picker", String(e));
            }
          }
        );
        card.append(pick, lbl);
      }
      const create = btn("primary-btn", "Create", () =>
        close({ create: true, name: input.value.trim(), iconPath })
      );
      create.disabled = true;
      input.addEventListener("input", () => {
        create.disabled = !input.value.trim();
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !create.disabled) create.click();
      });
      const act = h("div", "modal-actions");
      act.append(btn("eula-secondary", "Back", showList), create);
      card.append(act);
      input.focus();
    };
    showList();
  });
}

// ---------------- Start ----------------
render();
(async () => {
  await refreshLibrary();
  await refreshVersions();
  restoreLast();
  render(true);
})();
async function onBootDone() {
  await refreshVersions();
  fillPlayVersions();
  render(true);
  const v = versions.find((x) => x.version === "1.8.8");
  if (v && !v.installed) downloadServer("1.8.8");
}
window.addEventListener("boot-done", onBootDone);
if (window.__bootDone) onBootDone();
