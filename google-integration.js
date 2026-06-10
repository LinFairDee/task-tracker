/* ============================================================
   TASKFLOW — GOOGLE API INTEGRATION
   Uses Google Identity Services (GIS) for OAuth +
   direct fetch() calls with Bearer token (no GAPI key needed)
   ============================================================ */

"use strict";

// ── State ─────────────────────────────────────────────────────
const G = {
  isSignedIn: false,
  accessToken: null,
  userInfo: null,
  tokenClient: null,
  driveFiles: [],
  driveCurrentFolder: "root",
  driveFolderStack: [],
  gmailFolder: "INBOX",
  gmailMessages: [],
  gcalEvents: [],
  chatSpaces: [],
  currentDriveView: "grid",
  drivePickerFiles: [],
};

// Base URLs
const GMAIL_BASE    = "https://gmail.googleapis.com/gmail/v1/users/me";
const DRIVE_BASE    = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD  = "https://www.googleapis.com/upload/drive/v3";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const CHAT_BASE     = "https://chat.googleapis.com/v1";

// ── Load GIS only (no gapi needed) ───────────────────────────
(function loadGIS() {
  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.async = true;
  script.defer = true;
  script.onload = () => console.log("[Google] GIS loaded");
  document.head.appendChild(script);
})();

// ── Token refresh ─────────────────────────────────────────────
G.tokenExpiry = 0;          // epoch ms when current token expires
G._refreshPromise = null;   // dedup concurrent refresh calls

function scheduleTokenRefresh() {
  // Tokens last 3600s — refresh 5 min early
  const msUntilRefresh = Math.max(0, G.tokenExpiry - Date.now() - 300000);
  clearTimeout(G._refreshTimer);
  G._refreshTimer = setTimeout(() => silentTokenRefresh(), msUntilRefresh);
}

async function silentTokenRefresh() {
  if (G._refreshPromise) return G._refreshPromise;
  G._refreshPromise = new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) { reject(new Error("GIS not ready")); return; }
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CONFIG.clientId,
      scope: GOOGLE_CONFIG.scopes,
      callback: (resp) => {
        G._refreshPromise = null;
        if (resp.error) { reject(new Error(resp.error)); return; }
        G.accessToken  = resp.access_token;
        G.tokenExpiry  = Date.now() + 3600000;
        scheduleTokenRefresh();
        resolve(resp.access_token);
      },
    });
    tc.requestAccessToken({ prompt: "" }); // silent — no popup if already consented
  });
  return G._refreshPromise;
}

// ── Generic authenticated fetch helper ───────────────────────
async function gFetch(url, options = {}, _retried = false) {
  if (!G.accessToken) throw new Error("Not signed in");
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${G.accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  // Auto-refresh on 401 (expired token) and retry once
  if (res.status === 401 && !_retried) {
    console.log("[Google] Token expired, refreshing silently…");
    try {
      await silentTokenRefresh();
      return gFetch(url, options, true);  // retry with new token
    } catch (e) {
      // Silent refresh failed (needs user interaction)
      showToast("Session expired — please sign in again", "warning");
      if (typeof signOutAndReturnToLogin === "function") signOutAndReturnToLogin(true);
      throw new Error("Session expired");
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }
  return res.json();
}

async function gFetchRaw(url, options = {}, _retried = false) {
  if (!G.accessToken) throw new Error("Not signed in");
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${G.accessToken}`,
      ...(options.headers || {}),
    },
  });

  if (res.status === 401 && !_retried) {
    try {
      await silentTokenRefresh();
      return gFetchRaw(url, options, true);
    } catch (e) {
      throw new Error("Session expired");
    }
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

// ── Auth ──────────────────────────────────────────────────────

// Called from login screen "Sign in with Google" button
function startGoogleLogin() {
  if (GOOGLE_CONFIG.clientId.startsWith("YOUR_CLIENT_ID")) {
    alert("Please update config.js with your Google API credentials first.");
    return;
  }
  if (!window.google?.accounts?.oauth2) {
    // GIS not loaded yet, retry
    const btn = document.getElementById("googleLoginBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
    setTimeout(startGoogleLogin, 1000);
    return;
  }
  G.loginMode = "login"; // distinguish from "connect" inside app
  signInGoogle();
}

// Called from inside the app (if ever needed to reconnect)
function handleGoogleAuth() {
  if (G.isSignedIn) { signOutGoogle(); return; }
  G.loginMode = "connect";
  signInGoogle();
}

function signInGoogle() {
  try {
    G.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CONFIG.clientId,
      scope: GOOGLE_CONFIG.scopes,
      callback: handleTokenResponse,
    });
    G.tokenClient.requestAccessToken({ prompt: "" });
  } catch (e) {
    console.error("[Google Auth] Failed:", e);
    showToast("Sign-in failed: " + e.message, "error");
    showGooglePanel();
  }
}

async function handleTokenResponse(resp) {
  if (resp.error) {
    const msg = resp.error_description || resp.error;
    showToast("Google sign-in failed: " + msg, "error");
    if (typeof showGooglePanel === "function") showGooglePanel();
    return;
  }
  G.accessToken = resp.access_token;
  G.isSignedIn  = true;
  G.tokenExpiry = Date.now() + 3600000; // tokens last 1 hour
  scheduleTokenRefresh();               // auto-refresh 5 min before expiry

  await fetchGoogleUserInfo();

  if (G.loginMode === "login" && typeof onGoogleLoginSuccess === "function") {
    // Full app login — pass user info to app.js
    await onGoogleLoginSuccess(G.userInfo);
  } else {
    // Just connecting Google inside app (fallback)
    showToast(`Connected as ${G.userInfo?.email || "Google account"}`, "success");
    refreshCurrentGoogleViews();
    if (typeof updateDriveSyncStatus === "function") updateDriveSyncStatus("synced");
  }
}

function signOutGoogle(silent = false) {
  if (G.accessToken) {
    try { google.accounts.oauth2.revoke(G.accessToken, () => {}); } catch(e) {}
  }
  G.isSignedIn  = false;
  G.accessToken = null;
  G.userInfo    = null;
  G.driveDataFileId = null;
  if (!silent) {
    showToast("Signed out of Google", "info");
    refreshCurrentGoogleViews();
    if (typeof updateDriveSyncStatus === "function") updateDriveSyncStatus("offline");
  }
}

async function fetchGoogleUserInfo() {
  try {
    G.userInfo = await gFetch("https://www.googleapis.com/oauth2/v3/userinfo");
    console.log("[Google] Signed in as:", G.userInfo.email);
  } catch (e) {
    console.warn("[Google] Could not fetch userinfo:", e.message);
    G.userInfo = { name: "Google User", email: "", sub: "", picture: "" };
  }
}

function updateGoogleBtn() {
  const label = document.getElementById("googleBtnLabel");
  const btn   = document.getElementById("googleConnectBtn");
  if (!label) return;
  if (G.isSignedIn) {
    label.textContent = G.userInfo?.email?.split("@")[0] || "Connected";
    if (btn) btn.style.color = "var(--success)";
  } else {
    label.textContent = "Connect Google";
    if (btn) btn.style.color = "";
  }
}

function refreshCurrentGoogleViews() {
  if (S.currentView === "gmail")      setupGmailView();
  else if (S.currentView === "drive") setupDriveView();
  else if (S.currentView === "gcalendar") setupGCalView();
  else if (S.currentView === "chat")  setupChatView();
}

// ── GMAIL ─────────────────────────────────────────────────────
function setupGmailView() {
  const prompt = document.getElementById("gmailConnectPrompt");
  const panel  = document.getElementById("gmailPanel");
  if (!G.isSignedIn) { prompt?.classList.remove("hidden"); panel?.classList.add("hidden"); return; }
  prompt?.classList.add("hidden"); panel?.classList.remove("hidden");
  loadGmailFolder("INBOX");
}

async function loadGmailFolder(folder) {
  G.gmailFolder = folder;
  document.querySelectorAll(".gmail-folders li").forEach(li => li.classList.remove("active"));
  event?.currentTarget?.classList.add("active");

  const emailList = document.getElementById("emailList");
  emailList.innerHTML = loadingHTML();

  try {
    const q = { INBOX:"in:inbox", SENT:"in:sent", STARRED:"is:starred", DRAFT:"in:drafts", SPAM:"in:spam" }[folder] || "";
    const params = new URLSearchParams({ maxResults: 30, ...(q ? { q } : {}) });
    const data = await gFetch(`${GMAIL_BASE}/messages?${params}`);
    const messages = data.messages || [];

    if (!messages.length) {
      emailList.innerHTML = emptyHTML("No messages");
      return;
    }

    // Fetch metadata in parallel
    const details = await Promise.all(
      messages.slice(0, 25).map(m =>
        gFetch(`${GMAIL_BASE}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)
      )
    );

    G.gmailMessages = details;
    renderEmailList(details);

    // Badge counts
    const unread = details.filter(m => m.labelIds?.includes("UNREAD")).length;
    if (folder === "INBOX") {
      const el = document.getElementById("inboxCount");
      if (el) el.textContent = unread || "";
      const badge = document.getElementById("gmailBadge");
      if (badge) badge.textContent = unread || "";
    }
  } catch (e) {
    emailList.innerHTML = errorHTML("Failed to load Gmail: " + e.message);
    console.error("[Gmail]", e);
  }
}

function getHeader(headers, name) {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

function renderEmailList(messages) {
  document.getElementById("emailList").innerHTML = messages.map(m => {
    const from    = getHeader(m.payload?.headers, "From");
    const subject = getHeader(m.payload?.headers, "Subject") || "(no subject)";
    const date    = getHeader(m.payload?.headers, "Date");
    const unread  = m.labelIds?.includes("UNREAD");
    const name    = from.replace(/<[^>]+>/, "").trim() || from;
    return `
      <div class="email-item ${unread ? "unread" : ""}" onclick="readEmail('${m.id}')">
        <div class="avatar avatar-sm" style="background:${strColor(name)}">${(name[0] || "?").toUpperCase()}</div>
        <div style="min-width:0">
          <div class="email-from">${esc(name)}</div>
          <div class="email-subject">${esc(subject)}</div>
          <div class="email-snippet">${esc((m.snippet||"").slice(0,80))}</div>
        </div>
        <div class="email-date">${formatEmailDate(date)}</div>
      </div>`;
  }).join("");
}

async function readEmail(msgId) {
  const reader = document.getElementById("emailReader");
  reader.innerHTML = loadingHTML("padding:20px");
  try {
    const msg     = await gFetch(`${GMAIL_BASE}/messages/${msgId}?format=full`);
    const from    = getHeader(msg.payload?.headers, "From");
    const to      = getHeader(msg.payload?.headers, "To");
    const subject = getHeader(msg.payload?.headers, "Subject") || "(no subject)";
    const date    = getHeader(msg.payload?.headers, "Date");
    const body    = extractEmailBody(msg.payload);

    reader.innerHTML = `
      <div class="email-reader-content">
        <div class="email-reader-header">
          <h4>${esc(subject)}</h4>
          <div class="email-reader-meta">
            <strong>From:</strong> ${esc(from)}<br>
            <strong>To:</strong> ${esc(to)}<br>
            <strong>Date:</strong> ${esc(date)}
          </div>
        </div>
        <div class="email-reader-body">${esc(stripHtml(body))}</div>
        <div class="email-actions">
          <button class="btn btn-sm btn-outline" onclick="replyToEmail('${esc(from)}','${esc(subject)}')">
            <i data-lucide="reply"></i> Reply
          </button>
          <button class="btn btn-sm btn-outline" onclick="createTaskFromEmail('${esc(subject)}')">
            <i data-lucide="plus-circle"></i> Create Task
          </button>
        </div>
      </div>`;

    // Mark as read (silent fail is ok)
    gFetch(`${GMAIL_BASE}/messages/${msgId}/modify`, {
      method: "POST",
      body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
    }).catch(() => {});

    lucide.createIcons({ nodes: [reader] });
  } catch (e) {
    reader.innerHTML = errorHTML("Could not load email: " + e.message, "padding:16px");
  }
}

function extractEmailBody(payload) {
  if (!payload) return "";
  const decode = (data) => decodeURIComponent(escape(atob(data.replace(/-/g, "+").replace(/_/g, "/"))));
  if (payload.body?.data) return decode(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      if ((part.mimeType === "text/plain" || part.mimeType === "text/html") && part.body?.data)
        return decode(part.body.data);
      if (part.parts) { const sub = extractEmailBody(part); if (sub) return sub; }
    }
  }
  return "";
}

function stripHtml(html) {
  const d = document.createElement("div");
  d.innerHTML = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  return d.textContent || d.innerText || html;
}

function replyToEmail(from, subject) {
  document.getElementById("emailTo").value = from;
  document.getElementById("emailSubject").value = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
  document.getElementById("composeModal").classList.remove("hidden");
  lucide.createIcons();
}

function createTaskFromEmail(subject) {
  openTaskModal(null, {});
  setTimeout(() => { document.getElementById("taskTitle").value = subject; }, 50);
  showToast("Task pre-filled from email", "info");
}

async function sendEmail() {
  const to      = document.getElementById("emailTo").value.trim();
  const subject = document.getElementById("emailSubject").value.trim();
  const body    = document.getElementById("emailBody").value.trim();
  if (!to || !subject) { showToast("Fill in To and Subject", "warning"); return; }

  const raw = btoa(unescape(encodeURIComponent(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  try {
    await gFetch(`${GMAIL_BASE}/messages/send`, { method: "POST", body: JSON.stringify({ raw }) });
    showToast("Email sent!", "success");
    closeModal("composeModal");
  } catch (e) {
    showToast("Send failed: " + e.message, "error");
  }
}

async function searchGmail(query) {
  if (!G.isSignedIn || !query.trim()) return;
  try {
    const data = await gFetch(`${GMAIL_BASE}/messages?${new URLSearchParams({ q: query, maxResults: 15 })}`);
    const msgs = data.messages || [];
    if (!msgs.length) { document.getElementById("emailList").innerHTML = emptyHTML("No results"); return; }
    const details = await Promise.all(
      msgs.slice(0, 10).map(m =>
        gFetch(`${GMAIL_BASE}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)
      )
    );
    renderEmailList(details);
  } catch (e) {}
}

function refreshGmail() { loadGmailFolder(G.gmailFolder); }

function formatEmailDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── DRIVE TASK STORAGE ────────────────────────────────────────
G.driveDataFileId = null;
const DRIVE_DATA_FILENAME = "taskflow-data.json";

async function loadTasksFromDrive() {
  if (!G.isSignedIn) return false;
  if (typeof updateDriveSyncStatus === "function") updateDriveSyncStatus("syncing");
  try {
    // Search for the data file
    const params = new URLSearchParams({
      q: `name='${DRIVE_DATA_FILENAME}' and trashed=false`,
      fields: "files(id,name,modifiedTime)",
      pageSize: 1,
    });
    const res = await gFetch(`${DRIVE_BASE}/files?${params}`);
    const files = res.files || [];
    if (!files.length) {
      console.log("[Drive] No data file found, starting fresh");
      if (typeof updateDriveSyncStatus === "function") updateDriveSyncStatus("synced");
      return false;
    }

    G.driveDataFileId = files[0].id;
    const raw = await gFetchRaw(`${DRIVE_BASE}/files/${G.driveDataFileId}?alt=media`);
    const data = await raw.json();

    // Merge into app state — Drive wins for tasks if it has data, otherwise keep local
    if (Array.isArray(data.tasks) && data.tasks.length > 0) {
      // Merge: Drive tasks take priority, but keep any local tasks not yet on Drive
      const driveIds = new Set(data.tasks.map(t => t.id));
      const localOnly = S.tasks.filter(t => !driveIds.has(t.id));
      S.tasks = [...data.tasks, ...localOnly];
    }
    if (Array.isArray(data.activityLog))  S.activityLog  = data.activityLog;
    if (Array.isArray(data.users)) {
      data.users.forEach(u => {
        if (!S.users.find(x => x.id === u.id)) S.users.push(u);
      });
    }

    console.log(`[Drive] Loaded ${S.tasks.length} tasks from Drive`);
    if (typeof updateDriveSyncStatus === "function") updateDriveSyncStatus("synced");
    return true;
  } catch (e) {
    console.warn("[Drive] Load failed:", e.message);
    if (typeof updateDriveSyncStatus === "function") updateDriveSyncStatus("error");
    return false;
  }
}

async function saveTasksToDrive() {
  if (!G.isSignedIn) return;
  if (typeof updateDriveSyncStatus === "function") updateDriveSyncStatus("syncing");
  try {
    const payload = JSON.stringify({
      tasks:       S.tasks,
      users:       S.users,
      activityLog: S.activityLog.slice(0, 100),
      savedAt:     new Date().toISOString(),
    });

    if (G.driveDataFileId) {
      // Update existing file (media only, no metadata)
      await fetch(`${DRIVE_UPLOAD}/files/${G.driveDataFileId}?uploadType=media`, {
        method:  "PATCH",
        headers: { Authorization: `Bearer ${G.accessToken}`, "Content-Type": "application/json" },
        body:    payload,
      });
    } else {
      // Create new file
      const form = new FormData();
      form.append("metadata", new Blob([JSON.stringify({ name: DRIVE_DATA_FILENAME })], { type: "application/json" }));
      form.append("file",     new Blob([payload], { type: "application/json" }));
      const res  = await fetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${G.accessToken}` },
        body:    form,
      });
      const file = await res.json();
      G.driveDataFileId = file.id;
    }

    console.log("[Drive] Tasks saved");
    if (typeof updateDriveSyncStatus === "function") updateDriveSyncStatus("synced");
  } catch (e) {
    console.warn("[Drive] Save failed:", e.message);
    if (typeof updateDriveSyncStatus === "function") updateDriveSyncStatus("error");
  }
}

// ── GOOGLE DRIVE (file browser) ───────────────────────────────
function setupDriveView() {
  const prompt = document.getElementById("driveConnectPrompt");
  const panel  = document.getElementById("drivePanel");
  if (!G.isSignedIn) { prompt?.classList.remove("hidden"); panel?.classList.add("hidden"); return; }
  prompt?.classList.add("hidden"); panel?.classList.remove("hidden");
  navigateDrive("root");
}

async function navigateDrive(folderId, folderName = "My Drive") {
  G.driveCurrentFolder = folderId;
  if (folderId === "root") {
    G.driveFolderStack = [{ id: "root", name: "My Drive" }];
  } else {
    const idx = G.driveFolderStack.findIndex(f => f.id === folderId);
    if (idx === -1) G.driveFolderStack.push({ id: folderId, name: folderName });
    else G.driveFolderStack = G.driveFolderStack.slice(0, idx + 1);
  }
  updateDriveBreadcrumb();

  const container = document.getElementById("driveFileList");
  container.innerHTML = loadingHTML("grid-column:1/-1;padding:20px");

  try {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "files(id,name,mimeType,size,modifiedTime,webViewLink)",
      orderBy: "folder,name",
      pageSize: 50,
    });
    const data = await gFetch(`${DRIVE_BASE}/files?${params}`);
    G.driveFiles = data.files || [];
    renderDriveFiles(G.driveFiles);
  } catch (e) {
    const projectId = GOOGLE_CONFIG.clientId.split("-")[0];
    const enableUrl = `https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=${projectId}`;
    if (e.message.includes("has not been used") || e.message.includes("disabled")) {
      container.innerHTML = `
        <div style="grid-column:1/-1;padding:30px;text-align:center">
          <div style="font-size:32px;margin-bottom:12px">⚠️</div>
          <h3 style="color:var(--warning);margin-bottom:8px">Google Drive API not enabled</h3>
          <p style="color:var(--text-2);margin-bottom:16px;max-width:400px;margin-inline:auto">
            You need to enable the Drive API in your Google Cloud project before using Drive.
          </p>
          <a href="${enableUrl}" target="_blank" class="btn btn-primary">
            Enable Drive API →
          </a>
          <p style="color:var(--text-3);font-size:11px;margin-top:12px">After enabling, wait ~1 minute then refresh this page.</p>
        </div>`;
    } else {
      container.innerHTML = `<div style="grid-column:1/-1;padding:20px;text-align:center;color:var(--danger)">${esc(e.message)}</div>`;
    }
  }
}

function updateDriveBreadcrumb() {
  const bc = document.getElementById("driveBreadcrumb");
  if (!bc) return;
  bc.innerHTML = G.driveFolderStack.map((f, i) =>
    i < G.driveFolderStack.length - 1
      ? `<span onclick="navigateDrive('${f.id}','${esc(f.name)}')">${esc(f.name)}</span><span style="color:var(--text-3);margin:0 4px">/</span>`
      : `<span>${esc(f.name)}</span>`
  ).join("");
}

function renderDriveFiles(files) {
  const container = document.getElementById("driveFileList");
  if (!container) return;
  container.className = G.currentDriveView === "list" ? "drive-grid list-mode" : "drive-grid";

  if (!files.length) {
    container.innerHTML = `<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--text-3)">Folder is empty</div>`;
    return;
  }
  container.innerHTML = files.map(f => {
    const isFolder = f.mimeType === "application/vnd.google-apps.folder";
    return `
      <div class="drive-file" onclick="${isFolder ? `navigateDrive('${f.id}','${esc(f.name)}')` : `openDriveFile('${esc(f.webViewLink||"")}')` }">
        <i data-lucide="${getDriveIcon(f.mimeType)}" style="color:${getDriveColor(f.mimeType)}"></i>
        <div class="drive-file-name">${esc(f.name)}</div>
        ${f.size ? `<div class="drive-file-size">${formatBytes(+f.size)}</div>` : ""}
      </div>`;
  }).join("");
  lucide.createIcons();
}

function openDriveFile(url) { if (url) window.open(url, "_blank"); }

function toggleDriveView() {
  G.currentDriveView = G.currentDriveView === "grid" ? "list" : "grid";
  const btn = document.getElementById("driveViewToggle");
  if (btn) {
    btn.querySelector("[data-lucide]").setAttribute("data-lucide", G.currentDriveView === "grid" ? "grid" : "list");
    lucide.createIcons({ nodes: [btn] });
  }
  renderDriveFiles(G.driveFiles);
}

function triggerFileUpload() { document.getElementById("fileUploadInput").click(); }

async function uploadFilesToDrive(files) {
  for (const file of files) {
    showToast(`Uploading ${file.name}…`, "info");
    try {
      const metadata = JSON.stringify({ name: file.name, parents: [G.driveCurrentFolder] });
      const form = new FormData();
      form.append("metadata", new Blob([metadata], { type: "application/json" }));
      form.append("file", file);

      const res = await fetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name`, {
        method: "POST",
        headers: { Authorization: `Bearer ${G.accessToken}` },
        body: form,
      });
      const data = await res.json();
      showToast(`Uploaded: ${data.name}`, "success");
      navigateDrive(G.driveCurrentFolder);
    } catch (e) {
      showToast(`Upload failed: ${file.name}`, "error");
    }
  }
}

async function searchDrive(query) {
  if (!G.isSignedIn) return;
  if (!query.trim()) { renderDriveFiles(G.driveFiles); return; }
  try {
    const params = new URLSearchParams({
      q: `name contains '${query.replace(/'/g, "\\'")}' and trashed=false`,
      fields: "files(id,name,mimeType,size,webViewLink)",
      pageSize: 30,
    });
    const data = await gFetch(`${DRIVE_BASE}/files?${params}`);
    renderDriveFiles(data.files || []);
  } catch (e) {}
}

function formatBytes(b) {
  if (!b) return "";
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}

function getDriveIcon(m) {
  if (m.includes("folder"))       return "folder";
  if (m.includes("image"))        return "image";
  if (m.includes("video"))        return "video";
  if (m.includes("audio"))        return "music";
  if (m.includes("pdf"))          return "file-text";
  if (m.includes("spreadsheet") || m.includes("excel")) return "table-2";
  if (m.includes("presentation"))return "presentation";
  if (m.includes("document") || m.includes("word")) return "file-text";
  if (m.includes("zip"))          return "archive";
  return "file";
}

function getDriveColor(m) {
  if (m.includes("folder"))       return "#f59e0b";
  if (m.includes("image"))        return "#a855f7";
  if (m.includes("video"))        return "#ef4444";
  if (m.includes("spreadsheet"))  return "#22c55e";
  if (m.includes("presentation")) return "#f97316";
  if (m.includes("document"))     return "#3b82f6";
  return "var(--text-3)";
}

// Drive file picker (attach to task)
async function openDrivePicker() {
  if (!G.isSignedIn) { showToast("Connect Google Drive first", "warning"); return; }
  G.drivePickerSelected = [];
  document.getElementById("drivePickerModal").classList.remove("hidden");
  const list = document.getElementById("drivePickerList");
  list.innerHTML = loadingHTML("padding:20px");
  try {
    const params = new URLSearchParams({
      q: "trashed=false",
      fields: "files(id,name,mimeType,webViewLink)",
      orderBy: "modifiedTime desc",
      pageSize: 50,
    });
    const data = await gFetch(`${DRIVE_BASE}/files?${params}`);
    G.drivePickerFiles = data.files || [];
    renderDrivePickerList(G.drivePickerFiles);
  } catch (e) {
    list.innerHTML = errorHTML("Failed to load files: " + e.message, "padding:16px");
  }
  lucide.createIcons();
}

function renderDrivePickerList(files) {
  document.getElementById("drivePickerList").innerHTML = files.map(f => `
    <div class="picker-file ${G.drivePickerSelected.includes(f.id) ? "selected" : ""}"
         onclick="togglePickerFile('${f.id}')">
      <i data-lucide="${getDriveIcon(f.mimeType)}" style="color:${getDriveColor(f.mimeType)}"></i>
      <span class="picker-file-name">${esc(f.name)}</span>
      ${G.drivePickerSelected.includes(f.id) ? `<i data-lucide="check" style="color:var(--accent)"></i>` : ""}
    </div>`).join("") || emptyHTML("No files found");
  lucide.createIcons();
}

function togglePickerFile(id) {
  const idx = G.drivePickerSelected.indexOf(id);
  if (idx === -1) G.drivePickerSelected.push(id);
  else G.drivePickerSelected.splice(idx, 1);
  renderDrivePickerList(G.drivePickerFiles);
}

function searchDrivePicker(q) {
  const filtered = q.trim()
    ? G.drivePickerFiles.filter(f => f.name.toLowerCase().includes(q.toLowerCase()))
    : G.drivePickerFiles;
  renderDrivePickerList(filtered);
}

function confirmDriveAttachments() {
  G.drivePickerSelected.forEach(fileId => {
    const f = G.drivePickerFiles.find(x => x.id === fileId);
    if (!f || S.taskAttachments.find(a => a.driveId === fileId)) return;
    S.taskAttachments.push({ id: uid(), name: f.name, url: f.webViewLink, driveId: fileId });
  });
  renderModalAttachments();
  closeModal("drivePickerModal");
  showToast(`${G.drivePickerSelected.length} file(s) attached`, "success");
  G.drivePickerSelected = [];
}

// ── GOOGLE CALENDAR ───────────────────────────────────────────
function setupGCalView() {
  const prompt = document.getElementById("gcalConnectPrompt");
  const panel  = document.getElementById("gcalPanel");
  if (!G.isSignedIn) { prompt?.classList.remove("hidden"); panel?.classList.add("hidden"); return; }
  prompt?.classList.add("hidden"); panel?.classList.remove("hidden");
  renderGCalMonth();
}

async function renderGCalMonth() {
  const year  = S.gcalMonth.getFullYear();
  const month = S.gcalMonth.getMonth();
  document.getElementById("gcalMonthTitle").textContent =
    S.gcalMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const timeMin = new Date(year, month, 1).toISOString();
  const timeMax = new Date(year, month + 1, 1).toISOString();

  try {
    const params = new URLSearchParams({ timeMin, timeMax, singleEvents: true, orderBy: "startTime", maxResults: 100 });
    const data = await gFetch(`${CALENDAR_BASE}/calendars/primary/events?${params}`);
    G.gcalEvents = data.items || [];
  } catch (e) {
    console.warn("[GCal]", e.message);
    G.gcalEvents = [];
  }
  buildGCalGrid(year, month);
}

function buildGCalGrid(year, month) {
  const firstDay    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today       = new Date(); today.setHours(0, 0, 0, 0);
  const days        = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const palette     = ["#6c63ff", "#22c55e", "#f59e0b", "#3b82f6", "#ef4444", "#a855f7"];

  let html = days.map(d => `<div class="gcal-day-header">${d}</div>`).join("");
  for (let i = 0; i < firstDay; i++) html += `<div class="gcal-day other-month"></div>`;

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr  = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const isToday  = new Date(year, month, day).getTime() === today.getTime();
    const dayTasks = S.tasks.filter(t => t.dueDate === dateStr);
    const dayEvents = G.gcalEvents.filter(e => (e.start?.date || e.start?.dateTime || "").slice(0, 10) === dateStr);

    html += `
      <div class="gcal-day${isToday ? " today" : ""}">
        <div class="gcal-day-num">${day}</div>
        ${dayTasks.slice(0, 2).map(t =>
          `<div class="gcal-event" style="background:${STATUS_COLORS[t.status]}22;color:${STATUS_COLORS[t.status]}"
                onclick="openTaskModal('${t.id}')" title="${esc(t.title)}">
            ✓ ${esc(t.title)}
          </div>`
        ).join("")}
        ${dayEvents.slice(0, 2).map((e, i) => {
          let timeLabel = "";
          if (e.start?.dateTime) {
            const t = new Date(e.start.dateTime);
            timeLabel = t.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
                         .replace(":00", "").toLowerCase() + " ";
          }
          const loc = e.location ? ", " + e.location.split(",")[0] : "";
          return `<div class="gcal-event" style="background:${palette[i % palette.length]}22;color:${palette[i % palette.length]}"
                onclick="window.open('${esc(e.htmlLink || "")}','_blank')" title="${esc(e.summary || "")}${esc(loc)}">
            ${esc(e.summary || "(No title)")}${timeLabel ? `<span style="opacity:.7;font-size:9px"> · ${timeLabel}${esc(loc)}</span>` : ""}
          </div>`;
        }).join("")}
        ${(dayTasks.length + dayEvents.length) > 4
          ? `<div style="font-size:9px;color:var(--text-3)">+${dayTasks.length + dayEvents.length - 4} more</div>`
          : ""}
      </div>`;
  }

  const totalCells = Math.ceil((firstDay + daysInMonth) / 7) * 7;
  for (let i = 1; i <= totalCells - firstDay - daysInMonth; i++)
    html += `<div class="gcal-day other-month"></div>`;

  document.getElementById("gcalGrid").innerHTML = html;
}

function changeGCalMonth(dir) {
  S.gcalMonth = new Date(S.gcalMonth.getFullYear(), S.gcalMonth.getMonth() + dir, 1);
  renderGCalMonth();
}

async function createGCalEvent() {
  if (!G.isSignedIn) { showToast("Connect Google Calendar first", "warning"); return; }
  const title = document.getElementById("gcalEventTitle").value.trim();
  const start = document.getElementById("gcalEventStart").value;
  const end   = document.getElementById("gcalEventEnd").value;
  const desc  = document.getElementById("gcalEventDesc").value.trim();
  if (!title || !start || !end) { showToast("Fill in title, start, and end", "warning"); return; }

  try {
    await gFetch(`${CALENDAR_BASE}/calendars/primary/events`, {
      method: "POST",
      body: JSON.stringify({
        summary: title, description: desc,
        start: { dateTime: new Date(start).toISOString() },
        end:   { dateTime: new Date(end).toISOString() },
      }),
    });
    showToast("Event created!", "success");
    closeModal("gcalEventModal");
    renderGCalMonth();
  } catch (e) {
    showToast("Failed: " + e.message, "error");
  }
}

async function syncTasksToCalendar() {
  if (!G.isSignedIn) { showToast("Connect Google Calendar first", "warning"); return; }
  const tasks = S.tasks.filter(t => t.dueDate && t.status !== "done").slice(0, 10);
  let synced = 0;
  for (const task of tasks) {
    try {
      await gFetch(`${CALENDAR_BASE}/calendars/primary/events`, {
        method: "POST",
        body: JSON.stringify({
          summary: `[Task] ${task.title}`,
          description: task.description || "",
          start: { dateTime: new Date(task.dueDate + "T09:00:00").toISOString() },
          end:   { dateTime: new Date(task.dueDate + "T10:00:00").toISOString() },
        }),
      });
      synced++;
    } catch (e) { console.warn("Sync failed:", task.title); }
  }
  showToast(`Synced ${synced} task(s) to Google Calendar`, "success");
  renderGCalMonth();
}

async function createCalendarEventFromTask() {
  if (!G.isSignedIn) { showToast("Connect Google Calendar first", "warning"); return; }
  const title   = document.getElementById("taskTitle").value.trim();
  const dueDate = document.getElementById("taskDueDate").value;
  const desc    = document.getElementById("taskDesc").value.trim();
  if (!title) { showToast("Enter a task title first", "warning"); return; }

  const start = new Date(dueDate ? dueDate + "T09:00:00" : Date.now());
  const end   = new Date(start.getTime() + 3600000);

  try {
    await gFetch(`${CALENDAR_BASE}/calendars/primary/events`, {
      method: "POST",
      body: JSON.stringify({
        summary: `[Task] ${title}`, description: desc,
        start: { dateTime: start.toISOString() },
        end:   { dateTime: end.toISOString() },
      }),
    });
    showToast("Added to Google Calendar!", "success");
  } catch (e) {
    showToast("Calendar error: " + e.message, "error");
  }
}

// ── GOOGLE CHAT ───────────────────────────────────────────────
function setupChatView() {
  const prompt = document.getElementById("chatConnectPrompt");
  const panel  = document.getElementById("chatPanel");
  if (!G.isSignedIn) { prompt?.classList.remove("hidden"); panel?.classList.add("hidden"); return; }
  prompt?.classList.add("hidden"); panel?.classList.remove("hidden");
  loadChatSpaces();
}

async function loadChatSpaces() {
  const spacesList = document.getElementById("chatSpacesList");
  spacesList.innerHTML = loadingHTML("padding:20px");
  try {
    const data = await gFetch(`${CHAT_BASE}/spaces`);
    G.chatSpaces = data.spaces || [];
    if (!G.chatSpaces.length) {
      spacesList.innerHTML = `
        <div style="padding:16px;text-align:center;color:var(--text-3)">
          <p style="margin-bottom:8px">No spaces found.</p>
          <a href="https://chat.google.com" target="_blank" class="btn btn-sm btn-outline" style="margin-top:4px">Open Google Chat ↗</a>
        </div>`;
      return;
    }
    spacesList.innerHTML = G.chatSpaces.map(s => `
      <div class="chat-space-item" onclick="loadChatMessages('${s.name}','${esc(s.displayName || s.name)}',this)">
        <i data-lucide="${s.type === "DIRECT_MESSAGE" ? "message-circle" : "hash"}"></i>
        <span>${esc(s.displayName || s.name.split("/").pop())}</span>
      </div>`).join("");
    lucide.createIcons();
  } catch (e) {
    const projectId = GOOGLE_CONFIG.clientId.split("-")[0];
    const configUrl  = `https://console.developers.google.com/apis/api/chat.googleapis.com/config?project=${projectId}`;
    const enableUrl  = `https://console.developers.google.com/apis/api/chat.googleapis.com/overview?project=${projectId}`;
    const is404      = e.message.includes("404") || e.message.includes("HTTP 404");
    const isDisabled = e.message.includes("has not been used") || e.message.includes("disabled");
    const isForbidden= e.message.includes("403") || e.message.includes("PERMISSION_DENIED");

    if (is404) {
      // 404 = API enabled but Chat App not configured in Cloud Console
      spacesList.innerHTML = `
        <div style="padding:20px;text-align:center">
          <div style="font-size:28px;margin-bottom:10px">🔧</div>
          <p style="color:var(--warning);font-weight:700;margin-bottom:8px">Chat App not configured</p>
          <p style="color:var(--text-2);font-size:12px;margin-bottom:4px">The Chat API is enabled but needs a Chat App set up.</p>
          <p style="color:var(--text-3);font-size:11px;margin-bottom:14px">Go to the Configuration tab and fill in:</p>
          <div style="background:var(--bg-primary);border-radius:8px;padding:10px 14px;text-align:left;font-size:11px;color:var(--text-2);margin-bottom:14px;line-height:2">
            <b>App name:</b> TaskFlow<br>
            <b>Avatar URL:</b> any image URL<br>
            <b>Functionality:</b> ✅ Receive 1:1 messages<br>
            <b>Connection:</b> HTTP endpoint → <code style="background:var(--border);padding:1px 4px;border-radius:3px">https://localhost</code>
          </div>
          <a href="${configUrl}" target="_blank" class="btn btn-primary btn-sm" style="display:inline-flex;margin-bottom:10px">
            Open Configuration →
          </a>
          <br>
          <a href="https://chat.google.com" target="_blank" class="btn btn-outline btn-sm">
            <i data-lucide="external-link"></i> Open Google Chat directly
          </a>
        </div>`;
    } else if (isDisabled) {
      spacesList.innerHTML = `
        <div style="padding:20px;text-align:center">
          <div style="font-size:28px;margin-bottom:10px">⚠️</div>
          <p style="color:var(--warning);font-weight:600;margin-bottom:6px">Google Chat API not enabled</p>
          <p style="color:var(--text-3);font-size:11px;margin-bottom:14px">Enable it in Google Cloud Console first.</p>
          <a href="${enableUrl}" target="_blank" class="btn btn-primary btn-sm">Enable Chat API →</a>
        </div>`;
    } else if (isForbidden) {
      spacesList.innerHTML = `
        <div style="padding:20px;text-align:center">
          <div style="font-size:28px;margin-bottom:10px">🔒</div>
          <p style="color:var(--danger);font-weight:600;margin-bottom:6px">Access denied (403)</p>
          <p style="color:var(--text-3);font-size:11px;margin-bottom:10px">Your admin may need to allow this app, or try re-authorizing.</p>
          <button class="btn btn-sm btn-outline" onclick="recheckChatScopes()" style="margin-bottom:8px">Re-authorize scopes</button><br>
          <a href="https://chat.google.com" target="_blank" class="btn btn-sm btn-primary" style="margin-top:6px">Open Google Chat</a>
        </div>`;
    } else {
      spacesList.innerHTML = `
        <div style="padding:20px;text-align:center">
          <p style="color:var(--danger);margin-bottom:10px;font-size:12px">${esc(e.message)}</p>
          <a href="https://chat.google.com" target="_blank" class="btn btn-sm btn-primary">Open Google Chat</a>
        </div>`;
    }
    lucide.createIcons();
  }
}

// Force re-consent for Chat scopes
function recheckChatScopes() {
  if (!window.google?.accounts?.oauth2) return;
  const tc = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CONFIG.clientId,
    scope: "https://www.googleapis.com/auth/chat.spaces https://www.googleapis.com/auth/chat.messages",
    callback: async (resp) => {
      if (resp.error) { showToast("Re-auth failed: " + resp.error, "error"); return; }
      G.accessToken = resp.access_token;
      G.tokenExpiry = Date.now() + 3600000;
      showToast("Scopes updated, retrying…", "info");
      loadChatSpaces();
    },
  });
  tc.requestAccessToken({ prompt: "consent" });
}

// Cache sender names to avoid re-fetching on every message render
G.senderCache = {};

async function resolveSenderName(senderResource) {
  if (!senderResource) return "Unknown";
  if (G.senderCache[senderResource]) return G.senderCache[senderResource];
  try {
    const user = await gFetch(`${CHAT_BASE}/${senderResource}`);
    const name = user.displayName || user.name || senderResource.split("/").pop();
    G.senderCache[senderResource] = name;
    return name;
  } catch (e) {
    // Fallback: shorten long numeric IDs to "User XXXX"
    const userId = senderResource.split("/").pop();
    const fallback = /^\d{10,}$/.test(userId) ? "User …" + userId.slice(-4) : userId;
    G.senderCache[senderResource] = fallback;
    return fallback;
  }
}

// Current open space (for reply)
G.currentSpaceName = null;

async function loadChatMessages(spaceName, displayName, el) {
  document.querySelectorAll(".chat-space-item").forEach(x => x.classList.remove("active"));
  el?.classList.add("active");
  G.currentSpaceName = spaceName;

  const header    = document.getElementById("chatMessagesHeader");
  const nameEl    = document.getElementById("chatSpaceName");
  const link      = document.getElementById("chatOpenLink");
  const msgList   = document.getElementById("chatMessagesList");
  const inputArea = document.getElementById("chatInputArea");

  header?.classList.remove("hidden");
  inputArea?.classList.remove("hidden");
  if (nameEl) nameEl.textContent = displayName;
  if (link)   link.href = `https://chat.google.com/room/${spaceName.split("/").pop()}`;

  // Set current user avatar in input bar
  const cu = typeof getCurrentUser === "function" ? getCurrentUser() : null;
  const inputAv = document.getElementById("chatInputAvatar");
  if (inputAv && cu) {
    inputAv.style.background = cu.color;
    inputAv.textContent = typeof initials === "function" ? initials(cu.name) : "?";
  }

  msgList.innerHTML = loadingHTML("padding:20px");

  try {
    // Fetch members and messages in parallel
    const membersParams = new URLSearchParams({ pageSize: 100 });
    const msgParams     = new URLSearchParams({ pageSize: 50, orderBy: "createTime desc" });
    const [membersData, data] = await Promise.all([
      gFetch(`${CHAT_BASE}/${spaceName}/members?${membersParams}`).catch(() => ({})),
      gFetch(`${CHAT_BASE}/${spaceName}/messages?${msgParams}`),
    ]);

    // Build sender cache from space members (most reliable source of display names)
    (membersData.memberships || []).forEach(mem => {
      const u = mem.member;
      if (u?.name && u.displayName) G.senderCache[u.name] = u.displayName;
    });

    const msgs = (data.messages || []).reverse();
    if (!msgs.length) { msgList.innerHTML = emptyHTML("No messages in this space"); return; }

    // Also pull displayName from message payload itself if present
    msgs.forEach(m => {
      if (m.sender?.name && m.sender.displayName && !G.senderCache[m.sender.name]) {
        G.senderCache[m.sender.name] = m.sender.displayName;
      }
    });

    renderChatMessages(msgs);
    // Scroll to bottom
    msgList.scrollTop = msgList.scrollHeight;

  } catch (e) {
    msgList.innerHTML = `
      <div style="padding:20px;text-align:center">
        <p style="color:var(--danger);margin-bottom:8px;font-size:13px">${esc(e.message)}</p>
        <a href="https://chat.google.com" target="_blank" class="btn btn-sm btn-outline">Open Google Chat ↗</a>
      </div>`;
    lucide.createIcons();
  }
}

function renderChatMessages(msgs) {
  const msgList = document.getElementById("chatMessagesList");
  const myName  = G.userInfo?.name ? `users/${G.userInfo.sub}` : null;

  msgList.innerHTML = msgs.map(m => {
    const senderResource = m.sender?.name || "";
    const userId = senderResource.split("/").pop();
    // Priority: member-list cache → message displayName → email prefix → last 4 of ID
    const name = G.senderCache[senderResource]
              || m.sender?.displayName
              || (m.sender?.email ? m.sender.email.split("@")[0] : null)
              || (/^\d{8,}$/.test(userId) ? "User …" + userId.slice(-4) : userId)
              || "Unknown";
    const isMe = senderResource === myName;
    const time  = m.createTime
      ? new Date(m.createTime).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
      : "";
    const avatarLetter = name[0]?.toUpperCase() || "?";
    const text  = esc(m.text || m.fallbackText || "");

    return `
      <div class="chat-message ${isMe ? "chat-message-me" : ""}">
        <div class="avatar avatar-sm" style="background:${strColor(name)}">${avatarLetter}</div>
        <div class="chat-message-content">
          <div class="sender ${isMe ? "sender-me" : ""}">${esc(name)}</div>
          <div class="message-bubble ${isMe ? "bubble-me" : ""}">${text || "<em style='opacity:.5'>attachment</em>"}</div>
          <div class="message-time">${time}</div>
        </div>
      </div>`;
  }).join("");
}

async function sendChatMessage() {
  const input = document.getElementById("chatMessageInput");
  const text  = input?.value.trim();
  if (!text || !G.currentSpaceName) return;

  input.value = "";
  input.disabled = true;

  try {
    await gFetch(`${CHAT_BASE}/${G.currentSpaceName}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    showToast("Message sent", "success");
    // Reload messages to show the new one
    await loadChatMessages(G.currentSpaceName,
      document.getElementById("chatSpaceName")?.textContent || "",
      document.querySelector(".chat-space-item.active"));
  } catch (e) {
    showToast("Failed to send: " + e.message, "error");
    input.value = text; // restore text on failure
  } finally {
    input.disabled = false;
    input.focus();
  }
}

function refreshChatMessages() {
  if (!G.currentSpaceName) return;
  loadChatMessages(G.currentSpaceName,
    document.getElementById("chatSpaceName")?.textContent || "",
    document.querySelector(".chat-space-item.active"));
}

// ── UI helpers ────────────────────────────────────────────────
function loadingHTML(style = "") {
  return `<div style="text-align:center;color:var(--text-3);${style}">
    <i data-lucide="loader" style="width:20px;height:20px;animation:spin 1s linear infinite"></i>
    <p style="margin-top:6px">Loading…</p>
  </div>`;
}
function emptyHTML(msg) {
  return `<div style="padding:30px;text-align:center;color:var(--text-3)">${esc(msg)}</div>`;
}
function errorHTML(msg, style = "") {
  return `<div style="color:var(--danger);${style}">${esc(msg)}</div>`;
}

// ── Helpers ───────────────────────────────────────────────────
function strColor(str) {
  const palette = ["#6c63ff","#a855f7","#ec4899","#ef4444","#f97316","#f59e0b","#22c55e","#14b8a6","#3b82f6","#06b6d4"];
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return palette[Math.abs(h) % palette.length];
}
