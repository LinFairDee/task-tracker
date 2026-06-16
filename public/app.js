/* ============================================================
   TASKFLOW — MAIN APPLICATION
   ============================================================ */

"use strict";

// ── State ────────────────────────────────────────────────────
let S = {
  users: [],
  currentUserId: null,
  tasks: [],
  activityLog: [],
  notifications: [],
  currentView: "dashboard",
  theme: "light",
  calMonth: new Date(),
  gcalMonth: new Date(),
  selectedCalDate: null,
  editingTaskId: null,
  taskLabels: [],          // for modal
  taskSubtasks: [],        // for modal
  taskComments: [],        // for modal
  taskAttachments: [],     // for modal
  drivePickerSelected: [],
  sidebarOpen: true,
  filters: {},
};

const AVATAR_COLORS = [
  "#6c63ff","#a855f7","#ec4899","#ef4444","#f97316",
  "#f59e0b","#22c55e","#14b8a6","#3b82f6","#06b6d4",
];
const STATUSES = ["todo","inprogress","review","done"];
const STATUS_LABELS = { todo:"To Do", inprogress:"In Progress", review:"Review", done:"Done" };
const STATUS_COLORS = { todo:"#94a3b8", inprogress:"#3b82f6", review:"#a855f7", done:"#22c55e" };
const PRIORITY_ORDER = { urgent:4, high:3, medium:2, low:1 };
const SAMPLE_LABELS = ["Bug","Feature","Design","Backend","Frontend","Urgent","Research","Testing"];
const LABEL_COLORS = {
  "Bug": "#ef4444", "Feature": "#a855f7", "Design": "#3b82f6", "Backend": "#f97316",
  "Frontend": "#14b8a6", "Urgent": "#ef4444", "Research": "#6366f1", "Testing": "#22c55e",
  "Docs": "#f59e0b", "DevOps": "#ec4899"
};
const LABEL_COLOR_PALETTE = ["#ef4444","#a855f7","#3b82f6","#f97316","#14b8a6","#6366f1","#22c55e","#f59e0b","#ec4899","#06b6d4"];
function getLabelColor(label) {
  if (LABEL_COLORS[label]) return LABEL_COLORS[label];
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = label.charCodeAt(i) + ((hash << 5) - hash);
  return LABEL_COLOR_PALETTE[Math.abs(hash) % LABEL_COLOR_PALETTE.length];
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  loadFromLocalStorage();   // always load local first as fast fallback
  buildColorPicker();
  setupKeyboardShortcuts();
  lucide.createIcons();
  setInterval(checkDueTasks, 60000);
  // Auto-resume Google session if token still valid (GIS handles this)
  // Show login screen
  showGooglePanel();
  document.getElementById("loginScreen").classList.remove("hidden");
  document.getElementById("appContainer").classList.add("hidden");
});

// ── Storage — Local ───────────────────────────────────────────
function saveToLocalStorage() {
  localStorage.setItem("tf_state", JSON.stringify({
    users: S.users,
    tasks: S.tasks,
    activityLog: S.activityLog.slice(0, 200),
    notifications: S.notifications.slice(0, 50),
    theme: S.theme,
    currentUserId: S.currentUserId,
  }));
}

function loadFromLocalStorage() {
  const raw = localStorage.getItem("tf_state");
  if (!raw) return;
  try {
    const d = JSON.parse(raw);
    S.users            = d.users || [];
    S.tasks            = d.tasks || [];
    S.activityLog      = d.activityLog || [];
    S.notifications    = d.notifications || [];
    S.theme            = d.theme || "light";
    S.currentUserId    = d.currentUserId || null;
    // One-time migration: the app used to default to dark. Flip anyone still
    // carrying that old default to the new light default (honors later choices).
    if (!localStorage.getItem("tf_theme_migrated")) {
      S.theme = "light";
      localStorage.setItem("tf_theme_migrated", "1");
    }
    document.documentElement.setAttribute("data-theme", S.theme);
    updateThemeIcon();
  } catch(e) { console.error("Storage load error", e); }
}

// ── Storage — unified save (local + Drive) ────────────────────
function saveToStorage() {
  saveToLocalStorage();
  // Drive save is debounced so rapid edits don't spam the API
  clearTimeout(S._driveSaveTimer);
  S._driveSaveTimer = setTimeout(() => {
    if (typeof saveTasksToDrive === "function") saveTasksToDrive();
  }, 1500);
}

// backwards-compat alias
function loadFromStorage() { loadFromLocalStorage(); }

// ── Theme ─────────────────────────────────────────────────────
function toggleTheme() {
  S.theme = S.theme === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", S.theme);
  updateThemeIcon();
  saveToStorage();
}
function updateThemeIcon() {
  const icon = document.getElementById("themeIcon");
  const label = document.getElementById("themeLabel");
  if (!icon) return;
  if (S.theme === "dark") {
    icon.setAttribute("data-lucide", "sun");
    label.textContent = "Light Mode";
  } else {
    icon.setAttribute("data-lucide", "moon");
    label.textContent = "Dark Mode";
  }
  lucide.createIcons();
}

// ── Keyboard shortcuts ────────────────────────────────────────
function setupKeyboardShortcuts() {
  document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "k") {
      e.preventDefault();
      document.getElementById("globalSearch").focus();
    }
    if (e.key === "Escape") {
      closeAllModals();
      hideDropdowns();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "n" && !isModalOpen()) {
      e.preventDefault();
      openTaskModal();
    }
  });
  document.addEventListener("click", e => {
    if (!e.target.closest("#userMenuDropdown") && !e.target.closest(".sidebar-user"))
      document.getElementById("userMenuDropdown").classList.add("hidden");
    if (!e.target.closest("#notificationsPanel") && !e.target.closest("#notifBtn"))
      document.getElementById("notificationsPanel").classList.add("hidden");
    if (!e.target.closest(".search-box") && !e.target.closest("#searchResults"))
      document.getElementById("searchResults").classList.add("hidden");
  });
}
function isModalOpen() {
  return !document.querySelector(".modal-overlay:not(.hidden)") === false;
}
function closeAllModals() {
  document.querySelectorAll(".modal-overlay").forEach(m => m.classList.add("hidden"));
}
function hideDropdowns() {
  document.getElementById("userMenuDropdown").classList.add("hidden");
  document.getElementById("notificationsPanel").classList.add("hidden");
}

// ── Login panels ─────────────────────────────────────────────
function showGooglePanel() {
  document.getElementById("googleSignInPanel").classList.remove("hidden");
  document.getElementById("localPanel").classList.add("hidden");
  document.getElementById("loginLoadingPanel").classList.add("hidden");
  lucide.createIcons();
}

function showLocalPanel() {
  document.getElementById("googleSignInPanel").classList.add("hidden");
  document.getElementById("localPanel").classList.remove("hidden");
  document.getElementById("loginLoadingPanel").classList.add("hidden");
  if (S.users.length === 0) showCreateUser();
  else showUserSelection();
  lucide.createIcons();
}

function showLoginLoading(msg = "Signing in…") {
  document.getElementById("googleSignInPanel").classList.add("hidden");
  document.getElementById("localPanel").classList.add("hidden");
  document.getElementById("loginLoadingPanel").classList.remove("hidden");
  document.getElementById("loginLoadingMsg").textContent = msg;
}

// Called by google-integration.js after OAuth succeeds
async function onGoogleLoginSuccess(googleUser) {
  showLoginLoading("Loading your workspace…");

  try {
    // Create or find a user profile for this Google account
    let user = S.users.find(u => u.googleId === googleUser.sub || u.email === googleUser.email);
    if (!user) {
      user = {
        id: uid(),
        googleId: googleUser.sub,
        name: googleUser.name,
        email: googleUser.email,
        picture: googleUser.picture,
        color: AVATAR_COLORS[Math.abs(hashStr(googleUser.email)) % AVATAR_COLORS.length],
        role: "",
        createdAt: Date.now(),
      };
      S.users.push(user);
    } else {
      // Refresh Google info
      user.name    = googleUser.name;
      user.picture = googleUser.picture;
      user.email   = googleUser.email;
    }
    S.currentUserId = user.id;

    // Firestore is the source of truth for tasks + teams. fsBootstrap
    // upserts the user directory, loads teams, and starts the realtime
    // task listener (which repopulates S.tasks). Falls back to local-only.
    if (typeof fsBootstrap === "function") {
      showLoginLoading("Connecting to your workspace…");
      await fsBootstrap(googleUser);
    }

    saveToLocalStorage();
  } catch (e) {
    console.error("[Login] post-login step failed:", e);
  } finally {
    // Always enter the app — never get stuck on the loading screen
    enterApp();
  }
}

// Legacy local login
function loginWithGoogle() {
  if (typeof startGoogleLogin === "function") {
    startGoogleLogin();
  } else {
    showToast("Google Identity Services not ready yet, please wait…", "warning");
  }
}

function showUserSelection() {
  document.getElementById("userSelectionPanel").classList.remove("hidden");
  document.getElementById("createUserPanel").classList.add("hidden");
  const grid = document.getElementById("existingUsers");
  grid.innerHTML = S.users.map(u => `
    <div class="user-card" onclick="loginAs('${u.id}')">
      ${u.picture
        ? `<img src="${u.picture}" class="avatar avatar-lg" style="object-fit:cover" />`
        : `<div class="avatar avatar-lg" style="background:${u.color}">${initials(u.name)}</div>`
      }
      <div class="user-card-name">${esc(u.name)}</div>
      <div class="user-card-role">${esc(u.role || u.email || "Local")}</div>
    </div>
  `).join("");
  lucide.createIcons();
}

function showCreateUser() {
  document.getElementById("userSelectionPanel").classList.add("hidden");
  document.getElementById("createUserPanel").classList.remove("hidden");
}

function buildColorPicker() {
  const cp = document.getElementById("colorPicker");
  cp.innerHTML = AVATAR_COLORS.map((c,i) =>
    `<div class="color-swatch${i===0?" selected":""}" style="background:${c}" data-color="${c}" onclick="selectColor(this)"></div>`
  ).join("");
}

function selectColor(el) {
  document.querySelectorAll(".color-swatch").forEach(s => s.classList.remove("selected"));
  el.classList.add("selected");
}

function createUserProfile() {
  const name = document.getElementById("newUserName").value.trim();
  if (!name) { showToast("Please enter a name", "warning"); return; }
  const color = document.querySelector(".color-swatch.selected")?.dataset.color || AVATAR_COLORS[0];
  const role = document.getElementById("newUserRole").value.trim();
  const user = { id: uid(), name, color, role, createdAt: Date.now() };
  S.users.push(user);
  saveToStorage();
  loginAs(user.id);
}

function loginAs(userId) {
  const user = S.users.find(u => u.id === userId);
  if (!user) return;
  S.currentUserId = userId;
  enterApp();
}

function enterApp() {
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("appContainer").classList.remove("hidden");
  initApp();
}

function signOutAndReturnToLogin(silent = false) {
  if (!silent && !confirm("Sign out of TaskFlow?")) return;
  if (typeof signOutGoogle === "function") signOutGoogle(true);
  S.currentUserId = null;
  document.getElementById("loginScreen").classList.remove("hidden");
  document.getElementById("appContainer").classList.add("hidden");
  showGooglePanel();
  lucide.createIcons();
}

function getCurrentUser() { return S.users.find(u => u.id === S.currentUserId); }

// ── App Init ──────────────────────────────────────────────────
function initApp() {
  updateSidebarUser();
  populateUserFilters();
  showView("dashboard");
  checkDueTasks();
  updateBadges();
  updateDriveSyncStatus("synced");
  lucide.createIcons();
}

function updateSidebarUser() {
  const u = getCurrentUser();
  if (!u) return;
  const av = document.getElementById("sidebarAvatar");
  if (u.picture) {
    av.style.background = "transparent";
    av.innerHTML = `<img src="${u.picture}" style="width:100%;height:100%;border-radius:50%;object-fit:cover" />`;
  } else {
    av.style.background = u.color;
    av.innerHTML = "";
    av.textContent = initials(u.name);
  }
  document.getElementById("sidebarUserName").textContent = (u.name || "").trim().split(/\s+/)[0] || u.name;
  document.getElementById("sidebarUserRole").textContent = u.role || u.email || "Member";
  const commentAv = document.getElementById("commentAvatar");
  if (commentAv) { commentAv.style.background = u.color; commentAv.textContent = initials(u.name); }
}

function updateDriveSyncStatus(state) {
  const icon  = document.getElementById("driveSyncIcon");
  const label = document.getElementById("driveSyncLabel");
  if (!icon || !label) return;
  const map = {
    synced:  { icon: "cloud",       color: "var(--success)", text: "Synced to Drive" },
    syncing: { icon: "loader",      color: "var(--info)",    text: "Saving to Drive…" },
    error:   { icon: "cloud-off",   color: "var(--danger)",  text: "Drive unavailable" },
    offline: { icon: "cloud-off",   color: "var(--text-3)",  text: "Local only" },
  };
  const s = map[state] || map.offline;
  icon.setAttribute("data-lucide", s.icon);
  icon.style.color  = s.color;
  label.textContent = s.text;
  label.style.color = s.color;
  lucide.createIcons({ nodes: [document.getElementById("driveSyncStatus")] });
}

function populateUserFilters() {
  const opts = ['<option value="">All Members</option>', ...S.users.map(u =>
    `<option value="${u.id}">${esc(u.name)}</option>`)].join("");
  ["kanbanUserFilter","listUserFilter"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = opts;
  });
  const assigneeSelect = document.getElementById("taskAssignee");
  if (assigneeSelect) {
    assigneeSelect.innerHTML = '<option value="">Unassigned</option>' +
      S.users.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join("");
  }
}

function showUserMenu() {
  const dd = document.getElementById("userMenuDropdown");
  dd.classList.toggle("hidden");
  const list = document.getElementById("userMenuList");
  list.innerHTML = S.users.map(u => `
    <button class="dropdown-item" onclick="switchUser('${u.id}')">
      <div class="avatar avatar-sm" style="background:${u.color}">${initials(u.name)}</div>
      <span>${esc(u.name)}</span>
      ${u.id === S.currentUserId ? '<span style="color:var(--accent-light);font-size:10px">●</span>' : ""}
    </button>
  `).join("");
  lucide.createIcons();
}

function switchUser(userId) {
  S.currentUserId = userId;
  document.getElementById("userMenuDropdown").classList.add("hidden");
  updateSidebarUser();
  refreshCurrentView();
  showToast(`Switched to ${getCurrentUser().name}`, "info");
}

function showAddUser() {
  document.getElementById("userMenuDropdown").classList.add("hidden");
  document.getElementById("loginScreen").classList.remove("hidden");
  document.getElementById("appContainer").classList.add("hidden");
  showCreateUser();
}

function showManageTeam() {
  document.getElementById("userMenuDropdown").classList.add("hidden");
  showView("team");
}

// ── Views ─────────────────────────────────────────────────────
const VIEW_TITLES = {
  dashboard: "Dashboard", kanban: "Board", list: "Tasks",
  calendar: "Calendar", gmail: "Gmail", drive: "Google Drive",
  gcalendar: "Google Calendar", chat: "Google Chat",
  team: "Team", activity: "Activity Log",
};

function showView(view) {
  S.currentView = view;
  // Hide ALL views (re-add hidden, remove active)
  document.querySelectorAll(".view").forEach(v => {
    v.classList.remove("active");
    v.classList.add("hidden");
    v.style.display = "";
  });
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));

  // Show only the target view
  const viewEl = document.getElementById(view + "View");
  if (viewEl) { viewEl.classList.add("active"); viewEl.classList.remove("hidden"); viewEl.style.display = ""; }
  const navEl = document.querySelector(`[data-view="${view}"]`);
  if (navEl) navEl.classList.add("active");
  document.getElementById("viewTitle").textContent = VIEW_TITLES[view] || view;

  // Render view
  const renders = {
    dashboard: renderDashboard,
    kanban: renderKanban,
    list: renderList,
    calendar: renderCalendar,
    team: renderTeam,
    activity: renderActivity,
    gmail: initGmailView,
    drive: initDriveView,
    gcalendar: initGCalView,
    chat: initChatView,
  };
  if (renders[view]) renders[view]();
  lucide.createIcons();
}

function refreshCurrentView() { showView(S.currentView); }

// ── Task Helpers ──────────────────────────────────────────────
function getFilteredTasks(overrides = {}) {
  let tasks = [...S.tasks];
  const status = overrides.status || "";
  const priority = overrides.priority || "";
  const userId = overrides.userId || "";
  const label = overrides.label || "";

  if (status) tasks = tasks.filter(t => t.status === status);
  if (priority) tasks = tasks.filter(t => t.priority === priority);
  if (userId) tasks = tasks.filter(t => t.assignee === userId);
  if (label) tasks = tasks.filter(t => (t.labels||[]).includes(label));
  // Global due-date filter
  if (activeDueFilter) tasks = tasks.filter(t => isInDueRange(t.dueDate, activeDueFilter));
  return tasks;
}

// ── Due-date filter (global) ──────────────────────────────
let activeDueFilter = "";

function toggleDueFilter() {
  document.getElementById("dueFilterMenu").classList.toggle("hidden");
}

function setDueFilter(range) {
  activeDueFilter = range;
  document.getElementById("dueFilterMenu").classList.add("hidden");
  // Update button active state
  const btn = document.getElementById("dueFilterBtn");
  btn.classList.toggle("active", !!range);
  // Update menu item active states
  document.querySelectorAll(".due-filter-item").forEach(el => {
    el.classList.toggle("active", el.dataset.due === range);
  });
  // Re-render current view
  const vis = document.querySelector(".view:not(.hidden)");
  if (vis?.id === "kanbanView") renderKanban();
  else if (vis?.id === "listView") renderList();
  else if (vis?.id === "dashboardView") renderDashboard();
}

function isInDueRange(dueDateStr, range) {
  if (!range || !dueDateStr) return !range; // no filter → show all; no date + filter → hide
  const d = new Date(dueDateStr);
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "week") {
    const day = startOfDay.getDay() || 7; // Mon=1
    const weekStart = new Date(startOfDay); weekStart.setDate(weekStart.getDate() - day + 1);
    const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 7);
    return d >= weekStart && d < weekEnd;
  }
  if (range === "month") {
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }
  if (range === "quarter") {
    const q = Math.floor(now.getMonth() / 3);
    const qStart = new Date(now.getFullYear(), q * 3, 1);
    const qEnd = new Date(now.getFullYear(), q * 3 + 3, 1);
    return d >= qStart && d < qEnd;
  }
  if (range === "year") {
    return d.getFullYear() === now.getFullYear();
  }
  return true;
}

// Close due filter on outside click
document.addEventListener("click", e => {
  if (!e.target.closest(".due-filter-wrapper"))
    document.getElementById("dueFilterMenu")?.classList.add("hidden");
});

function getTasksByStatus(status) { return S.tasks.filter(t => t.status === status); }

function getUserById(id) { return S.users.find(u => u.id === id); }

function getUser(id) { return S.users.find(u => u.id === id); }

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  const now = new Date(); now.setHours(0,0,0,0);
  const diff = Math.round((d - now) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff < 0) return `${Math.abs(diff)}d overdue`;
  if (diff < 7) return `in ${diff}d`;
  return d.toLocaleDateString("en-US", { month:"short", day:"numeric" });
}

function isOverdue(dateStr) {
  if (!dateStr) return false;
  return new Date(dateStr + "T23:59:59") < new Date();
}
function isToday(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth() && d.getDate()===now.getDate();
}

function priorityDot(priority) {
  const colors = { urgent:"#ef4444", high:"#f97316", medium:"#f59e0b", low:"#22c55e" };
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${colors[priority]||"#999"}"></span>`;
}

// ── DASHBOARD ─────────────────────────────────────────────────
function renderDashboard() {
  const total = S.tasks.length;
  const done = S.tasks.filter(t => t.status === "done").length;
  const inprog = S.tasks.filter(t => t.status === "inprogress").length;
  const overdue = S.tasks.filter(t => t.status !== "done" && isOverdue(t.dueDate)).length;

  const stats = [
    { icon:"list-checks", label:"Total Tasks",  value:total,   bg:"rgba(108,99,255,0.15)", color:"#6c63ff" },
    { icon:"circle-check",label:"Completed",    value:done,    bg:"rgba(34,197,94,0.15)",  color:"#22c55e" },
    { icon:"loader",      label:"In Progress",  value:inprog,  bg:"rgba(59,130,246,0.15)", color:"#3b82f6" },
    { icon:"alert-circle",label:"Overdue",      value:overdue, bg:"rgba(239,68,68,0.15)",  color:"#ef4444" },
  ];
  document.getElementById("statsGrid").innerHTML = stats.map(s => `
    <div class="stat-card">
      <div class="stat-icon" style="background:${s.bg}">
        <i data-lucide="${s.icon}" style="color:${s.color}"></i>
      </div>
      <div class="stat-info">
        <div class="stat-value">${s.value}</div>
        <div class="stat-label">${s.label}</div>
      </div>
    </div>
  `).join("");

  // Due soon
  const soon = S.tasks
    .filter(t => t.status !== "done" && t.dueDate)
    .sort((a,b) => new Date(a.dueDate) - new Date(b.dueDate))
    .slice(0,6);
  document.getElementById("dueSoonList").innerHTML = soon.length ? soon.map(t => `
    <div class="due-soon-item" onclick="openTaskModal('${t.id}')">
      ${priorityDot(t.priority)}
      <span class="due-soon-title">${esc(t.title)}</span>
      <span class="due-soon-date ${isOverdue(t.dueDate)?"overdue":""}">${formatDate(t.dueDate)}</span>
    </div>
  `).join("") : `<p style="color:var(--text-3);font-size:12px;text-align:center;padding:20px">No upcoming tasks</p>`;

  // Progress chart
  const progressItems = STATUSES.map(s => {
    const count = S.tasks.filter(t => t.status === s).length;
    const pct = total ? Math.round((count/total)*100) : 0;
    return { label: STATUS_LABELS[s], count, pct, color: STATUS_COLORS[s] };
  });
  document.getElementById("progressChart").innerHTML = progressItems.map(p => `
    <div class="progress-bar-container">
      <div class="progress-bar-label">
        <span style="color:${p.color}">${p.label}</span>
        <span style="color:var(--text-3)">${p.count} (${p.pct}%)</span>
      </div>
      <div class="progress-bar">
        <div class="progress-bar-fill" style="width:${p.pct}%;background:${p.color}"></div>
      </div>
    </div>
  `).join("");

  // Team activity
  const teamStats = S.users.map(u => ({
    user: u,
    assigned: S.tasks.filter(t => t.assignee === u.id).length,
    done: S.tasks.filter(t => t.assignee === u.id && t.status === "done").length,
  }));
  document.getElementById("teamActivityList").innerHTML = teamStats.length ? teamStats.map(t => `
    <div class="due-soon-item">
      <div class="avatar avatar-sm" style="background:${t.user.color}">${initials(t.user.name)}</div>
      <span class="due-soon-title">${esc(t.user.name)}</span>
      <span style="color:var(--text-3);font-size:11px">${t.done}/${t.assigned} done</span>
    </div>
  `).join("") : `<p style="color:var(--text-3);font-size:12px;text-align:center;padding:20px">No team members</p>`;

  // Label chart
  const allLabels = {};
  S.tasks.forEach(t => (t.labels||[]).forEach(l => { allLabels[l] = (allLabels[l]||0)+1; }));
  const labelEntries = Object.entries(allLabels).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const maxLabel = labelEntries[0]?.[1] || 1;
  document.getElementById("labelChart").innerHTML = labelEntries.length ? labelEntries.map(([l,c]) => `
    <div class="label-bar">
      <span class="label-name">${esc(l)}</span>
      <div class="label-fill" style="width:${Math.round((c/maxLabel)*120)}px"></div>
      <span class="label-count">${c}</span>
    </div>
  `).join("") : `<p style="color:var(--text-3);font-size:12px;text-align:center;padding:20px">No labels yet</p>`;

  lucide.createIcons();
}

// ── KANBAN BOARD ──────────────────────────────────────────────
function renderKanban() {
  const userFilter = document.getElementById("kanbanUserFilter")?.value || "";
  const priorityFilter = document.getElementById("kanbanPriorityFilter")?.value || "";
  const labelFilter = document.getElementById("kanbanLabelFilter")?.value || "";
  let tasks = getFilteredTasks({ userId: userFilter, priority: priorityFilter, label: labelFilter });

  // Apply board tab filter
  if (activeBoardTab === "mine") {
    tasks = tasks.filter(t => t.assignee === S.currentUserId);
  } else if (activeBoardTab === "team") {
    // Show tasks from direct reports (and their reports) based on hierarchy
    const myTeam = getTeamMembers(S.currentUserId);
    if (myTeam.length) {
      const teamIds = myTeam.map(u => u.id);
      tasks = tasks.filter(t => teamIds.includes(t.assignee));
    } else {
      // No hierarchy set — fallback to all other users' tasks
      const allOtherIds = S.users.filter(u => u.id !== S.currentUserId).map(u => u.id);
      tasks = tasks.filter(t => allOtherIds.includes(t.assignee));
    }
  }

  const board = document.getElementById("kanbanBoard");
  board.innerHTML = STATUSES.map(status => {
    const colTasks = tasks.filter(t => t.status === status)
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    return `
      <div class="kanban-column" data-status="${status}"
           ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)"
           ondrop="handleDrop(event,'${status}')">
        <div class="col-header">
          <div class="col-dot" style="background:${STATUS_COLORS[status]}"></div>
          <span class="col-title">${STATUS_LABELS[status]}</span>
          <span class="col-count">${colTasks.length}</span>
        </div>
        <div class="task-cards" id="col-${status}">
          ${colTasks.map(t => renderTaskCard(t)).join("")}
        </div>
        <button class="col-add-btn" onclick="openTaskModalForStatus('${status}')">
          <i data-lucide="plus"></i> Add task
        </button>
      </div>
    `;
  }).join("");

  // Populate label filter
  const allLabels = [...new Set(S.tasks.flatMap(t => t.labels||[]))];
  const lf = document.getElementById("kanbanLabelFilter");
  if (lf) {
    const current = lf.value;
    lf.innerHTML = '<option value="">All Labels</option>' +
      allLabels.map(l => `<option value="${l}" ${l===current?"selected":""}>${esc(l)}</option>`).join("");
  }

  // Update tab counts
  updateBoardTabCounts();

  lucide.createIcons();
}

// ── Board tab filters ────────────────────────────────────────
let activeBoardTab = "all";

function setBoardTab(tab) {
  activeBoardTab = tab;
  document.querySelectorAll(".tab-filter").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  renderKanban();
}

function updateBoardTabCounts() {
  const all = S.tasks.length;
  const mine = S.tasks.filter(t => t.assignee === S.currentUserId).length;
  const myTeam = getTeamMembers(S.currentUserId);
  let team;
  if (myTeam.length) {
    const teamIds = myTeam.map(u => u.id);
    team = S.tasks.filter(t => teamIds.includes(t.assignee)).length;
  } else {
    const allOtherIds = S.users.filter(u => u.id !== S.currentUserId).map(u => u.id);
    team = S.tasks.filter(t => allOtherIds.includes(t.assignee)).length;
  }
  const el = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  el("tabCountAll", all);
  el("tabCountMine", mine);
  el("tabCountTeam", team);
}


function renderTaskCard(task) {
  const assignee = task.assignee ? getUserById(task.assignee) : null;
  const subtasks = task.subtasks || [];
  const doneSubtasks = subtasks.filter(s => s.done).length;
  const subtaskPct = subtasks.length ? Math.round((doneSubtasks / subtasks.length) * 100) : 0;
  const overdue = task.status !== "done" && isOverdue(task.dueDate);
  const today = isToday(task.dueDate);
  const comments = task.comments || [];
  const attachments = task.attachments || [];
  const description = task.description || "";

  const priorityLabels = { urgent: "URGENT", high: "HIGH", medium: "MEDIUM", low: "LOW" };
  const priorityIcons = { urgent: "⚑", high: "⚑", medium: "⚑", low: "⚑" };
  const priorityLabel = priorityLabels[task.priority] || "MEDIUM";

  const labelHtml = (task.labels||[]).slice(0,3).map(l => {
    const c = getLabelColor(l);
    return `<span class="label-chip"><span class="label-dot" style="background:${c}"></span>${esc(l)}</span>`;
  }).join("");

  const dueDateClass = overdue ? "overdue" : today ? "today" : "";

  const subtaskItemsHtml = subtasks.map((s, i) =>
    `<div class="subtask-item">
      <input type="checkbox" ${s.done?"checked":""} onclick="toggleCardSubtask(event,'${task.id}',${i})" />
      <span class="${s.done?"subtask-done":""}">${esc(s.title)}</span>
    </div>`
  ).join("");

  return `
    <div class="task-card priority-rail-${task.priority}" data-task-id="${task.id}"
         draggable="true"
         ondragstart="handleDragStart(event,'${task.id}')"
         ondragend="handleDragEnd(event)"
         onclick="openTaskModal('${task.id}')">
      <div class="task-card-priority priority-indicator-${task.priority}">
        ${priorityIcons[task.priority]||""} ${priorityLabel}
      </div>
      <div class="task-card-title ${task.status==="done"?"done":""}">${esc(task.title)}</div>
      ${description ? `<div class="task-card-desc">${esc(description.substring(0, 100))}${description.length > 100 ? '...' : ''}</div>` : ""}
      ${labelHtml ? `<div class="card-labels">${labelHtml}</div>` : ""}
      ${subtasks.length ? `
        <div class="subtask-progress">
          <div class="subtask-expand-btn" onclick="toggleSubtaskExpand(event,'${task.id}')">
            <div class="subtask-progress-header" style="flex:1;display:flex;align-items:center;justify-content:space-between">
              <span class="subtask-progress-label"><i data-lucide="git-branch" style="width:11px;height:11px"></i> Subtasks</span>
              <span style="display:flex;align-items:center;gap:6px">
                <span class="subtask-progress-count">${doneSubtasks}/${subtasks.length}</span>
                <span class="chevron" id="chevron-${task.id}">▾</span>
              </span>
            </div>
          </div>
          <div class="subtask-progress-bar">
            <div class="subtask-progress-fill ${subtaskPct === 100 ? 'complete' : ''}" style="width:${subtaskPct}%"></div>
          </div>
          <div class="subtask-list" id="subtask-list-${task.id}">
            ${subtaskItemsHtml}
          </div>
        </div>
      ` : ""}
      <div class="task-card-footer">
        <div class="task-card-footer-left">
          ${task.dueDate ? `<span class="task-card-due ${dueDateClass}"><i data-lucide="calendar" style="width:11px;height:11px"></i> ${formatDate(task.dueDate)}</span>` : ""}
          ${comments.length ? `<span class="task-card-stat"><i data-lucide="message-circle" style="width:11px;height:11px"></i> ${comments.length}</span>` : ""}
          ${attachments.length ? `<span class="task-card-stat"><i data-lucide="paperclip" style="width:11px;height:11px"></i> ${attachments.length}</span>` : ""}
        </div>
        <div class="task-card-footer-right">
          <div class="avatar-stack">
            ${assignee ? `<div class="avatar avatar-sm" style="background:${assignee.color}" title="${esc(assignee.name)}">${initials(assignee.name)}</div>` : ""}
          </div>
        </div>
      </div>
    </div>
  `;
}

function toggleSubtaskExpand(event, taskId) {
  event.stopPropagation();
  const list = document.getElementById("subtask-list-" + taskId);
  const chevron = document.getElementById("chevron-" + taskId);
  if (list) {
    list.classList.toggle("expanded");
    if (chevron) chevron.classList.toggle("expanded");
  }
}

function toggleCardSubtask(event, taskId, index) {
  event.stopPropagation();
  const task = S.tasks.find(t => t.id === taskId);
  if (!task || !task.subtasks || !task.subtasks[index]) return;
  task.subtasks[index].done = !task.subtasks[index].done;
  task.updatedAt = Date.now();
  if (typeof fsSyncTask === "function") fsSyncTask(task);
  saveToStorage();
  // Re-render just this card in place
  const cardEl = document.querySelector(`.task-card[data-task-id="${taskId}"]`);
  if (cardEl) {
    const wasExpanded = cardEl.querySelector(".subtask-list.expanded") !== null;
    const temp = document.createElement("div");
    temp.innerHTML = renderTaskCard(task);
    const newCard = temp.firstElementChild;
    cardEl.replaceWith(newCard);
    if (wasExpanded) {
      const newList = newCard.querySelector(".subtask-list");
      const newChevron = newCard.querySelector(".chevron");
      if (newList) newList.classList.add("expanded");
      if (newChevron) newChevron.classList.add("expanded");
    }
    lucide.createIcons();
  }
}

// ── DRAG & DROP ───────────────────────────────────────────────
let draggedTaskId = null;

function handleDragStart(event, taskId) {
  draggedTaskId = taskId;
  event.currentTarget.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
}
function handleDragEnd(event) {
  event.currentTarget.classList.remove("dragging");
  document.querySelectorAll(".kanban-column").forEach(c => c.classList.remove("drag-over"));
}
function handleDragOver(event) {
  event.preventDefault();
  event.currentTarget.classList.add("drag-over");
  event.dataTransfer.dropEffect = "move";
}
function handleDragLeave(event) {
  event.currentTarget.classList.remove("drag-over");
}
function handleDrop(event, newStatus) {
  event.preventDefault();
  event.currentTarget.classList.remove("drag-over");
  if (!draggedTaskId) return;
  const task = S.tasks.find(t => t.id === draggedTaskId);
  if (task && task.status !== newStatus) {
    const old = task.status;
    task.status = newStatus;
    task.updatedAt = Date.now();
    logActivity("move", task.title, `from ${STATUS_LABELS[old]} to ${STATUS_LABELS[newStatus]}`);
    if (typeof fsSyncTask === "function") fsSyncTask(task);
    saveToStorage();
    renderKanban();
    updateBadges();
  }
  draggedTaskId = null;
}

// ── TASK LIST ─────────────────────────────────────────────────
function renderList() {
  const statusF = document.getElementById("listStatusFilter")?.value || "";
  const priorityF = document.getElementById("listPriorityFilter")?.value || "";
  const userF = document.getElementById("listUserFilter")?.value || "";
  const sortBy = document.getElementById("listSortBy")?.value || "created";

  let tasks = getFilteredTasks({ status: statusF, priority: priorityF, userId: userF });
  tasks.sort((a,b) => {
    if (sortBy === "due") return (a.dueDate||"z") > (b.dueDate||"z") ? 1 : -1;
    if (sortBy === "priority") return (PRIORITY_ORDER[b.priority]||0) - (PRIORITY_ORDER[a.priority]||0);
    if (sortBy === "title") return a.title.localeCompare(b.title);
    return b.createdAt - a.createdAt;
  });

  const body = document.getElementById("taskListBody");
  if (!tasks.length) {
    body.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-3)">No tasks found</div>`;
    return;
  }
  body.innerHTML = tasks.map(task => {
    const assignee = task.assignee ? getUserById(task.assignee) : null;
    const overdue = task.status !== "done" && isOverdue(task.dueDate);
    return `
      <div class="list-row" onclick="openTaskModal('${task.id}')">
        <div class="list-row-title ${task.status==="done"?"done":""}">
          ${priorityDot(task.priority)}
          <span>${esc(task.title)}</span>
        </div>
        <div>
          ${assignee ? `<div style="display:flex;align-items:center;gap:4px">
            <div class="avatar avatar-sm" style="background:${assignee.color}">${initials(assignee.name)}</div>
            <span style="font-size:11px">${esc(assignee.name.split(" ")[0])}</span>
          </div>` : '<span style="color:var(--text-3)">—</span>'}
        </div>
        <div><span class="priority-badge priority-${task.priority}">${task.priority}</span></div>
        <div style="font-size:11px;color:${overdue?"var(--danger)":"var(--text-2)"}">${formatDate(task.dueDate)||"—"}</div>
        <div><span class="status-badge status-${task.status}">${STATUS_LABELS[task.status]}</span></div>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          ${(task.labels||[]).slice(0,2).map(l=>`<span class="label-badge">${esc(l)}</span>`).join("")}
        </div>
        <div class="list-actions" onclick="event.stopPropagation()">
          <button class="icon-btn" title="Edit" onclick="openTaskModal('${task.id}')"><i data-lucide="edit-2"></i></button>
          <button class="icon-btn" title="Delete" onclick="confirmDeleteTask('${task.id}')"><i data-lucide="trash-2"></i></button>
        </div>
      </div>
    `;
  }).join("");
  lucide.createIcons();
}

// ── MINI CALENDAR ─────────────────────────────────────────────
function renderCalendar() {
  const date = S.calMonth;
  const year = date.getFullYear();
  const month = date.getMonth();
  document.getElementById("calMonthTitle").textContent =
    date.toLocaleDateString("en-US", { month:"long", year:"numeric" });

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const today = new Date(); today.setHours(0,0,0,0);
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const gcalEvents = (typeof G !== "undefined" && G.gcalEvents) ? G.gcalEvents : [];

  let html = days.map(d=>`<div class="cal-day-header">${d}</div>`).join("");
  const prevDays = new Date(year,month,0).getDate();
  for (let i=firstDay-1; i>=0; i--) {
    html += `<div class="cal-day other-month"><div class="cal-day-num">${prevDays-i}</div></div>`;
  }
  for (let day=1; day<=daysInMonth; day++) {
    const dateStr = `${year}-${String(month+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
    const dayTasks  = S.tasks.filter(t => t.dueDate === dateStr);
    const dayEvents = gcalEvents.filter(e => (e.start?.date || e.start?.dateTime || "").slice(0,10) === dateStr);
    const isT   = new Date(year,month,day).getTime() === today.getTime();
    const isSel = S.selectedCalDate === dateStr;
    const total = dayTasks.length + dayEvents.length;
    const showMax = 3;
    let items = "";
    let shown = 0;
    for (const t of dayTasks) {
      if (shown >= showMax) break;
      items += `<div class="cal-task-dot ${t.priority} ${t.status==="done"?"done":""}">${esc(t.title)}</div>`;
      shown++;
    }
    for (const e of dayEvents) {
      if (shown >= showMax) break;
      const isAllDay = !!e.start?.date;
      const timeStr = e.start?.dateTime
        ? new Date(e.start.dateTime).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true}).replace(":00","").toLowerCase()
        : "";
      items += `<div class="cal-event-dot${isAllDay?" allday":""}" title="${esc(e.summary||"")}">${timeStr ? timeStr+" " : ""}${esc(e.summary||"(No title)")}</div>`;
      shown++;
    }
    if (total > showMax) items += `<div class="cal-more">+${total-showMax} more</div>`;
    html += `
      <div class="cal-day${isT?" today":""}${isSel?" selected":""}" onclick="selectCalDate('${dateStr}')">
        <div class="cal-day-num">${day}</div>${items}
      </div>
    `;
  }
  const totalCells = Math.ceil((firstDay+daysInMonth)/7)*7;
  for (let i=1; i<=totalCells-firstDay-daysInMonth; i++) {
    html += `<div class="cal-day other-month"><div class="cal-day-num">${i}</div></div>`;
  }

  document.getElementById("calGrid").innerHTML = html;

  if (S.selectedCalDate) {
    document.getElementById("calSidebar").classList.remove("hidden");
    renderCalDaySidebar(S.selectedCalDate);
  }

  // Fetch Google Calendar events for this month if signed in
  if (typeof G !== "undefined" && G.isSignedIn) fetchCalEventsForMonth(year, month);

  // Update Google Calendar connect button state
  if (typeof updateGCalConnectButton === "function") updateGCalConnectButton();
}

function selectCalDate(dateStr) {
  if (S.selectedCalDate === dateStr) { closeCalSidebar(); return; }
  S.selectedCalDate = dateStr;
  renderCalendar();
  renderCalDaySidebar(dateStr);
  document.getElementById("calSidebar").classList.remove("hidden");
}

function closeCalSidebar() {
  S.selectedCalDate = null;
  document.getElementById("calSidebar").classList.add("hidden");
  renderCalendar();
}

function renderCalDaySidebar(dateStr) {
  const d = new Date(dateStr+"T00:00:00");
  document.getElementById("calSelectedDate").textContent =
    d.toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric" });
  const tasks  = S.tasks.filter(t => t.dueDate === dateStr);
  const events = (typeof G !== "undefined" && G.gcalEvents)
    ? G.gcalEvents.filter(e => (e.start?.date || e.start?.dateTime || "").slice(0,10) === dateStr)
    : [];

  let html = "";
  if (events.length) {
    html += `<div style="font-size:10px;font-weight:700;color:var(--text-3);margin-bottom:4px;text-transform:uppercase">Meetings</div>`;
    html += events.map(e => {
      const timeStr = e.start?.dateTime
        ? new Date(e.start.dateTime).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true}).replace(":00","")
          + (e.end?.dateTime ? " – " + new Date(e.end.dateTime).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true}).replace(":00","") : "")
        : "All day";
      return `<div class="due-soon-item" style="cursor:default">
        <span style="width:8px;height:8px;border-radius:50%;background:#3b82f6;flex-shrink:0;display:inline-block"></span>
        <span class="due-soon-title">${esc(e.summary||"(No title)")}</span>
        <span style="font-size:10px;color:var(--text-3);white-space:nowrap">${timeStr}</span>
      </div>`;
    }).join("");
  }
  if (tasks.length) {
    html += `<div style="font-size:10px;font-weight:700;color:var(--text-3);margin:${events.length?8:0}px 0 4px;text-transform:uppercase">Tasks</div>`;
    html += tasks.map(t=>`
      <div class="due-soon-item" onclick="openTaskModal('${t.id}')">
        ${priorityDot(t.priority)}
        <span class="due-soon-title">${esc(t.title)}</span>
        <span class="status-badge status-${t.status}" style="font-size:10px">${STATUS_LABELS[t.status]}</span>
      </div>`).join("");
  }
  if (!html) html = `<p style="color:var(--text-3);font-size:12px;margin-top:8px">Nothing scheduled</p>`;
  document.getElementById("calDayTasks").innerHTML = html;
  lucide.createIcons();
}

async function fetchCalEventsForMonth(year, month) {
  try {
    const timeMin = new Date(year, month, 1).toISOString();
    const timeMax = new Date(year, month + 1, 1).toISOString();
    const params  = new URLSearchParams({ timeMin, timeMax, singleEvents: true, orderBy: "startTime", maxResults: 100 });
    const data    = await gFetch(`${CALENDAR_BASE}/calendars/primary/events?${params}`);
    G.gcalEvents  = data.items || [];
    renderCalendar(); // re-render with events
  } catch(e) { /* not signed in or no permission — silently skip */ }
}

function changeCalMonth(dir) {
  S.calMonth = new Date(S.calMonth.getFullYear(), S.calMonth.getMonth()+dir, 1);
  renderCalendar();
}
function goToToday() {
  S.calMonth = new Date();
  S.selectedCalDate = new Date().toISOString().slice(0,10);
  renderCalendar();
}
function openTaskModalForDate() {
  if (!S.selectedCalDate) return;
  openTaskModal(null, { dueDate: S.selectedCalDate });
}
function openTaskModalForStatus(status) {
  openTaskModal(null, { status });
}

// ── DATE PICKER ───────────────────────────────────────────────
let _dpMonth = new Date();

function openDatePicker() {
  const trigger = document.getElementById("dueDateTrigger");
  const popup   = document.getElementById("datePickerPopup");
  const val     = document.getElementById("taskDueDate").value;
  _dpMonth      = val ? new Date(val + "T00:00:00") : new Date();
  _renderDp();
  popup.classList.remove("hidden");
  const rect = trigger.getBoundingClientRect();
  popup.style.top  = (rect.bottom + 6) + "px";
  popup.style.left = rect.left + "px";
  requestAnimationFrame(() => {
    const pr = popup.getBoundingClientRect();
    if (pr.right > window.innerWidth - 8)  popup.style.left = Math.max(8, rect.right - pr.width) + "px";
    if (pr.bottom > window.innerHeight - 8) popup.style.top = (rect.top - pr.height - 6) + "px";
  });
  setTimeout(() => document.addEventListener("click", _dpOutside, true), 0);
  lucide.createIcons({ nodes: [popup] });
}

function _dpOutside(e) {
  const popup = document.getElementById("datePickerPopup");
  if (!popup.contains(e.target) && !document.getElementById("dueDateTrigger").contains(e.target))
    _closeDp();
}
function _closeDp() {
  document.getElementById("datePickerPopup").classList.add("hidden");
  document.removeEventListener("click", _dpOutside, true);
}
function dpNav(dir) {
  _dpMonth = new Date(_dpMonth.getFullYear(), _dpMonth.getMonth() + dir, 1);
  _renderDp();
}
function _renderDp() {
  const year = _dpMonth.getFullYear(), month = _dpMonth.getMonth();
  document.getElementById("dpTitle").textContent =
    _dpMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today   = new Date(); today.setHours(0,0,0,0);
  const selVal  = document.getElementById("taskDueDate").value;
  const hdrs    = ["Su","Mo","Tu","We","Th","Fr","Sa"].map(d => `<div class="dp-hdr">${d}</div>`).join("");
  let cells     = "";
  for (let i = 0; i < firstDay; i++) cells += `<div class="dp-day dp-empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const isT = new Date(year,month,d).getTime() === today.getTime();
    const isS = ds === selVal;
    cells += `<div class="dp-day${isT?" dp-today":""}${isS?" dp-selected":""}" onclick="dpSelectDate('${ds}')">${d}</div>`;
  }
  document.getElementById("dpGrid").innerHTML = hdrs + cells;
}
function dpSelectDate(dateStr) {
  document.getElementById("taskDueDate").value = dateStr;
  setDueDateDisplay(dateStr);
  _closeDp();
}
function setDueDateDisplay(dateStr) {
  const disp  = document.getElementById("dueDateDisplay");
  const clear = document.getElementById("dueDateClear");
  if (dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    disp.textContent = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    clear.classList.remove("hidden");
  } else {
    disp.textContent = "Pick a date";
    clear.classList.add("hidden");
  }
}
function clearDueDate(e) {
  e.stopPropagation();
  document.getElementById("taskDueDate").value = "";
  setDueDateDisplay("");
}

// ── TASK MODAL ────────────────────────────────────────────────
function openTaskModal(taskId = null, defaults = {}) {
  S.editingTaskId = taskId;
  S.taskLabels = [];
  S.taskSubtasks = [];
  S.taskComments = [];
  S.taskAttachments = [];

  const modal = document.getElementById("taskModal");
  modal.classList.remove("hidden");

  document.getElementById("taskModalTitle").textContent = taskId ? "Edit Task" : "New Task";
  document.getElementById("deleteTaskBtn").classList.toggle("hidden", !taskId);

  // Populate assignee dropdown
  document.getElementById("taskAssignee").innerHTML =
    '<option value="">Unassigned</option>' +
    S.users.map(u=>`<option value="${u.id}">${esc(u.name)}</option>`).join("");

  if (taskId) {
    const t = S.tasks.find(x => x.id === taskId);
    if (!t) return;
    document.getElementById("editTaskId").value = t.id;
    document.getElementById("taskTitle").value = t.title;
    document.getElementById("taskDesc").value = t.description || "";
    document.getElementById("taskStatus").value = t.status;
    document.getElementById("taskPriority").value = t.priority;
    document.getElementById("taskAssignee").value = t.assignee || "";
    document.getElementById("taskDueDate").value = t.dueDate || "";
    setDueDateDisplay(t.dueDate || "");
    S.taskLabels = [...(t.labels||[])];
    S.taskSubtasks = (t.subtasks||[]).map(s=>({...s}));
    S.taskComments = (t.comments||[]).map(c=>({...c}));
    S.taskAttachments = (t.attachments||[]).map(a=>({...a}));
  } else {
    document.getElementById("editTaskId").value = "";
    document.getElementById("taskTitle").value = "";
    document.getElementById("taskDesc").value = "";
    document.getElementById("taskStatus").value = defaults.status || "todo";
    document.getElementById("taskPriority").value = defaults.priority || "medium";
    document.getElementById("taskAssignee").value = defaults.assignee || S.currentUserId || "";
    document.getElementById("taskDueDate").value = defaults.dueDate || "";
    setDueDateDisplay(defaults.dueDate || "");
  }

  renderModalLabels();
  renderModalSubtasks();
  renderModalComments();
  renderModalAttachments();
  updateSidebarUser();
  lucide.createIcons();
}

function renderModalLabels() {
  document.getElementById("taskLabelsList").innerHTML = S.taskLabels.map(l => {
    const c = getLabelColor(l);
    return `<span class="label-badge"><span class="label-dot" style="background:${c}"></span>${esc(l)}<span class="label-remove" onclick="removeTaskLabel('${esc(l)}')" title="Remove">×</span></span>`;
  }).join("");
}

function addTaskLabel() {
  const input = document.getElementById("newLabelInput");
  const val = input.value.trim();
  if (!val || S.taskLabels.includes(val)) { input.value=""; return; }
  S.taskLabels.push(val);
  input.value = "";
  renderModalLabels();
  closeLabelDropdown();
}

function removeTaskLabel(label) {
  S.taskLabels = S.taskLabels.filter(l => l !== label);
  renderModalLabels();
}

function getAllKnownLabels() {
  const fromTasks = S.tasks.flatMap(t => t.labels || []);
  return [...new Set([...SAMPLE_LABELS, ...fromTasks])];
}

function toggleLabelDropdown(event) {
  event.stopPropagation();
  const menu = document.getElementById("labelDropdownMenu");
  if (!menu) return;
  if (menu.classList.contains("hidden")) {
    renderLabelDropdown();
    menu.classList.remove("hidden");
    // Close on outside click
    setTimeout(() => document.addEventListener("click", closeLabelDropdownOutside), 0);
  } else {
    closeLabelDropdown();
  }
}

function closeLabelDropdownOutside(e) {
  const wrapper = document.querySelector(".label-dropdown-wrapper");
  if (wrapper && !wrapper.contains(e.target)) closeLabelDropdown();
}

function closeLabelDropdown() {
  const menu = document.getElementById("labelDropdownMenu");
  if (menu) menu.classList.add("hidden");
  document.removeEventListener("click", closeLabelDropdownOutside);
}

function filterLabelDropdown() {
  renderLabelDropdown();
  const menu = document.getElementById("labelDropdownMenu");
  if (menu) menu.classList.remove("hidden");
}

function renderLabelDropdown() {
  const menu = document.getElementById("labelDropdownMenu");
  if (!menu) return;
  const input = document.getElementById("newLabelInput");
  const filter = (input?.value || "").trim().toLowerCase();
  const allLabels = getAllKnownLabels().filter(l => !S.taskLabels.includes(l));
  const filtered = filter ? allLabels.filter(l => l.toLowerCase().includes(filter)) : allLabels;
  const exactMatch = allLabels.some(l => l.toLowerCase() === filter) || S.taskLabels.some(l => l.toLowerCase() === filter);

  let html = filtered.map(l => {
    const c = getLabelColor(l);
    return `<div class="label-dropdown-item" onclick="selectLabelFromDropdown('${esc(l)}')">
      <span class="label-dot" style="background:${c}"></span>${esc(l)}
    </div>`;
  }).join("");

  if (filter && !exactMatch) {
    html += `<div class="label-dropdown-item add-new" onclick="addTaskLabel()">
      <span style="font-size:14px">+</span> Add "${esc(filter)}"
    </div>`;
  }
  if (!html) html = `<div class="label-dropdown-item" style="color:var(--text-3);cursor:default">No labels found</div>`;
  menu.innerHTML = html;
}

function selectLabelFromDropdown(label) {
  if (!S.taskLabels.includes(label)) {
    S.taskLabels.push(label);
    renderModalLabels();
  }
  const input = document.getElementById("newLabelInput");
  if (input) input.value = "";
  closeLabelDropdown();
}

function renderModalSubtasks() {
  document.getElementById("subtaskList").innerHTML = S.taskSubtasks.map((s, i) => `
    <div class="subtask-item">
      <input type="checkbox" ${s.done?"checked":""} onchange="toggleSubtask(${i})" />
      <span class="${s.done?"checked":""}">${esc(s.title)}</span>
      <span class="subtask-remove" onclick="removeSubtask(${i})"><i data-lucide="x" style="width:12px;height:12px"></i></span>
    </div>
  `).join("");
  lucide.createIcons();
}

function addSubtask() {
  const input = document.getElementById("newSubtaskInput");
  const val = input.value.trim();
  if (!val) return;
  S.taskSubtasks.push({ id: uid(), title: val, done: false });
  input.value = "";
  renderModalSubtasks();
}

function toggleSubtask(i) {
  S.taskSubtasks[i].done = !S.taskSubtasks[i].done;
  renderModalSubtasks();
}
function removeSubtask(i) {
  S.taskSubtasks.splice(i,1);
  renderModalSubtasks();
}

function renderModalComments() {
  document.getElementById("commentsList").innerHTML = S.taskComments.map(c => {
    const u = getUserById(c.userId);
    return `
      <div class="comment-item">
        <div class="avatar avatar-sm" style="background:${u?.color||"#999"}">${initials(u?.name||"?")}</div>
        <div class="comment-body">
          <div class="comment-author">${esc(u?.name||"Unknown")}</div>
          <div class="comment-text">${esc(c.text)}</div>
          <div class="comment-time">${new Date(c.createdAt).toLocaleString()}</div>
        </div>
      </div>
    `;
  }).join("");
}

function addComment() {
  const input = document.getElementById("commentInput");
  const text = input.value.trim();
  if (!text) return;
  S.taskComments.push({ id: uid(), userId: S.currentUserId, text, createdAt: Date.now() });
  input.value = "";
  renderModalComments();
}

function renderModalAttachments() {
  document.getElementById("attachmentsList").innerHTML = S.taskAttachments.map((a,i) => `
    <div class="attachment-chip">
      <i data-lucide="paperclip" style="width:12px;height:12px"></i>
      <a href="${a.url||"#"}" target="_blank">${esc(a.name)}</a>
      <span class="remove-attach" onclick="removeAttachment(${i})">×</span>
    </div>
  `).join("");
  lucide.createIcons();
}

function removeAttachment(i) {
  S.taskAttachments.splice(i,1);
  renderModalAttachments();
}

function saveTask() {
  const title = document.getElementById("taskTitle").value.trim();
  if (!title) { showToast("Please enter a task title", "warning"); return; }

  const data = {
    title,
    description: document.getElementById("taskDesc").value.trim(),
    status: document.getElementById("taskStatus").value,
    priority: document.getElementById("taskPriority").value,
    assignee: document.getElementById("taskAssignee").value,
    dueDate: document.getElementById("taskDueDate").value,
    labels: [...S.taskLabels],
    subtasks: S.taskSubtasks.map(s=>({...s})),
    comments: S.taskComments.map(c=>({...c})),
    attachments: S.taskAttachments.map(a=>({...a})),
  };

  if (S.editingTaskId) {
    const idx = S.tasks.findIndex(t => t.id === S.editingTaskId);
    if (idx !== -1) {
      S.tasks[idx] = { ...S.tasks[idx], ...data, updatedAt: Date.now() };
      logActivity("update", title);
      showToast("Task updated!", "success");
      if (typeof fsSyncTask === "function") fsSyncTask(S.tasks[idx]);
    }
  } else {
    const task = { id: uid(), ...data, createdAt: Date.now(), updatedAt: Date.now(), createdBy: S.currentUserId };
    S.tasks.push(task);
    logActivity("create", title);
    showToast("Task created!", "success");
    addNotification(`New task: "${title}"`, "task");
    if (typeof fsSyncTask === "function") fsSyncTask(task);
  }

  saveToStorage();
  closeModal("taskModal");
  refreshCurrentView();
  updateBadges();
}

function deleteCurrentTask() {
  if (!S.editingTaskId) return;
  confirmDeleteTask(S.editingTaskId, () => closeModal("taskModal"));
}

function confirmDeleteTask(taskId, cb) {
  const task = S.tasks.find(t => t.id === taskId);
  if (!task) return;
  if (!confirm(`Delete task "${task.title}"?`)) return;
  S.tasks = S.tasks.filter(t => t.id !== taskId);
  logActivity("delete", task.title);
  showToast("Task deleted", "info");
  if (typeof fsDeleteTask === "function") fsDeleteTask(taskId);
  saveToStorage();
  refreshCurrentView();
  updateBadges();
  if (cb) cb();
}

function closeModal(id) { document.getElementById(id).classList.add("hidden"); }
function closeModalOnBackdrop(event, id) {
  if (event.target === event.currentTarget) closeModal(id);
}

// ── TEAM VIEW ─────────────────────────────────────────────────
// Team hierarchy state
let teamEditMode = false;

function toggleTeamEditMode() {
  teamEditMode = !teamEditMode;
  const btn = document.getElementById("teamEditModeBtn");
  if (btn) {
    btn.innerHTML = teamEditMode
      ? '<i data-lucide="check"></i> Done'
      : '<i data-lucide="settings-2"></i> Edit Hierarchy';
    btn.classList.toggle("btn-primary", teamEditMode);
    btn.classList.toggle("btn-outline", !teamEditMode);
  }
  renderTeam();
  lucide.createIcons();
}

function renderTeam() {
  const container = document.getElementById("teamHierarchy");
  if (!container) return;

  // Build hierarchy tree
  const roots = S.users.filter(u => !u.managerId || !S.users.find(m => m.id === u.managerId));
  const getReports = (managerId) => S.users.filter(u => u.managerId === managerId);

  function renderMemberNode(user, depth = 0) {
    const reports = getReports(user.id);
    const assigned = S.tasks.filter(t => t.assignee === user.id).length;
    const active = S.tasks.filter(t => t.assignee === user.id && t.status === "inprogress").length;
    const done = S.tasks.filter(t => t.assignee === user.id && t.status === "done").length;
    const isCurrent = user.id === S.currentUserId;
    const dept = user.department || "";

    // In edit mode, show dropdowns for manager and department
    const editControls = teamEditMode ? `
      <div class="team-edit-controls">
        <div class="form-group-inline">
          <label>Manager</label>
          <select class="filter-select compact" onchange="setManager('${user.id}', this.value)">
            <option value="">None (Top level)</option>
            ${S.users.filter(u => u.id !== user.id).map(u =>
              `<option value="${u.id}" ${user.managerId === u.id ? 'selected' : ''}>${esc(u.name)}</option>`
            ).join("")}
          </select>
        </div>
        <div class="form-group-inline">
          <label>Department</label>
          <input type="text" class="filter-select compact" value="${esc(dept)}"
                 placeholder="e.g. Engineering"
                 onchange="setDepartment('${user.id}', this.value)" />
        </div>
      </div>
    ` : '';

    return `
      <div class="team-node" style="margin-left:${depth * 32}px">
        <div class="team-node-card ${isCurrent ? 'team-node-current' : ''}">
          <div class="team-node-main">
            <div class="avatar" style="background:${user.color}">${initials(user.name)}</div>
            <div class="team-node-info">
              <div class="team-node-name">
                ${esc(user.name)}
                ${isCurrent ? '<span class="you-badge">YOU</span>' : ''}
                ${reports.length ? `<span class="reports-badge">${reports.length} report${reports.length > 1 ? 's' : ''}</span>` : ''}
              </div>
              <div class="team-node-meta">
                ${dept ? `<span class="dept-tag">${esc(dept)}</span>` : ''}
                <span>${esc(user.role || 'Member')}</span>
              </div>
            </div>
            <div class="team-node-stats">
              <div class="team-stat-pill"><strong>${assigned}</strong> tasks</div>
              <div class="team-stat-pill active-pill"><strong>${active}</strong> active</div>
              <div class="team-stat-pill done-pill"><strong>${done}</strong> done</div>
            </div>
            <div class="team-node-actions">
              <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();openTaskModal(null,{assignee:'${user.id}'})">
                <i data-lucide="plus"></i> Assign
              </button>
              ${!isCurrent ? `<button class="btn btn-sm btn-outline" onclick="event.stopPropagation();removeUser('${user.id}')">
                <i data-lucide="user-minus"></i>
              </button>` : ''}
            </div>
          </div>
          ${editControls}
        </div>
        ${reports.length ? `<div class="team-node-reports">${reports.map(r => renderMemberNode(r, depth + 1)).join('')}</div>` : ''}
      </div>
    `;
  }

  container.innerHTML = roots.map(u => renderMemberNode(u, 0)).join('');

  if (!S.users.length) {
    container.innerHTML = '<p style="color:var(--text-3);text-align:center;padding:40px">No team members yet</p>';
  }

  lucide.createIcons();
}

function setManager(userId, managerId) {
  const user = S.users.find(u => u.id === userId);
  if (!user) return;
  // Prevent circular: can't set yourself or a descendant as manager
  if (managerId && isDescendant(managerId, userId)) {
    showToast("Can't create circular reporting", "warning");
    renderTeam();
    return;
  }
  user.managerId = managerId || "";
  saveToStorage();
  renderTeam();
}

function setDepartment(userId, dept) {
  const user = S.users.find(u => u.id === userId);
  if (!user) return;
  user.department = dept.trim();
  saveToStorage();
  // Don't re-render immediately (user might still be typing)
}

function isDescendant(checkId, ofId) {
  // Check if checkId is a descendant of ofId in the hierarchy
  const reports = S.users.filter(u => u.managerId === ofId);
  for (const r of reports) {
    if (r.id === checkId) return true;
    if (isDescendant(checkId, r.id)) return true;
  }
  return false;
}

function getTeamMembers(userId) {
  // Get all direct reports (and their reports) under a user
  const result = [];
  const reports = S.users.filter(u => u.managerId === userId);
  for (const r of reports) {
    result.push(r);
    result.push(...getTeamMembers(r.id));
  }
  return result;
}

function removeUser(userId) {
  const u = getUserById(userId);
  if (!u || !confirm(`Remove ${u.name} from the team?`)) return;
  S.users = S.users.filter(x => x.id !== userId);
  S.tasks.forEach(t => { if (t.assignee === userId) t.assignee = ""; });
  saveToStorage();
  renderTeam();
  populateUserFilters();
  showToast(`Removed ${u.name}`, "info");
}

// ── ACTIVITY LOG ──────────────────────────────────────────────
function logActivity(action, taskTitle, detail="") {
  const u = getCurrentUser();
  S.activityLog.unshift({
    id: uid(), action, taskTitle, detail,
    userId: S.currentUserId, userName: u?.name||"Unknown",
    createdAt: Date.now(),
  });
  if (S.activityLog.length > 200) S.activityLog.pop();
}

const ACTION_ICONS = {
  create:"plus-circle", update:"edit-2", delete:"trash-2", move:"arrows-up-down",
  comment:"message-circle", attach:"paperclip",
};

function renderActivity() {
  const list = document.getElementById("activityLogList");
  list.innerHTML = S.activityLog.length ? S.activityLog.map(a => `
    <div class="activity-item">
      <i data-lucide="${ACTION_ICONS[a.action]||"activity"}"></i>
      <div class="activity-text">
        <strong>${esc(a.userName)}</strong>
        ${a.action === "create" ? "created" : a.action === "update" ? "updated" :
          a.action === "delete" ? "deleted" : a.action === "move" ? "moved" : a.action}
        "${esc(a.taskTitle)}"
        ${a.detail ? `<span style="color:var(--text-3)"> ${esc(a.detail)}</span>` : ""}
      </div>
      <div class="activity-time">${timeAgo(a.createdAt)}</div>
    </div>
  `).join("") : `<p style="color:var(--text-3);text-align:center;padding:40px">No activity yet</p>`;
  lucide.createIcons();
}

function clearActivityLog() {
  if (!confirm("Clear all activity logs?")) return;
  S.activityLog = [];
  saveToStorage();
  renderActivity();
}

// ── NOTIFICATIONS ─────────────────────────────────────────────
function addNotification(message, type="info") {
  S.notifications.unshift({ id: uid(), message, type, read: false, createdAt: Date.now() });
  updateBadges();
  saveToStorage();
}

function showNotifications() {
  const panel = document.getElementById("notificationsPanel");
  panel.classList.toggle("hidden");
  const list = document.getElementById("notifList");
  list.innerHTML = S.notifications.length ? S.notifications.slice(0,20).map(n => `
    <div class="notif-item ${n.read?"":"unread"}">
      <div style="flex:1">
        <div style="font-weight:${n.read?400:600}">${esc(n.message)}</div>
        <div style="font-size:10px;color:var(--text-3);margin-top:2px">${timeAgo(n.createdAt)}</div>
      </div>
    </div>
  `).join("") : `<p style="padding:20px;color:var(--text-3);font-size:13px;text-align:center">No notifications</p>`;

  S.notifications.forEach(n => n.read = true);
  updateBadges();
  saveToStorage();
}

function clearNotifications() {
  S.notifications = [];
  updateBadges();
  saveToStorage();
  document.getElementById("notifList").innerHTML = `<p style="padding:20px;color:var(--text-3);text-align:center">Cleared</p>`;
}

function checkDueTasks() {
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate()+1);
  const tomorrowStr = tomorrow.toISOString().slice(0,10);
  const todayStr = new Date().toISOString().slice(0,10);

  S.tasks.forEach(t => {
    if (t.status === "done") return;
    if (t.dueDate === todayStr && !t._notifiedToday) {
      t._notifiedToday = true;
      addNotification(`Task due today: "${t.title}"`, "warning");
    } else if (t.dueDate === tomorrowStr && !t._notifiedTomorrow) {
      t._notifiedTomorrow = true;
      addNotification(`Task due tomorrow: "${t.title}"`, "info");
    }
  });
  updateBadges();
}

function updateBadges() {
  const active = S.tasks.filter(t => t.status !== "done").length;
  const badge = document.getElementById("tasksBadge");
  if (badge) badge.textContent = active || "";

  const unread = S.notifications.filter(n => !n.read).length;
  document.getElementById("notifDot")?.classList.toggle("hidden", !unread);
}

// ── SEARCH ────────────────────────────────────────────────────
function handleSearch(query) {
  const results = document.getElementById("searchResults");
  if (!query.trim()) { results.classList.add("hidden"); return; }

  const q = query.toLowerCase();
  const matched = S.tasks.filter(t =>
    t.title.toLowerCase().includes(q) ||
    (t.description||"").toLowerCase().includes(q) ||
    (t.labels||[]).some(l => l.toLowerCase().includes(q))
  ).slice(0,8);

  results.classList.remove("hidden");
  results.innerHTML = matched.length ? matched.map(t => `
    <div class="search-result-item" onclick="openTaskModal('${t.id}');document.getElementById('searchResults').classList.add('hidden')">
      ${priorityDot(t.priority)}
      <div style="flex:1;min-width:0">
        <div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.title)}</div>
        <div style="font-size:11px;color:var(--text-3)">${STATUS_LABELS[t.status]} • ${t.priority}</div>
      </div>
      <span class="status-badge status-${t.status}" style="font-size:10px">${STATUS_LABELS[t.status]}</span>
    </div>
  `).join("") : `<div style="padding:14px 16px;color:var(--text-3);font-size:13px">No results for "${esc(query)}"</div>`;
}

// ── SIDEBAR TOGGLE ────────────────────────────────────────────
function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  sidebar.classList.toggle("collapsed");
  sidebar.classList.toggle("open");
  S.sidebarOpen = !S.sidebarOpen;
  lucide.createIcons();
}

// ── GOOGLE VIEWS (delegated to google-integration.js) ────────
function initGmailView()    { if (typeof setupGmailView === "function")    setupGmailView();    else showConnectPrompt("gmail"); }
function initDriveView()    { if (typeof setupDriveView === "function")    setupDriveView();    else showConnectPrompt("drive"); }
function initGCalView()     { if (typeof setupGCalView === "function")     setupGCalView();     else showConnectPrompt("gcalendar"); }
function initChatView()     { if (typeof setupChatView === "function")     setupChatView();     else showConnectPrompt("chat"); }

function showConnectPrompt(service) {
  const prompts = { gmail:"gmailConnectPrompt", drive:"driveConnectPrompt", gcalendar:"gcalConnectPrompt", chat:"chatConnectPrompt" };
  const panels = { gmail:"gmailPanel", drive:"drivePanel", gcalendar:"gcalPanel", chat:"chatPanel" };
  const p = document.getElementById(prompts[service]);
  const panel = document.getElementById(panels[service]);
  if (p) p.classList.remove("hidden");
  if (panel) panel.classList.add("hidden");
}

function addTaskToGoogleCalendar() {
  if (typeof createCalendarEventFromTask === "function") {
    createCalendarEventFromTask();
  } else {
    showToast("Connect Google to add to Calendar", "warning");
  }
}

// ── Google Calendar connection from local Calendar view ──────
function connectGoogleCalendar() {
  if (typeof G !== "undefined" && G.isSignedIn) {
    // Already connected — refresh events
    refreshGoogleCalendar();
    return;
  }
  if (typeof handleGoogleAuth === "function") {
    handleGoogleAuth();
  } else {
    showToast("Google integration not available. Sign in with Google on the login screen to connect.", "warning");
  }
}

function refreshGoogleCalendar() {
  if (typeof G !== "undefined" && G.isSignedIn) {
    const year = S.calMonth.getFullYear();
    const month = S.calMonth.getMonth();
    fetchCalEventsForMonth(year, month);
    showToast("Google Calendar refreshed", "success");
  }
}

function updateGCalConnectButton() {
  const btn = document.getElementById("calGoogleBtn");
  const btnText = document.getElementById("calGoogleBtnText");
  const banner = document.getElementById("gcalStatusBanner");
  if (!btn) return;

  if (typeof G !== "undefined" && G.isSignedIn) {
    btnText.textContent = "Connected";
    btn.classList.add("connected");
    if (banner) banner.classList.remove("hidden");
  } else {
    btnText.textContent = "Connect Google Calendar";
    btn.classList.remove("connected");
    if (banner) banner.classList.add("hidden");
  }
}

function openDriveFilePicker() {
  if (typeof openDrivePicker === "function") {
    openDrivePicker();
  } else {
    showToast("Connect Google Drive to attach files", "warning");
  }
}

function openComposeModal() {
  document.getElementById("composeModal").classList.remove("hidden");
  lucide.createIcons();
}

function openGCalEventModal() {
  const now = new Date();
  const end = new Date(now.getTime() + 3600000);
  document.getElementById("gcalEventStart").value = toDateTimeLocal(now);
  document.getElementById("gcalEventEnd").value = toDateTimeLocal(end);
  document.getElementById("gcalEventModal").classList.remove("hidden");
  lucide.createIcons();
}

function toDateTimeLocal(d) {
  return d.toISOString().slice(0,16);
}

// ── UTILS ─────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}
function initials(name) {
  if (!name) return "?";
  return name.split(" ").map(w=>w[0]).slice(0,2).join("").toUpperCase();
}
function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function timeAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff/60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m/60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h/24)}d ago`;
}

// ── TOAST ─────────────────────────────────────────────────────
function showToast(message, type = "info") {
  const icons = { success:"check-circle", error:"x-circle", warning:"alert-triangle", info:"info" };
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <i data-lucide="${icons[type]||"info"}"></i>
    <span>${esc(message)}</span>
    <span class="toast-close" onclick="removeToast(this.parentElement)">
      <i data-lucide="x" style="width:14px;height:14px"></i>
    </span>
  `;
  container.appendChild(toast);
  lucide.createIcons({ nodes: [toast] });
  setTimeout(() => removeToast(toast), 4000);
}

function removeToast(el) {
  el.classList.add("removing");
  setTimeout(() => el.remove(), 200);
}

// ── WEEKLY UPDATE EMAIL ──────────────────────────────────────
const PEOPLE_BASE = "https://people.googleapis.com/v1";

function getWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  monday.setHours(0,0,0,0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23,59,59,999);
  return { start: monday, end: sunday };
}

function getWeeklyTasks() {
  const { start, end } = getWeekRange();
  const startStr = start.toISOString().slice(0,10);
  const endStr = end.toISOString().slice(0,10);

  // Tasks due this week OR currently in progress
  const weekTasks = S.tasks.filter(t => {
    const dueInWeek = t.dueDate && t.dueDate >= startStr && t.dueDate <= endStr;
    const inProgress = t.status === "inprogress";
    const completedThisWeek = t.status === "done" && t.completedAt &&
      new Date(t.completedAt) >= start && new Date(t.completedAt) <= end;
    return dueInWeek || inProgress || completedThisWeek;
  });

  return {
    done: weekTasks.filter(t => t.status === "done"),
    inProgress: weekTasks.filter(t => t.status === "inprogress"),
    todo: weekTasks.filter(t => t.status === "todo"),
    review: weekTasks.filter(t => t.status === "review"),
  };
}

function generateWeeklyEmailBody(recipientName) {
  const tasks = getWeeklyTasks();
  const { start, end } = getWeekRange();
  const weekLabel = `${start.toLocaleDateString("en-US", {month:"short",day:"numeric"})} – ${end.toLocaleDateString("en-US", {month:"short",day:"numeric",year:"numeric"})}`;
  const user = getUserById(S.currentUserId);
  const name = user ? user.name : "Team member";
  const greet = (recipientName && recipientName.trim()) ? recipientName.trim() : "team";

  let body = `Hi ${greet},\n\nHere's my weekly progress update for ${weekLabel}:\n\n`;

  if (tasks.done.length) {
    body += `✅ Completed (${tasks.done.length}):\n`;
    tasks.done.forEach(t => { body += `  • ${t.title}\n`; });
    body += `\n`;
  }

  if (tasks.inProgress.length) {
    body += `🔄 In Progress (${tasks.inProgress.length}):\n`;
    tasks.inProgress.forEach(t => {
      const subtasks = t.subtasks || [];
      const doneSub = subtasks.filter(s => s.done).length;
      const progress = subtasks.length ? ` [${doneSub}/${subtasks.length} subtasks done]` : "";
      body += `  • ${t.title}${progress}\n`;
    });
    body += `\n`;
  }

  if (tasks.review.length) {
    body += `👀 In Review (${tasks.review.length}):\n`;
    tasks.review.forEach(t => { body += `  • ${t.title}\n`; });
    body += `\n`;
  }

  if (tasks.todo.length) {
    body += `📋 Planned (${tasks.todo.length}):\n`;
    tasks.todo.forEach(t => { body += `  • ${t.title}\n`; });
    body += `\n`;
  }

  const total = tasks.done.length + tasks.inProgress.length + tasks.review.length + tasks.todo.length;
  if (total === 0) {
    body += `No tasks scheduled for this week yet.\n\n`;
  }

  body += `Best regards,\n${name}`;
  return body;
}

async function lookupContactEmail(name) {
  if (!G.isSignedIn) throw new Error("Google not connected");
  // Search Google Contacts for the name
  const query = encodeURIComponent(name);
  const url = `${PEOPLE_BASE}/people:searchContacts?query=${query}&readMask=names,emailAddresses&pageSize=5`;
  try {
    const data = await gFetch(url);
    const results = data.results || [];
    for (const r of results) {
      const person = r.person;
      if (person && person.emailAddresses && person.emailAddresses.length > 0) {
        return {
          name: person.names?.[0]?.displayName || name,
          email: person.emailAddresses[0].value
        };
      }
    }
  } catch(e) {
    console.warn("[WeeklyUpdate] Contact search failed:", e);
  }
  return null;
}

// ── Configurable recipient list (team members + saved custom) ──
const WEEKLY_RECIP_KEY = "tf_weekly_recipients";
const WEEKLY_LAST_KEY  = "tf_weekly_last";

function getSavedRecipients() {
  try { return JSON.parse(localStorage.getItem(WEEKLY_RECIP_KEY)) || []; } catch (e) { return []; }
}
function setSavedRecipients(list) {
  try { localStorage.setItem(WEEKLY_RECIP_KEY, JSON.stringify(list)); } catch (e) {}
}
// Team members (with email, excluding myself) + saved custom recipients, deduped
function getAllRecipients() {
  const map = new Map();
  (S.users || []).forEach(u => {
    if (u.email && u.id !== S.currentUserId) map.set(u.email.toLowerCase(), { name: u.name || u.email, email: u.email });
  });
  getSavedRecipients().forEach(r => {
    if (r.email) map.set(r.email.toLowerCase(), { name: r.name || r.email, email: r.email });
  });
  return Array.from(map.values());
}

function populateWeeklyRecipientPicker(selectEmail) {
  const sel = document.getElementById("weeklyRecipientPicker");
  if (!sel) return;
  const recips = getAllRecipients();
  const chosen = (selectEmail || localStorage.getItem(WEEKLY_LAST_KEY) || (recips[0] && recips[0].email) || "").toLowerCase();
  sel.innerHTML = recips.length
    ? recips.map(r => `<option value="${esc(r.email)}" data-name="${esc(r.name)}" ${r.email.toLowerCase() === chosen ? "selected" : ""}>${esc(r.name)} — ${esc(r.email)}</option>`).join("")
    : `<option value="">No recipients yet — click + to add</option>`;
}

function onWeeklyRecipientPick() {
  const sel = document.getElementById("weeklyRecipientPicker");
  if (!sel) return;
  const opt = sel.options[sel.selectedIndex];
  const email = opt ? opt.value : "";
  const name  = opt && opt.dataset.name ? opt.dataset.name : (email ? email.split("@")[0] : "team");
  const toEl = document.getElementById("weeklyTo");
  if (toEl) toEl.value = email;
  refreshWeeklyDraft(name);
}

function refreshWeeklyDraft(recipientName) {
  const { start, end } = getWeekRange();
  const weekLabel = `${start.toLocaleDateString("en-US", {month:"short",day:"numeric"})} – ${end.toLocaleDateString("en-US", {month:"short",day:"numeric"})}`;
  const subj = document.getElementById("weeklySubject");
  const body = document.getElementById("weeklyBody");
  if (subj) subj.value = `Weekly Update — ${weekLabel}`;
  if (body) body.value = generateWeeklyEmailBody(recipientName);
}

function openWeeklyUpdateDraft() {
  if (!G.isSignedIn) {
    showToast("Please connect Google first to send emails", "warning");
    return;
  }
  populateWeeklyRecipientPicker();
  onWeeklyRecipientPick(); // fills To + subject + body from the current selection
  document.getElementById("weeklyUpdateModal").classList.remove("hidden");
  lucide.createIcons();
}

// ── Add / configure a recipient (modal, no native prompt) ──
function addWeeklyRecipient() {
  let modal = document.getElementById("addRecipientModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "addRecipientModal";
    modal.className = "modal-overlay hidden";
    modal.innerHTML = `
      <div class="modal" style="max-width:420px" onclick="event.stopPropagation()">
        <div class="modal-header">
          <h3>Add recipient</h3>
          <button class="icon-btn" onclick="closeModal('addRecipientModal')"><i data-lucide="x"></i></button>
        </div>
        <div class="modal-body">
          <label class="form-label">Name</label>
          <input id="newRecipName" class="form-input" style="width:100%;margin-bottom:12px" placeholder="e.g. P'Ong" />
          <label class="form-label">Email</label>
          <input id="newRecipEmail" type="email" class="form-input" style="width:100%" placeholder="name@fairdee.co.th"
                 onkeydown="if(event.key==='Enter')submitAddRecipient()" />
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
            <button class="btn btn-outline" onclick="closeModal('addRecipientModal')">Cancel</button>
            <button class="btn btn-primary" onclick="submitAddRecipient()">Save</button>
          </div>
        </div>
      </div>`;
    modal.addEventListener("click", () => closeModal("addRecipientModal"));
    document.body.appendChild(modal);
  }
  modal.classList.remove("hidden");
  document.getElementById("newRecipName").value = "";
  document.getElementById("newRecipEmail").value = "";
  setTimeout(() => document.getElementById("newRecipName")?.focus(), 50);
  lucide.createIcons();
}

function submitAddRecipient() {
  const name  = document.getElementById("newRecipName").value.trim();
  const email = document.getElementById("newRecipEmail").value.trim();
  if (!email) { showToast("Enter an email", "warning"); return; }
  const list = getSavedRecipients();
  if (!list.find(r => r.email.toLowerCase() === email.toLowerCase())) {
    list.push({ name: name || email.split("@")[0], email });
    setSavedRecipients(list);
  }
  closeModal("addRecipientModal");
  populateWeeklyRecipientPicker(email);
  onWeeklyRecipientPick();
  showToast("Recipient added", "success");
}

async function sendWeeklyUpdate() {
  const to = document.getElementById("weeklyTo").value.trim();
  const subject = document.getElementById("weeklySubject").value.trim();
  const body = document.getElementById("weeklyBody").value.trim();

  if (!to || !subject) {
    showToast("Please fill in recipient and subject", "warning");
    return;
  }

  const raw = btoa(unescape(encodeURIComponent(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  try {
    await gFetch(`${GMAIL_BASE}/messages/send`, { method: "POST", body: JSON.stringify({ raw }) });
    // Remember this recipient for next time + add to the saved list
    try { localStorage.setItem(WEEKLY_LAST_KEY, to); } catch (e) {}
    const list = getSavedRecipients();
    if (!list.find(r => r.email.toLowerCase() === to.toLowerCase())) {
      list.push({ name: to.split("@")[0], email: to });
      setSavedRecipients(list);
    }
    showToast("Weekly update sent to " + to + "!", "success");
    closeModal("weeklyUpdateModal");
  } catch (e) {
    showToast("Send failed: " + e.message, "error");
  }
}

function closeWeeklyModal() {
  document.getElementById("weeklyUpdateModal").classList.add("hidden");
}
