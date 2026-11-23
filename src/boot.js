// ===============================================================
// Loading screen + startup sequence
//   1. check for an app update (silently skipped if offline)
//   2. ask the user to accept the Minecraft EULA (first run only)
//   3. Rust installs Java + Spigot if missing and prepares the server once
//      (the server is stopped again: it only starts when a game is chosen)
//   4. fade into the launcher
// The loading screen is also reused (see "busy-start" below) while a game starts.
// ===============================================================

const T = window.__TAURI__;
const { invoke } = T.core;
const { listen } = T.event;
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const splash = $("splash");
const statusEl = $("splash-status");
const fillEl = $("splash-fill");
const retryBtn = $("splash-retry");
const eulaEl = $("eula");

// ---------- Progress bar ----------
let barValue = 0;
function setBar(p, force = false) {
  if (!force && p <= barValue) return; // only moves forward
  barValue = Math.min(100, p);
  fillEl.style.width = barValue + "%";
}
function setStatus(text) {
  statusEl.textContent = text;
  statusEl.classList.remove("error");
}
function showError(text) {
  statusEl.textContent = text;
  statusEl.classList.add("error");
  retryBtn.hidden = false;
}

// While the server boots we can't know the exact %, so ease toward 95%.
let creep = null;
function startCreep() {
  stopCreep();
  creep = setInterval(() => {
    if (barValue < 95) setBar(barValue + (95 - barValue) * 0.05);
  }, 1000);
}
function stopCreep() {
  clearInterval(creep);
  creep = null;
}

// ---------- App updates ----------
let pendingUpdate = null;
let updateShown = false;

async function findUpdate() {
  try {
    const timeout = new Promise((r) => setTimeout(() => r(null), 6000));
    const update = await Promise.race([T.updater.check(), timeout]);
    if (
      update &&
      (!pendingUpdate || pendingUpdate.version !== update.version)
    ) {
      pendingUpdate = update;
      updateShown = false;
    }
  } catch (e) {
    console.warn("Update check skipped:", e);
  }
}

function showUpdatePopup() {
  if (!pendingUpdate || updateShown) return;
  updateShown = true;
  const u = pendingUpdate;
  const box = document.createElement("div");
  box.className = "update-toast";
  box.innerHTML = `
    <div class="update-head"><strong>Update available</strong><span class="u-ver"></span></div>
    <pre class="update-notes"></pre>
    <div class="update-bar" hidden><div class="update-fill"></div></div>
    <div class="update-status"></div>
    <div class="update-actions">
      <button class="eula-secondary u-later" type="button">Update later</button>
      <button class="primary-btn u-now" type="button">Update now</button>
    </div>`;
  box.querySelector(".u-ver").textContent = `Version ${u.version}`;
  box.querySelector(".update-notes").textContent =
    u.body || "Bug fixes and improvements.";
  const bar = box.querySelector(".update-bar");
  const fill = box.querySelector(".update-fill");
  const status = box.querySelector(".update-status");
  const now = box.querySelector(".u-now");
  const later = box.querySelector(".u-later");

  later.onclick = () => box.remove();
  now.onclick = async () => {
    if (typeof running !== "undefined" && running) {
      status.textContent = "Stop your server before updating.";
      return;
    }
    now.disabled = later.disabled = true;
    bar.hidden = false;
    status.textContent = "Downloading...";
    let total = 0;
    let got = 0;
    try {
      await u.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength || 0;
        if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          if (total) {
            const pct = Math.round((got / total) * 100);
            fill.style.width = pct + "%";
            status.textContent = `Downloading... ${pct}%`;
          }
        }
        if (ev.event === "Finished")
          status.textContent = "Installing... the app will restart.";
      });
      await T.process.relaunch();
    } catch (e) {
      status.textContent = "Update failed: " + e;
      now.disabled = later.disabled = false;
    }
  };
  document.body.append(box);
}

// ---------- EULA ----------
function askEula() {
  return new Promise((resolve) => {
    eulaEl.hidden = false;
    $("eula-link").onclick = () =>
      T.opener.openUrl("https://aka.ms/MinecraftEULA").catch(console.error);
    $("eula-accept").onclick = () => {
      eulaEl.hidden = true;
      resolve(true);
    };
    $("eula-decline").onclick = () => resolve(false);
  });
}

async function quitApp() {
  const win = T.window.getCurrentWindow();
  await win.hide();
  await win.close();
}

// ---------- Startup ----------
(async function boot() {
  setStatus("Checking for updates...");
  setBar(3);
  await findUpdate();

  const status = await invoke("get_status");
  if (!status.eula_accepted) {
    setStatus("Waiting for your agreement...");
    if (!(await askEula())) return quitApp();
    await invoke("accept_eula");
  }
  try {
    const vers = await invoke("list_versions");
    const v = vers.find((x) => x.version === "1.8.8");
    if (v && !v.installed) {
      setStatus("Installing Minecraft server 1.8.8 (first launch only)...");
      startCreep();
      const un = await listen("setup-progress", (e) => {
        const { label, percent } = e.payload;
        if (label) setStatus(label);
        if (percent) setBar(percent * 0.95);
      });
      try {
        await invoke("install_server", { version: "1.8.8" });
      } finally {
        un();
        stopCreep();
      }
    }
  } catch (e) {
    console.warn("First-run server install skipped:", e);
  }
  setBar(100);
  setStatus("Ready");
  await sleep(400);
  splash.classList.add("hide");
  window.__bootDone = true;
  window.dispatchEvent(new Event("boot-done"));
  showUpdatePopup();
  // keep checking while the app is open
  setInterval(async () => {
    await findUpdate();
    showUpdatePopup();
  }, 30 * 60 * 1000);
})();

// main.js reuses this loading screen while a game's server starts
let busyToken = 0;
window.addEventListener("busy-start", (e) => {
  busyToken++;
  stopCreep();
  retryBtn.hidden = true;
  setBar(0, true);
  setStatus((e.detail && e.detail.text) || "Working...");
  splash.classList.remove("hide");
});
window.addEventListener("busy-end", async () => {
  const mine = ++busyToken;
  stopCreep();
  setBar(100);
  await sleep(250);
  if (mine === busyToken) splash.classList.add("hide"); // a newer busy-start keeps it open
});
$("maximize-btn").addEventListener("click", () =>
  T.window.getCurrentWindow().toggleMaximize()
);
