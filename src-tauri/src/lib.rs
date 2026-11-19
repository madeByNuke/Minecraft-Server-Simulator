use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use base64::Engine;
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

// ======================= SETTINGS (edit these) =======================
/// Minecraft version of the Spigot server. It is built on the player's PC with
/// BuildTools. A 1.8.8 server also accepts 1.8.9 players (same protocol).
/// Java that MC_VERSION needs. Minecraft 1.8.x only runs properly on Java 8.
/// BuildTools compiles code, so it needs a full JDK (not just a JRE).
const SERVER_PORT: u16 = 25565;
/// Sent with every download request.
const USER_AGENT: &str = "ssmc/0.1 (https://noblecratemc.com)";
/// BuildTools wants to download this Git itself, but GitHub rejects its request
/// (HTTP 406), so the app downloads it and hands it over.
const GIT_FOLDER: &str = "PortableGit-2.45.2-64-bit";
const GIT_URL: &str =
    "https://github.com/git-for-windows/git/releases/download/v2.45.2.windows.1/PortableGit-2.45.2-64-bit.7z.exe";
/// Your website. The app only talks to this address.
/// const SITE: &str = "https://noblecratemc.com";
const BUILDTOOLS_URL: &str =
    "https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar";
// =====================================================================

const EULA_TEXT: &str =
    "# Accepted by the user in SSMC (https://aka.ms/MinecraftEULA)\neula=true\n";

struct ServerHandle {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
struct ServerState(Mutex<Option<ServerHandle>>);

#[derive(Serialize, Clone)]
struct Progress {
    stage: String,
    label: String,
    percent: f32,
}

/// Settings the player can change in the launcher (stored in settings.json).
#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    ram_mb: u32,
    online_mode: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            ram_mb: 2048,
            online_mode: true,
        }
    }
}

fn folder_dir(root: &Path, path: &str) -> Result<PathBuf, String> {
    let parts: Vec<&str> = path.split('/').collect();
    if parts.is_empty() || parts.len() > 2 {
        return Err("Folders can only go two levels deep.".into());
    }
    let mut d = root.to_path_buf();
    for p in parts {
        d = d.join(safe_segment(p)?);
    }
    Ok(d)
}

fn rel_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.is_empty() || parts.len() > 3 {
        return Err("Bad file path".into());
    }
    let mut d = root.to_path_buf();
    for p in parts {
        d = d.join(safe_segment(p)?);
    }
    Ok(d)
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
}

#[tauri::command]
fn create_folder(
    app: AppHandle,
    kind: String,
    name: String,
    parent: Option<String>,
    icon_path: Option<String>,
) -> Result<(), String> {
    let root = library_dir(&app, &kind)?;
    let base = match parent.filter(|p| !p.is_empty()) {
        Some(p) => {
            if p.contains('/') {
                return Err("Folders can only go two levels deep.".into());
            }
            let d = folder_dir(&root, &p)?;
            if !d.is_dir() {
                return Err("The parent folder was not found.".into());
            }
            d
        }
        None => root.clone(),
    };
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("The folder needs a name.".into());
    }
    let dir = base.join(safe_segment(&name)?);
    if dir.exists() {
        return Err("A folder with that name already exists.".into());
    }
    std::fs::create_dir_all(&dir).map_err(e2s)?;
    if let Some(p) = icon_path.filter(|p| !p.is_empty()) {
        let res = (|| -> Result<(), String> {
            let bytes = std::fs::read(&p).map_err(e2s)?;
            let img = image::load_from_memory(&bytes)
                .map_err(|_| "That image could not be read.".to_string())?;
            let img = if img.width() > 512 || img.height() > 512 { img.thumbnail(512, 512) } else { img };
            let png = encode_png(img).ok_or("Could not save the icon.")?;
            std::fs::write(dir.join("icon.png"), png).map_err(e2s)
        })();
        if let Err(e) = res {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
    }
    Ok(())
}

#[tauri::command]
fn move_items(app: AppHandle, kind: String, rels: Vec<String>, folder: String) -> Result<(), String> {
    let root = library_dir(&app, &kind)?;
    let dest = if folder.is_empty() {
        root.clone()
    } else {
        let d = folder_dir(&root, &folder)?;
        std::fs::create_dir_all(&d).map_err(e2s)?;
        d
    };
    for r in rels {
        let src = rel_path(&root, &r)?;
        if !src.is_file() {
            continue;
        }
        let name = src.file_name().ok_or("Bad file name")?.to_owned();
        let to = dest.join(&name);
        if to == src {
            continue;
        }
        if to.exists() {
            return Err(format!("{} already exists in that folder.", name.to_string_lossy()));
        }
        std::fs::rename(&src, &to).map_err(e2s)?;
    }
    Ok(())
}

#[tauri::command]
fn rename_item(app: AppHandle, kind: String, rel: String, new_name: String) -> Result<(), String> {
    let root = library_dir(&app, &kind)?;
    let src = rel_path(&root, &rel)?;
    if !src.is_file() {
        return Err("File not found.".into());
    }
    let ext = src.extension().and_then(|x| x.to_str()).unwrap_or("").to_string();
    let file = format!("{}.{}", new_name.trim(), ext);
    safe_segment(&file)?;
    let to = src.with_file_name(&file);
    if to.exists() && !same_path(&to, &src) {
        return Err("A file with that name already exists.".into());
    }
    std::fs::rename(&src, &to).map_err(e2s)
}

#[tauri::command]
fn rename_folder(app: AppHandle, kind: String, path: String, new_name: String) -> Result<(), String> {
    let root = library_dir(&app, &kind)?;
    let src = folder_dir(&root, &path)?;
    if !src.is_dir() {
        return Err("Folder not found.".into());
    }
    let name = new_name.trim();
    safe_segment(name)?;
    let to = src.with_file_name(name);
    if to.exists() && !same_path(&to, &src) {
        return Err("A folder with that name already exists.".into());
    }
    std::fs::rename(&src, &to).map_err(e2s)
}

#[tauri::command]
fn delete_folder(app: AppHandle, kind: String, path: String) -> Result<(), String> {
    let root = library_dir(&app, &kind)?;
    let dir = folder_dir(&root, &path)?;
    if !dir.is_dir() {
        return Ok(());
    }
    for e in std::fs::read_dir(&dir).map_err(e2s)?.flatten() {
        let p = e.path();
        let is_icon = p.is_file()
            && p.file_stem().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("icon")).unwrap_or(false);
        if !is_icon {
            return Err("The folder is not empty.".into());
        }
    }
    std::fs::remove_dir_all(&dir).map_err(e2s)
}

/// Files + folders (folders can contain one more level of folders).
fn scan_library(root: &Path, ext: &str) -> (Vec<LibFile>, Vec<FolderInfo>) {
    let mut files = read_files(root, ext, "");
    let mut folders = Vec::new();
    for e in std::fs::read_dir(root).into_iter().flatten().flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        let inside = read_files(&p, ext, &name);
        let mut count = inside.len();
        files.extend(inside);
        for s in std::fs::read_dir(&p).into_iter().flatten().flatten() {
            let sp = s.path();
            if !sp.is_dir() {
                continue;
            }
            let sname = format!("{}/{}", name, s.file_name().to_string_lossy());
            let sinside = read_files(&sp, ext, &sname);
            count += sinside.len();
            folders.push(FolderInfo {
                name: sname,
                icon: read_folder_icon(&sp).map(data_url),
                count: sinside.len(),
            });
            files.extend(sinside);
        }
        folders.push(FolderInfo { name, icon: read_folder_icon(&p).map(data_url), count });
    }
    folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    (files, folders)
}

fn load_settings(root: &Path) -> Settings {
    std::fs::read_to_string(root.join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Sets key=value in a .properties file, adding the line if it isn't there.
fn set_property(path: &Path, key: &str, value: &str) -> Result<(), String> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let prefix = format!("{key}=");
    let mut found = false;
    let mut lines: Vec<String> = text
        .lines()
        .map(|l| {
            if l.starts_with(&prefix) {
                found = true;
                format!("{prefix}{value}")
            } else {
                l.to_string()
            }
        })
        .collect();
    if !found {
        lines.push(format!("{prefix}{value}"));
    }
    std::fs::write(path, lines.join("\n") + "\n").map_err(e2s)
}

#[derive(Serialize)]
struct Status {
    eula_accepted: bool,
}

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn progress(app: &AppHandle, stage: &str, label: impl Into<String>, percent: f32) {
    let _ = app.emit(
        "setup-progress",
        Progress {
            stage: stage.into(),
            label: label.into(),
            percent,
        },
    );
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(e2s)?;
    std::fs::create_dir_all(&dir).map_err(e2s)?;
    Ok(dir)
}

/// Keeps the program's output lines so an error message can say what went wrong.
fn remember(log: &std::sync::Mutex<Vec<String>>, line: &str) {
    if line.trim().is_empty() {
        return;
    }
    if let Ok(mut l) = log.lock() {
        l.push(line.trim().to_string());
        if l.len() > 3000 {
            l.remove(0);
        }
    }
}

/// The last few lines.
fn recent(log: &std::sync::Mutex<Vec<String>>) -> String {
    log.lock()
        .map(|l| l[l.len().saturating_sub(5)..].join(" | "))
        .unwrap_or_default()
}

fn clip(l: &str) -> String {
    l.chars().take(260).collect()
}

/// The lines that actually describe the problem (exception messages), if any.
fn summary(log: &std::sync::Mutex<Vec<String>>) -> String {
    let lines = log.lock().map(|l| l.clone()).unwrap_or_default();
    // Maven prints the real reason on its "Failed to execute goal" / "Could not ..." lines
    let maven: Vec<String> = lines
        .iter()
        .filter(|l| {
            l.contains("Failed to execute goal")
                || l.contains("Could not transfer")
                || l.contains("Could not resolve")
        })
        .take(2)
        .map(|l| clip(l))
        .collect();
    if !maven.is_empty() {
        return maven.join(" | ");
    }
    let key: Vec<String> = lines
        .iter()
        .filter(|l| {
            l.contains("Exception") || l.contains("Caused by") || l.contains("HTTP response code")
        })
        .filter(|l| !l.starts_with("at "))
        .take(3)
        .cloned()
        .collect();
    if key.is_empty() {
        recent(log)
    } else {
        key.join(" | ")
    }
}

// ------------------------------ Downloads ------------------------------

/// Streams a file to disk and reports progress (0.0 - 1.0). Returns the file's SHA-256.
async fn download_with<F: FnMut(f32)>(url: &str, dest: &Path, mut on_frac: F) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(e2s)?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download failed (are you online?): {e}"))?
        .error_for_status()
        .map_err(e2s)?;

    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(dest).await.map_err(e2s)?;
    let mut hasher = Sha256::new();
    let mut done: u64 = 0;
    let mut last = 0f32;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(e2s)?;
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(e2s)?;
        done += chunk.len() as u64;
        if total > 0 {
            let frac = done as f32 / total as f32;
            if frac - last >= 0.01 {
                last = frac;
                on_frac(frac);
            }
        }
    }
    file.flush().await.map_err(e2s)?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// Same, but reports to the loading screen.
async fn download(
    app: &AppHandle,
    url: &str,
    dest: &Path,
    stage: &str,
    label: &str,
    base: f32,
    span: f32,
) -> Result<String, String> {
    download_with(url, dest, |frac| {
        progress(
            app,
            stage,
            format!("{label} {}%", (frac * 100.0) as u32),
            base + span * frac,
        );
    })
    .await
}

// -------------------------------- Java ---------------------------------

/// Finds <something>/bin/java.exe inside the unpacked JDK.
fn find_java(dir: &Path, depth: u32) -> Option<PathBuf> {
    if depth > 5 {
        return None;
    }
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if p.file_name().map(|n| n == "bin").unwrap_or(false) {
                let candidate = p.join("java.exe");
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
            if let Some(found) = find_java(&p, depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

fn extract(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(e2s)?;
    let mut zip = zip::ZipArchive::new(file).map_err(e2s)?;
    zip.extract(dest).map_err(e2s)
}

// ------------------------------- Spigot --------------------------------

/// Downloads and unpacks Portable Git where BuildTools looks for it.
async fn ensure_git(app: &AppHandle, work: &Path) -> Result<PathBuf, String> {
    let outer = work.join(GIT_FOLDER);
    let git_dir = outer.join("PortableGit");
    std::fs::create_dir_all(&git_dir).map_err(e2s)?;
    let installer = outer.join(format!("{GIT_FOLDER}.7z.exe"));

    progress(app, "spigot", "Downloading Git...", 42.0);
    download(app, GIT_URL, &installer, "spigot", "Downloading Git", 42.0, 4.0).await?;

    progress(app, "spigot", "Unpacking Git...", 46.0);
    let mut cmd = Command::new(&installer);
    cmd.arg("-y")
        .arg(format!("-o{}", git_dir.display()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let status = cmd
        .status()
        .await
        .map_err(|e| format!("Could not unpack Git: {e}"))?;
    let _ = std::fs::remove_file(&installer);
    if !status.success() || !git_dir.join("bin").join("sh.exe").is_file() {
        return Err("Git was downloaded but could not be unpacked.".into());
    }
    Ok(git_dir)
}

/// Spigot can't be downloaded as a ready-made jar, so we build it once with
/// Spigot's official BuildTools, then keep only the finished jar.
async fn ensure_spigot(
    app: &AppHandle,
    root: &Path,
    server_dir: &Path,
    java: &Path,
    version: &str,
) -> Result<(), String> {
    let jar = server_dir.join("spigot.jar");
    if jar.is_file() {
        return Ok(());
    }

    let work = root.join("buildtools");
    let _ = std::fs::remove_dir_all(&work); // always start clean
    std::fs::create_dir_all(&work).map_err(e2s)?;

    let tools = work.join("BuildTools.jar");
    progress(app, "spigot", "Downloading Spigot BuildTools...", 38.0);
    download(app, BUILDTOOLS_URL, &tools, "spigot", "Downloading BuildTools", 38.0, 4.0).await?;

    let git_dir = ensure_git(app, &work).await?;

    let java_home = java
        .parent()
        .and_then(|p| p.parent())
        .ok_or("Unexpected Java folder layout.")?
        .to_path_buf();
    let mut paths = vec![
        java_home.join("bin"),
        git_dir.join("cmd"),
        git_dir.join("bin"),
        git_dir.join("usr").join("bin"),
    ];
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    let new_path = std::env::join_paths(paths).map_err(e2s)?;

    // outside the work folder, so a retry doesn't re-download everything
    let m2 = root.join("m2");
    let mut cmd = Command::new(java);
    cmd.arg("-jar")
        .arg("BuildTools.jar")
        .arg("--rev")
        .arg(version)
        .current_dir(&work)
        .env("JAVA_HOME", &java_home)
        .env("PATH", new_path)
        // keep Maven's cache and Git's settings inside our folder, not the user's
        .env(
            "MAVEN_OPTS",
            format!(
                "-Dmaven.repo.local={} -Dmaven.wagon.http.retryHandler.count=6 -Daether.connector.http.retryHandler.count=6 -Daether.connector.connectTimeout=30000",
                m2.display()
            ),
        )
        .env("GIT_CONFIG_GLOBAL", work.join("gitconfig"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not run BuildTools: {e}"))?;
    let stdout = child.stdout.take().ok_or("Could not read BuildTools output.")?;
    let stderr = child.stderr.take().ok_or("Could not read BuildTools output.")?;

    let tail = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let tail_err = tail.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            remember(&tail_err, &line);
        }
    });

    let mut count: u32 = 0;
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        count += 1;
        remember(&tail, &line);
        if count % 10 == 0 {
            let pct = 46.0 + (count as f32 / 40.0).min(14.0);
            progress(
                app,
                "spigot",
                "Building the server (first time only, takes a few minutes)...",
                pct,
            );
        }
    }

    let status = child.wait().await.map_err(e2s)?;
    let built = work.join(format!("spigot-{version}.jar"));
    if !status.success() || !built.is_file() {
        let log_path = root.join("buildtools.log");
        if let Ok(l) = tail.lock() {
            let _ = std::fs::write(&log_path, l.join("\n"));
        }
        return Err(format!(
            "Building the server failed: {} (full log: {})",
            summary(&tail),
            log_path.display()
        ));
    }
    std::fs::copy(&built, &jar).map_err(e2s)?;

    // BuildTools leaves hundreds of MB behind; delete it.
    let m2_dir = root.join("m2");
    let _ = tokio::task::spawn_blocking(move || {
        let _ = std::fs::remove_dir_all(work);
        let _ = std::fs::remove_dir_all(m2_dir);
    })
    .await;
    Ok(())
}

fn write_defaults(server_dir: &Path) -> Result<(), String> {
    let props = server_dir.join("server.properties");
    if !props.exists() {
        // Local-only: the server is not reachable from outside this computer.
        let text = format!(
            "server-ip=127.0.0.1\nserver-port={SERVER_PORT}\nmotd=SSMC\nmax-players=8\nspawn-protection=0\n"
        );
        std::fs::write(props, text).map_err(e2s)?;
    }
    Ok(())
}

// ------------------------------ Server process ------------------------------

async fn start_server(
    app: &AppHandle,
    state: &ServerState,
    java: &Path,
    dir: &Path,
    settings: &Settings,
) -> Result<(), String> {
    progress(app, "starting", "Starting server...", 62.0);

    let ram = settings.ram_mb.clamp(1024, 16384);
    let mut cmd = Command::new(java);
    cmd.arg(format!("-Xms{}M", ram.min(512)))
        .arg(format!("-Xmx{ram}M"))
        .arg("-Dlog4j.skipJansi=true")
        // plain console so the app can read the log and send "stop" through stdin
        .arg("-Djline.terminal=jline.UnsupportedTerminal")
        .arg("-jar")
        .arg("spigot.jar")
        .arg("nogui") // no dashes: this is how 1.8.x expects it
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start Java: {e}"))?;
    let stdout = child.stdout.take().ok_or("Could not read server output.")?;
    let stderr = child.stderr.take().ok_or("Could not read server output.")?;
    let stdin = child.stdin.take().ok_or("Could not talk to the server.")?;
    *state.0.lock().await = Some(ServerHandle { child, stdin });

    let (tx, rx) = oneshot::channel::<Result<(), String>>();
    let tail = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));

    let app_err = app.clone();
    let tail_err = tail.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            remember(&tail_err, &line);
            let _ = app_err.emit("server-log", line);
        }
    });

    let app_out = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tx = Some(tx);
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            remember(&tail, &line);
            let _ = app_out.emit("server-log", line.clone());
            if line.contains("Done (") && line.contains("For help") {
                if let Some(t) = tx.take() {
                    let _ = t.send(Ok(()));
                }
            }
        }
        // stdout closed = the server process ended
        let handle = app_out.state::<ServerState>().0.lock().await.take();
        if let Some(mut h) = handle {
            let _ = h.child.wait().await;
        }
        if let Some(t) = tx.take() {
            let last = recent(&tail);
            let hint = if last.contains("Address already in use")
                || last.to_lowercase().contains("failed to bind")
            {
                format!(" Another program may be using port {SERVER_PORT}.")
            } else {
                String::new()
            };
            let _ = t.send(Err(format!(
                "The server stopped before it finished starting.{hint} Last messages: {last}"
            )));
        }
        let _ = app_out.emit("server-exit", ());
    });

    match tokio::time::timeout(Duration::from_secs(300), rx).await {
        Ok(Ok(Ok(()))) => {
            progress(app, "ready", "Server ready", 100.0);
            let _ = app.emit("server-ready", ());
            Ok(())
        }
        Ok(Ok(Err(msg))) => Err(msg),
        Ok(Err(_)) => Err("Server start was interrupted.".into()),
        Err(_) => {
            stop_inner(state).await;
            Err("The server took too long to start.".into())
        }
    }
}

/// Asks the server to save and stop; force-kills it if it takes too long.
async fn stop_inner(state: &ServerState) {
    let handle = state.0.lock().await.take();
    if let Some(mut h) = handle {
        let _ = h.stdin.write_all(b"stop\n").await;
        let _ = h.stdin.flush().await;
        if tokio::time::timeout(Duration::from_secs(15), h.child.wait())
            .await
            .is_err()
        {
            let _ = h.child.kill().await;
        }
    }
}

// -------------------------------- Commands --------------------------------

#[tauri::command]
fn get_status(app: AppHandle) -> Result<Status, String> {
    let dir = data_dir(&app)?;
    Ok(Status {
        eula_accepted: dir.join("eula_accepted").exists(),
    })
}

/// Only called after the user clicks "I agree" in the launcher.
#[tauri::command]
fn accept_eula(app: AppHandle) -> Result<(), String> {
    let dir = data_dir(&app)?;
    std::fs::write(dir.join("eula_accepted"), "accepted").map_err(e2s)
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Result<Settings, String> {
    Ok(load_settings(&data_dir(&app)?))
}

/// Saves the settings. They take effect when the server (re)starts.
#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let clean = Settings {
        ram_mb: settings.ram_mb.clamp(1024, 16384),
        online_mode: settings.online_mode,
    };
    let text = serde_json::to_string_pretty(&clean).map_err(e2s)?;
    std::fs::write(data_dir(&app)?.join("settings.json"), text).map_err(e2s)
}

#[tauri::command]
async fn stop_server(state: State<'_, ServerState>) -> Result<(), String> {
    stop_inner(&state).await;
    Ok(())
}

// ============================ Website + library ============================

//fn check_site_url(url: &str) -> Result<(), String> {
//    if url.starts_with(&format!("{SITE}/")) {
//        Ok(())
//    } else {
////        Err("That address is not allowed.".into())
//    }
//}


/// maps -> library/maps/worlds (zip), plugin -> library/plugins (jar)
fn library_dir(app: &AppHandle, kind: &str) -> Result<PathBuf, String> {
    let root = data_dir(app)?.join("library");
    let p = match kind {
        "map" => root.join("maps").join("worlds"),
        "plugin" => root.join("plugins"),
        _ => return Err("Unknown kind".into()),
    };
    std::fs::create_dir_all(&p).map_err(e2s)?;
    Ok(p)
}

fn secs(t: std::io::Result<std::time::SystemTime>) -> u64 {
    t.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// icon.png/jpg/jpeg/webp or server-icon.png from anywhere inside the world zip.
/// The shallowest file wins; at the same depth `icon.*` beats `server-icon.png`.
fn read_zip_icon(zip_path: &Path) -> Option<Vec<u8>> {
    use std::io::Read;
    let f = std::fs::File::open(zip_path).ok()?;
    let mut z = zip::ZipArchive::new(f).ok()?;
    let rank = |n: &str| -> Option<(usize, u8)> {
        let base = n.rsplit('/').next()?.to_lowercase();
        let pri = match base.as_str() {
            "icon.png" | "icon.jpg" | "icon.jpeg" | "icon.webp" => 0,
            "server-icon.png" => 1,
            _ => return None,
        };
        Some((n.matches('/').count(), pri))
    };
    let name = z
        .file_names()
        .filter_map(|n| rank(n).map(|r| (r, n.to_string())))
        .min_by_key(|(r, _)| *r)?
        .1;
    let mut buf = Vec::new();
    z.by_name(&name).ok()?.read_to_end(&mut buf).ok()?;
    Some(buf)
}

fn encode_png(img: image::DynamicImage) -> Option<Vec<u8>> {
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(img.to_rgba8())
        .write_to(&mut out, image::ImageFormat::Png)
        .ok()?;
    Some(out.into_inner())
}

/// Minecraft's server icon: exactly 64x64 PNG (centre-cropped to a square first).
fn icon_64(bytes: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    encode_png(img.resize_to_fill(64, 64, image::imageops::FilterType::Lanczos3))
}

/// What the app shows: always PNG, shrunk if bigger than 512px.
fn icon_display(bytes: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    let img = if img.width() > 512 || img.height() > 512 { img.thumbnail(512, 512) } else { img };
    encode_png(img)
}

/// Finds icon.png / icon.jpg / icon.jpeg / icon.webp (any letter case) in a folder.
fn read_folder_icon(dir: &Path) -> Option<Vec<u8>> {
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
        let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
        if stem == "icon" && matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp") {
            let bytes = std::fs::read(&p).ok()?;
            // detect the real format (handles mislabeled files), always output PNG
            let img = image::load_from_memory(&bytes).ok()?;
            let img = if img.width() > 512 || img.height() > 512 { img.thumbnail(512, 512) } else { img };
            return encode_png(img);
        }
    }
    None
}

fn jar_kind(p: &Path) -> String {
    let Ok(f) = std::fs::File::open(p) else { return "Other".into() };
    let Ok(z) = zip::ZipArchive::new(f) else { return "Other".into() };
    let has = |n: &str| z.file_names().any(|x| x == n);
    if has("plugin.yml") {
        "Plugin".into()
    } else if has("fabric.mod.json") || has("META-INF/mods.toml") || has("mcmod.info") {
        "Mod".into()
    } else {
        "Other".into()
    }
}

fn subdirs(dir: &Path) -> Vec<(String, PathBuf)> {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().is_dir())
                .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
                .collect()
        })
        .unwrap_or_default()
}

/// world -> plugins it always uses
#[tauri::command]
fn get_links(app: AppHandle) -> Result<serde_json::Value, String> {
    let t = std::fs::read_to_string(data_dir(&app)?.join("world_plugins.json")).unwrap_or_default();
    Ok(serde_json::from_str(&t).unwrap_or_else(|_| serde_json::json!({})))
}

#[tauri::command]
fn save_links(app: AppHandle, links: serde_json::Value) -> Result<(), String> {
    std::fs::write(data_dir(&app)?.join("world_plugins.json"), links.to_string()).map_err(e2s)
}

/// Puts (or updates) the server at the top of Minecraft's multiplayer list.
fn register_in_minecraft(name: &str, ip: &str, icon_b64: Option<String>) -> Result<(), String> {
    use fastnbt::Value;
    use std::collections::HashMap;
    let path = PathBuf::from(std::env::var("APPDATA").map_err(e2s)?)
        .join(".minecraft")
        .join("servers.dat");
    if !path.parent().map(|p| p.is_dir()).unwrap_or(false) {
        return Ok(()); // Minecraft is not installed
    }
    let mut root: HashMap<String, Value> = HashMap::new();
    if let Ok(bytes) = std::fs::read(&path) {
        let _ = std::fs::copy(&path, path.with_file_name("servers.dat_ssmc_backup"));
        if let Ok(Value::Compound(m)) = fastnbt::from_bytes::<Value>(&bytes) {
            root = m;
        }
    }
    let mut list = match root.remove("servers") {
        Some(Value::List(l)) => l,
        _ => Vec::new(),
    };
    // take out any earlier entry of ours (same name or address) so there are no duplicates
    let mut entry: HashMap<String, Value> = HashMap::new();
    list.retain(|v| {
        if let Value::Compound(m) = v {
            let same = |k: &str, want: &str| matches!(m.get(k), Some(Value::String(s)) if s == want);
            if same("name", name) || same("ip", ip) {
                entry = m.clone();
                return false;
            }
        }
        true
    });
    entry.insert("name".into(), Value::String(name.into()));
    entry.insert("ip".into(), Value::String(ip.into()));
    match icon_b64 {
        Some(i) => {
            entry.insert("icon".into(), Value::String(i));
        }
        None => {
            entry.remove("icon");
        }
    }
    list.insert(0, Value::Compound(entry));
    root.insert("servers".into(), Value::List(list));
    let out = fastnbt::to_bytes(&Value::Compound(root)).map_err(e2s)?;
    std::fs::write(&path, out).map_err(e2s)
}

#[tauri::command]
fn library_path(app: AppHandle) -> Result<String, String> {
    Ok(data_dir(&app)?.join("library").display().to_string())
}

/// Empties the plugins folder of the server, then copies in the chosen jars.
fn install_plugins(jars: &[PathBuf], server_dir: &Path) -> Result<(), String> {
    let plugins = server_dir.join("plugins");
    let _ = std::fs::remove_dir_all(&plugins);
    std::fs::create_dir_all(&plugins).map_err(e2s)?;
    for j in jars {
        let name = j.file_name().ok_or("Bad plugin file name")?;
        std::fs::copy(j, plugins.join(name)).map_err(e2s)?;
    }
    Ok(())
}

// ================================ LAN play ================================

/// The computer's IPv4 address on the local network. No data is sent: connecting
/// a UDP socket only makes Windows pick the right network adapter.
#[tauri::command]
fn get_lan_ip() -> Result<String, String> {
    for target in ["8.8.8.8:80", "192.168.0.1:80", "192.168.1.1:80", "10.0.0.1:80"] {
        if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
            if sock.connect(target).is_ok() {
                if let Ok(addr) = sock.local_addr() {
                    let ip = addr.ip().to_string();
                    if ip != "0.0.0.0" {
                        return Ok(ip);
                    }
                }
            }
        }
    }
    Err("Could not find your network address.".into())
}

/// Adds a Windows Firewall rule that lets this app's Java accept connections on
/// private (home/LAN) networks only. Windows asks the player for permission.
#[tauri::command]
async fn allow_firewall(app: AppHandle, version: String) -> Result<(), String> {
    let root = data_dir(&app)?;
    let java = find_java(&root.join("jdk").join(java_for(&version)), 0)
    .ok_or("Java is not installed yet.")?;
    let java_path = java.display().to_string().replace('\'', "''");
    let script = format!(
        "Start-Process -FilePath netsh -ArgumentList 'advfirewall firewall add rule name=\"SSMC - Java (LAN)\" dir=in action=allow program=\"{java_path}\" enable=yes profile=private' -Verb RunAs -Wait"
    );
    let mut cmd = Command::new("powershell");
    cmd.arg("-NoProfile").arg("-Command").arg(script);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let status = cmd.status().await.map_err(e2s)?;
    if status.success() {
        Ok(())
    } else {
        Err("Windows did not give permission. Press Yes when it asks.".into())
    }
}

const VERSIONS: [&str; 14] = [
    "1.8.8", "1.9.4", "1.10.2", "1.11.2", "1.12.2", "1.13.2", "1.14.4", "1.15.2",
    "1.16.5", "1.17.1", "1.18.2", "1.19.4", "1.20.4", "1.21.1",
];

fn valid_version(v: &str) -> Result<(), String> {
    if VERSIONS.contains(&v) { Ok(()) } else { Err("Unknown server version.".into()) }
}

/// Java each Minecraft version needs.
fn java_for(v: &str) -> &'static str {
    let minor: u32 = v.split('.').nth(1).and_then(|m| m.parse().ok()).unwrap_or(8);
    match minor {
        0..=16 => "8",
        17..=20 => "17",
        _ => "21",
    }
}

fn server_dir_for(root: &Path, version: &str) -> PathBuf {
    root.join("servers").join(version)
}

/// Moves the old single-server layout into the new per-version one.
fn migrate_old(root: &Path) {
    let old_server = root.join("server");
    let new_server = server_dir_for(root, "1.8.8");
    if old_server.join("spigot.jar").is_file() && !new_server.exists() {
        let _ = std::fs::create_dir_all(root.join("servers"));
        let _ = std::fs::rename(&old_server, &new_server);
    }
    let old_java = root.join("java");
    let new_java = root.join("jdk").join("8");
    if old_java.is_dir() && !new_java.exists() {
        let _ = std::fs::create_dir_all(root.join("jdk"));
        let _ = std::fs::rename(&old_java, &new_java);
    }
}

fn java_url(major: &str) -> Result<String, String> {
    if std::env::consts::ARCH != "x86_64" {
        return Err("This version needs a 64-bit (Intel/AMD) Windows PC.".into());
    }
    Ok(format!(
        "https://api.adoptium.net/v3/binary/latest/{major}/ga/windows/x64/jdk/hotspot/normal/eclipse"
    ))
}

async fn ensure_java(app: &AppHandle, root: &Path, major: &str) -> Result<PathBuf, String> {
    let java_dir = root.join("jdk").join(major);
    if let Some(p) = find_java(&java_dir, 0) {
        return Ok(p);
    }
    let _ = std::fs::remove_dir_all(&java_dir);
    std::fs::create_dir_all(&java_dir).map_err(e2s)?;
    let archive = root.join("java.zip");
    progress(app, "java", format!("Downloading Java {major}..."), 1.0);
    download(app, &java_url(major)?, &archive, "java", &format!("Downloading Java {major}"), 1.0, 34.0).await?;
    progress(app, "java", "Unpacking Java...", 36.0);
    let (a, d) = (archive.clone(), java_dir.clone());
    tokio::task::spawn_blocking(move || extract(&a, &d))
        .await
        .map_err(e2s)??;
    let _ = std::fs::remove_file(&archive);
    find_java(&java_dir, 0)
        .ok_or_else(|| "Java was unpacked but no java program was found.".to_string())
}

/// Downloads Java + builds Spigot for one version into servers/<version>.
async fn install_version(app: &AppHandle, root: &Path, version: &str) -> Result<(), String> {
    valid_version(version)?;
    migrate_old(root);
    let dir = server_dir_for(root, version);
    std::fs::create_dir_all(&dir).map_err(e2s)?;
    std::fs::write(dir.join("eula.txt"), EULA_TEXT).map_err(e2s)?;
    progress(app, "check", "Checking files...", 1.0);
    let java = ensure_java(app, root, java_for(version)).await?;
    ensure_spigot(app, root, &dir, &java, version).await?;
    write_defaults(&dir)?;
    progress(app, "ready", "Ready", 100.0);
    Ok(())
}

#[tauri::command]
async fn prepare_server(app: AppHandle) -> Result<(), String> {
    let root = data_dir(&app)?;
    if !root.join("eula_accepted").exists() {
        return Err("The Minecraft EULA has not been accepted.".into());
    }
    install_version(&app, &root, "1.8.8").await
}

#[tauri::command]
async fn install_server(app: AppHandle, version: String) -> Result<(), String> {
    let root = data_dir(&app)?;
    if !root.join("eula_accepted").exists() {
        return Err("The Minecraft EULA has not been accepted.".into());
    }
    install_version(&app, &root, &version).await
}

#[derive(Serialize)]
struct VersionInfo {
    version: String,
    installed: bool,
}

#[tauri::command]
fn list_versions(app: AppHandle) -> Result<Vec<VersionInfo>, String> {
    let root = data_dir(&app)?;
    migrate_old(&root);
    Ok(VERSIONS
        .iter()
        .map(|v| VersionInfo {
            version: v.to_string(),
            installed: server_dir_for(&root, v).join("spigot.jar").is_file(),
        })
        .collect())
}

/// Types a line into the running server's console.
#[tauri::command]
async fn send_command(state: State<'_, ServerState>, command: String) -> Result<(), String> {
    let mut guard = state.0.lock().await;
    let h = guard.as_mut().ok_or("The server is not running.")?;
    h.stdin
        .write_all(format!("{}\n", command.trim()).as_bytes())
        .await
        .map_err(e2s)?;
    h.stdin.flush().await.map_err(e2s)
}

/// File and folder names must be plain names, never paths.
fn safe_segment(s: &str) -> Result<&str, String> {
    let ok = !s.is_empty()
        && s.len() <= 120
        && s != "."
        && !s.contains("..")
        && s.chars().all(|c| {
            c.is_alphanumeric()
                || matches!(c, '-' | '_' | ' ' | '.' | '(' | ')' | '[' | ']' | '&' | '\'' | '!' | '+' | ',')
        });
    if ok { Ok(s) } else { Err(format!("Invalid name: {s}")) }
}

#[tauri::command]
fn delete_items(app: AppHandle, kind: String, rels: Vec<String>) -> Result<(), String> {
    let root = library_dir(&app, &kind)?;
    for r in rels {
        let p = rel_path(&root, &r)?;
        if p.is_file() {
            std::fs::remove_file(&p).map_err(e2s)?;
        }
    }
    Ok(())
}

/// Minecraft version a world was last saved in (from level.dat inside the zip).
fn world_version(zip_path: &Path) -> String {
    use fastnbt::Value;
    use std::io::Read;
    let Ok(f) = std::fs::File::open(zip_path) else { return String::new() };
    let Ok(mut z) = zip::ZipArchive::new(f) else { return String::new() };
    let Some(name) = z
        .file_names()
        .filter(|n| n.rsplit('/').next() == Some("level.dat"))
        .min_by_key(|n| n.matches('/').count())
        .map(String::from)
    else {
        return String::new();
    };
    let mut raw = Vec::new();
    if z.by_name(&name).ok().and_then(|mut e| e.read_to_end(&mut raw).ok()).is_none() {
        return String::new();
    }
    let mut dec = Vec::new();
    if flate2::read::GzDecoder::new(&raw[..]).read_to_end(&mut dec).is_err() {
        return String::new();
    }
    let Ok(Value::Compound(root)) = fastnbt::from_bytes::<Value>(&dec) else { return String::new() };
    let Some(Value::Compound(data)) = root.get("Data") else { return String::new() };
    if let Some(Value::Compound(v)) = data.get("Version") {
        if let Some(Value::String(n)) = v.get("Name") {
            return n.clone();
        }
    }
    if data.contains_key("DataVersion") {
        String::new()
    } else {
        "1.8 or older".into() // worlds from 1.8 and earlier carry no version name
    }
}

#[derive(Serialize)]
struct LibFile {
    file: String,
    folder: String,
    rel: String,
    size: u64,
    modified: u64,
    created: u64,
    icon: Option<String>,
    kind: String,
    version: String,
}

#[derive(Serialize)]
struct FolderInfo {
    name: String,
    icon: Option<String>,
    count: usize,
}

#[derive(Serialize)]
struct Library {
    plugin_folders: Vec<FolderInfo>,
    maps: Vec<LibFile>,
    folders: Vec<FolderInfo>,
    plugins: Vec<LibFile>,
}

fn data_url(b: Vec<u8>) -> String {
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(b))
}

fn read_files(dir: &Path, ext_want: &str, folder: &str) -> Vec<LibFile> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
            if !p.is_file() || ext != ext_want {
                continue;
            }
            let file = e.file_name().to_string_lossy().into_owned();
            let rel = if folder.is_empty() { file.clone() } else { format!("{folder}/{file}") };
            let meta = e.metadata().ok();
            let (icon, kind, version) = if ext_want == "zip" {
                let icon = read_zip_icon(&p).and_then(|b| icon_display(&b)).map(data_url);
                let kind = if folder.is_empty() { "None".to_string() } else { folder.to_string() };
                (icon, kind, world_version(&p))
            } else {
                (None, jar_kind(&p), String::new())
            };
            out.push(LibFile {
                file,
                folder: folder.into(),
                rel,
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                modified: meta.as_ref().map(|m| secs(m.modified())).unwrap_or(0),
                created: meta.as_ref().map(|m| secs(m.created())).unwrap_or(0),
                icon,
                kind,
                version,
            });
        }
    }
    out
}

#[tauri::command]
fn list_library(app: AppHandle) -> Result<Library, String> {
    let (maps, folders) = scan_library(&library_dir(&app, "map")?, "zip");
    let (plugins, plugin_folders) = scan_library(&library_dir(&app, "plugin")?, "jar");
    Ok(Library { maps, folders, plugins, plugin_folders })
}

#[tauri::command]
fn import_files(
    app: AppHandle,
    kind: String,
    folder: Option<String>,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let mut dest = library_dir(&app, &kind)?;
    if let Some(f) = folder.filter(|f| !f.is_empty()) {
        dest = folder_dir(&dest, &f)?;
        std::fs::create_dir_all(&dest).map_err(e2s)?;
    }
    let want = if kind == "map" { "zip" } else { "jar" };
    let mut done = Vec::new();
    for p in paths {
        let src = PathBuf::from(&p);
        let name = src.file_name().ok_or("Bad file name")?.to_owned();
        let label = name.to_string_lossy().into_owned();
        let ext = src.extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
        if ext != want {
            return Err(format!("{label} is not a .{want} file."));
        }
        let f = std::fs::File::open(&src).map_err(e2s)?;
        zip::ZipArchive::new(f).map_err(|_| format!("{label} is not a valid .{want} file."))?;
        std::fs::copy(&src, dest.join(&name)).map_err(e2s)?;
        done.push(label);
    }
    Ok(done)
}

#[tauri::command]
fn open_library(app: AppHandle, kind: Option<String>, folder: Option<String>) -> Result<(), String> {
    let target = match kind.as_deref() {
        Some(k) => {
            let mut d = library_dir(&app, k)?;
            if let Some(f) = folder.filter(|f| !f.is_empty()) {
                d = folder_dir(&d, &f)?;
            }
            d
        }
        None => {
            library_dir(&app, "map")?;
            library_dir(&app, "plugin")?;
            data_dir(&app)?.join("library")
        }
    };
    std::process::Command::new("explorer").arg(&target).spawn().map_err(e2s)?;
    Ok(())
}

#[tauri::command]
async fn start_game(
    app: AppHandle,
    state: State<'_, ServerState>,
    version: String,
    map_file: String,
    plugin_files: Vec<String>,
    lan: bool,
) -> Result<(), String> {
    valid_version(&version)?;
    stop_inner(&state).await;

    let root = data_dir(&app)?;
    if !root.join("eula_accepted").exists() {
        return Err("The Minecraft EULA has not been accepted.".into());
    }
    let server_dir = server_dir_for(&root, &version);
    if !server_dir.join("spigot.jar").is_file() {
        return Err("This server version is not downloaded yet.".into());
    }
    let java = find_java(&root.join("jdk").join(java_for(&version)), 0)
        .ok_or("Java for this server is missing. Download the server again.")?;

    let mut map_zip = library_dir(&app, "map")?;
    for seg in map_file.split('/') {
        map_zip = map_zip.join(safe_segment(seg)?);
    }
    if !map_zip.is_file() {
        return Err("That world file is missing. Import it again.".into());
    }
    let plugin_dir = library_dir(&app, "plugin")?;
    let mut jars = Vec::new();
    for f in &plugin_files {
        let mut p = plugin_dir.clone();
        for seg in f.split('/') {
            p = p.join(safe_segment(seg)?);
        }
        if !p.is_file() {
            return Err(format!("The plugin {f} is missing. Import it again."));
        }
        jars.push(p);
    }

    progress(&app, "world", "Setting up the world...", 10.0);
    let (z, s) = (map_zip.clone(), server_dir.clone());
    tokio::task::spawn_blocking(move || install_world(&z, &s))
        .await
        .map_err(e2s)??;

    progress(&app, "bot", "Installing plugins...", 40.0);
    let s = server_dir.clone();
    tokio::task::spawn_blocking(move || install_plugins(&jars, &s))
        .await
        .map_err(e2s)??;

    std::fs::write(server_dir.join("eula.txt"), EULA_TEXT).map_err(e2s)?;
    let settings = load_settings(&root);
    apply_network_settings(&server_dir, &settings, lan)?;

    let world_name = map_zip
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    set_property(&server_dir.join("server.properties"), "motd", &world_name)?;
    let icon = read_zip_icon(&map_zip).and_then(|b| icon_64(&b));
    let icon_path = server_dir.join("server-icon.png");
    match &icon {
        Some(b) => {
            let _ = std::fs::write(&icon_path, b);
        }
        None => {
            let _ = std::fs::remove_file(&icon_path);
        }
    }

    start_server(&app, &state, &java, &server_dir, &settings).await?;
    let b64 = icon.map(|b| base64::engine::general_purpose::STANDARD.encode(b));
    let _ = register_in_minecraft("ssmc", "localhost", b64);
    Ok(())
}

#[tauri::command]
async fn restart_server(
    app: AppHandle,
    state: State<'_, ServerState>,
    lan: bool,
    version: String,
) -> Result<(), String> {
    valid_version(&version)?;
    stop_inner(&state).await;
    let root = data_dir(&app)?;
    let server_dir = server_dir_for(&root, &version);
    let java = find_java(&root.join("jdk").join(java_for(&version)), 0)
        .ok_or("The server is not installed yet.")?;
    let settings = load_settings(&root);
    apply_network_settings(&server_dir, &settings, lan)?;
    start_server(&app, &state, &java, &server_dir, &settings).await
}

// ============================ Starting a game ============================

/// Finds the folder that holds level.dat (the world), however deep the zip put it.
fn find_level_dir(dir: &Path, depth: u32) -> Option<PathBuf> {
    if dir.join("level.dat").is_file() {
        return Some(dir.to_path_buf());
    }
    if depth > 3 {
        return None;
    }
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if let Some(found) = find_level_dir(&p, depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

/// Replaces the server's world with the one inside the map's zip.
fn install_world(zip_path: &Path, server_dir: &Path) -> Result<(), String> {
    let tmp = server_dir.join("_world_tmp");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(e2s)?;
    extract(zip_path, &tmp)?;
    let src = find_level_dir(&tmp, 0)
        .ok_or("This map has no world in it (level.dat was not found in the zip).")?;
    for name in ["world", "world_nether", "world_the_end"] {
        let _ = std::fs::remove_dir_all(server_dir.join(name));
    }
    std::fs::rename(&src, server_dir.join("world")).map_err(e2s)?;
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(())
}

/// Empties the plugins folder, then installs the chosen bot (if any).
fn install_bot(bot: Option<&Path>, server_dir: &Path) -> Result<(), String> {
    let plugins = server_dir.join("plugins");
    let _ = std::fs::remove_dir_all(&plugins);
    std::fs::create_dir_all(&plugins).map_err(e2s)?;
    let Some(bot) = bot else { return Ok(()) };

    let is_jar = bot
        .extension()
        .and_then(|x| x.to_str())
        .map(|x| x.eq_ignore_ascii_case("jar"))
        .unwrap_or(false);
    if is_jar {
        let name = bot.file_name().ok_or("Bad bot file name")?;
        std::fs::copy(bot, plugins.join(name)).map_err(e2s)?;
        return Ok(());
    }

    let tmp = server_dir.join("_bot_tmp");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(e2s)?;
    extract(bot, &tmp)?;
    let src = if tmp.join("plugins").is_dir() {
        tmp.join("plugins")
    } else {
        tmp.clone()
    };
    for entry in std::fs::read_dir(&src).map_err(e2s)?.flatten() {
        std::fs::rename(entry.path(), plugins.join(entry.file_name())).map_err(e2s)?;
    }
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(())
}

/// Sets who can reach the server: only this PC, or anyone on the local network.
fn apply_network_settings(server_dir: &Path, settings: &Settings, lan: bool) -> Result<(), String> {
    let props = server_dir.join("server.properties");
    set_property(&props, "online-mode", if settings.online_mode { "true" } else { "false" })?;
    set_property(&props, "server-ip", if lan { "" } else { "127.0.0.1" })
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ServerState::default())
        .invoke_handler(tauri::generate_handler![
            get_status, accept_eula, prepare_server, install_server, list_versions,
            send_command, stop_server, list_library, get_links, save_links, import_files,
            open_library, library_path, get_lan_ip, allow_firewall, start_game,
            restart_server, get_settings, save_settings, delete_items, create_folder, move_items,delete_folder, rename_item, rename_folder
        ])
        .build(tauri::generate_context!())
        .expect("error while building the app");

    app.run(|handle, event| {
        // Make sure the Minecraft server is shut down cleanly when the app closes.
        if let RunEvent::Exit = event {
            let state = handle.state::<ServerState>();
            tauri::async_runtime::block_on(stop_inner(&state));
        }
    });
}