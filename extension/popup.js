/* ============================================================
   TASKFLOW EXTENSION — POPUP
   Renders from the local cache first, then refreshes from Firestore.
   Every edit is optimistic: the cache changes, the UI redraws, and
   the PATCH goes out behind it.
   ============================================================ */
"use strict";

import { CONFIG } from "./config.js";
import { getSession, signOut } from "./lib/auth.js";
import { updateTask, createTask, deleteTask, newTaskId } from "./lib/firestore.js";
import {
  getCache, getPrefs, setPrefs, syncAll, patchCachedTask,
  addCachedTask, removeCachedTask, switchTeam, clearCache,
} from "./lib/store.js";
import * as M from "./lib/model.js";
import { icon, paintIcons } from "./lib/icons.js";

const $ = id => document.getElementById(id);

const state = {
  session: null,
  cache: null,
  prefs: null,
  editing: null,        // task id, or "new"
  draft: null,          // pending new-task fields
  selfWrite: 0,         // ignore storage events we caused ourselves
  saveTimer: null,
};

// ── Boot ──────────────────────────────────────────────────────
(async function init() {
  paintIcons();

  state.prefs = await getPrefs();
  applyTheme(state.prefs.theme);

  state.session = await getSession();
  if (!state.session) { showSignedOut(); return; }

  state.cache = await getCache();
  showSignedIn();
  wireEvents();
  wirePane();
  renderTeams();
  renderList();

  // Cache first, network second.
  refresh({ quiet: true });
})();

function showSignedOut(message) {
  $("signinView").classList.remove("hidden");
  $("mainView").classList.add("hidden");
  $("detailPane").classList.add("hidden");
  if (message) {
    const hint = $("signinHint");
    hint.textContent = message;
    hint.classList.remove("hidden");
  }
  $("signinBtn").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("signin.html") });
    window.close();
  });
}

function showSignedIn() {
  $("signinView").classList.add("hidden");
  $("mainView").classList.remove("hidden");
}

// ── Theme ─────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = $("themeBtn");
  if (btn) btn.innerHTML = icon(theme === "dark" ? "sun" : "moon");
}

// ── Sync ──────────────────────────────────────────────────────
async function refresh({ quiet = false } = {}) {
  const btn = $("refreshBtn");
  btn.classList.add("spinning");
  if (!quiet) setSync("Syncing…");
  try {
    state.selfWrite++;
    state.cache = await syncAll();
    renderTeams();
    renderList();
    if (state.editing && state.editing !== "new") renderDetailIfIdle();
    setSync();
  } catch (e) {
    if (e.message === "SESSION_EXPIRED") {
      await clearCache();
      showSignedOut("Your session expired — please sign in again.");
      return;
    }
    setSync(e.message, true);
  } finally {
    btn.classList.remove("spinning");
  }
}

function setSync(text, isError) {
  const el = $("syncLabel");
  el.classList.toggle("err", !!isError);
  if (text) { el.textContent = text; return; }
  const n = state.cache?.tasks?.length || 0;
  el.textContent = `${n} task${n === 1 ? "" : "s"} · synced ${M.timeAgo(state.cache?.syncedAt)}`;
}

// ── Directory / team helpers ──────────────────────────────────
function userOf(uid) {
  const u = (state.cache?.directory || {})[uid];
  if (!u) return { uid, name: uid === state.session.uid ? "Me" : "Unknown", email: "", picture: "" };
  return { uid, name: u.name || u.email || "Member", email: u.email || "", picture: u.picture || "" };
}

function activeTeam() {
  return (state.cache?.teams || []).find(t => t.id === state.cache.activeTeamId) || null;
}

function memberIds() {
  const team = activeTeam();
  const ids = team ? (team.memberIds || []) : [];
  return Array.from(new Set([state.session.uid, ...ids]));
}

function avatarHtml(uid, size) {
  const u = userOf(uid);
  const cls = size === "sm" ? "avatar sm" : "avatar";
  if (u.picture) return `<img class="${cls}" src="${M.esc(u.picture)}" alt="${M.esc(u.name)}" title="${M.esc(u.name)}" />`;
  return `<span class="${cls}" style="background:${M.avatarColor(u.email || uid)}" title="${M.esc(u.name)}">${M.esc(M.initials(u.name))}</span>`;
}

// ── Team switcher ─────────────────────────────────────────────
function renderTeams() {
  const sel = $("teamSelect");
  const personal = M.personalTeamId(state.session.uid);
  const active = state.cache.activeTeamId || personal;
  sel.innerHTML = [
    `<option value="${personal}">Personal (just me)</option>`,
    ...(state.cache.teams || []).map(t => `<option value="${M.esc(t.id)}">${M.esc(t.name)}</option>`),
  ].join("");
  sel.value = active;
}

// ── Task list ─────────────────────────────────────────────────
function visibleTasks() {
  const uid = state.session.uid;
  const q = ($("searchInput").value || "").trim().toLowerCase();
  let tasks = state.cache.tasks || [];

  if (state.prefs.scope === "mine") tasks = tasks.filter(t => M.isMine(t, uid));
  if (state.prefs.scope === "late") {
    tasks = tasks.filter(t => M.isActiveTask(t) && (M.isOverdue(t.dueDate) || M.isDueToday(t.dueDate)));
  }

  if (q) {
    tasks = tasks.filter(t => {
      const hay = [
        t.title, t.description, (t.labels || []).join(" "),
        userOf(t.assignee).name,
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }
  return tasks;
}

function renderList() {
  closeStatusMenu();
  const host = $("list");
  const tasks = visibleTasks();

  $("scopeTabs").querySelectorAll("button").forEach(b => {
    b.classList.toggle("active", b.dataset.scope === state.prefs.scope);
  });

  if (!tasks.length) {
    host.innerHTML = `
      <div class="empty">
        ${icon("clipboard", 28)}
        <p>${(state.cache.tasks || []).length
              ? "No tasks match this filter."
              : "No tasks in this team yet."}</p>
      </div>`;
    setSync();
    return;
  }

  const collapsed = state.prefs.collapsed || {};
  host.innerHTML = M.STATUSES.map(status => {
    const group = M.sortTasks(tasks.filter(t => t.status === status));
    if (!group.length) return "";
    const isCollapsed = !!collapsed[status];
    return `
      <div class="group">
        <button class="group-head" data-act="toggle-group" data-status="${status}">
          <span class="group-dot" style="background:${M.STATUS_COLORS[status]}"></span>
          ${M.STATUS_LABELS[status]}
          <span class="group-count">${group.length}</span>
          <span style="display:flex;color:var(--text-3)">${icon(isCollapsed ? "chevronRight" : "chevronDown", 13)}</span>
        </button>
        ${isCollapsed ? "" : group.map(taskRow).join("")}
      </div>`;
  }).join("");

  setSync();
}

function taskRow(t) {
  const done = t.status === "done";
  const live = M.isActiveTask(t);
  const overdue = live && M.isOverdue(t.dueDate);
  const today = live && !overdue && M.isDueToday(t.dueDate);
  const subs = t.subtasks || [];
  const subsDone = subs.filter(s => s.done).length;
  const labels = (t.labels || []).slice(0, 2);

  const meta = [];
  if (t.priority) {
    meta.push(`<span class="meta-chip"><span class="pdot" style="background:${M.PRIORITY_COLORS[t.priority] || "#999"}"></span>${M.PRIORITY_LABELS[t.priority] || t.priority}</span>`);
  }
  if (t.dueDate) {
    meta.push(`<span class="meta-chip ${overdue ? "overdue" : today ? "today" : ""}">${icon("calendar", 11)}${M.esc(M.formatDate(t.dueDate))}</span>`);
  }
  if (subs.length) {
    meta.push(`<span class="meta-chip">${icon("listChecks", 11)}${subsDone}/${subs.length}</span>`);
  }
  if ((t.comments || []).length) {
    meta.push(`<span class="meta-chip">${icon("message", 11)}${t.comments.length}</span>`);
  }
  labels.forEach(l => {
    meta.push(`<span class="label-chip" style="background:${M.getLabelColor(l)}">${M.esc(l)}</span>`);
  });

  return `
    <div class="task ${done ? "is-done" : ""}" data-act="open" data-id="${M.esc(t.id)}">
      <button class="check ${done ? "on" : ""}" data-act="toggle-done" data-id="${M.esc(t.id)}"
              title="${done ? "Reopen" : "Mark done"}">${icon("check", 10)}</button>
      <div class="task-body">
        <div class="task-title">${M.esc(t.title || "Untitled")}</div>
        ${meta.length ? `<div class="task-meta">${meta.join("")}</div>` : ""}
      </div>
      ${t.assignee ? avatarHtml(t.assignee, "sm") : ""}
      <button class="status-btn" data-act="status-menu" data-id="${M.esc(t.id)}"
              title="Move to another stage">
        <span class="sdot" style="background:${M.STATUS_COLORS[t.status] || "#999"}"></span>
        ${icon("chevronDown", 11)}
      </button>
    </div>`;
}

// ── Detail pane ───────────────────────────────────────────────
function currentTask() {
  return (state.cache.tasks || []).find(t => t.id === state.editing) || null;
}

function openDetail(taskId) {
  state.editing = taskId;
  state.draft = null;
  renderDetail();
  $("detailPane").classList.remove("hidden");
}

function openNew() {
  state.editing = "new";
  state.draft = {
    title: "", description: "", status: "todo", priority: "medium",
    assignee: state.session.uid, dueDate: "", labels: [],
  };
  renderDetail();
  $("detailPane").classList.remove("hidden");
  setTimeout(() => $("dTitle")?.focus(), 60);
}

function closeDetail() {
  state.editing = null;
  state.draft = null;
  $("detailPane").classList.add("hidden");
  renderList();
}

function selectHtml(id, options, value) {
  return `<select id="${id}" class="select">` +
    options.map(o => `<option value="${M.esc(o.value)}"${o.value === value ? " selected" : ""}>${M.esc(o.label)}</option>`).join("") +
    `</select>`;
}

/** Re-render only when the user isn't mid-keystroke in the pane. */
function renderDetailIfIdle() {
  const active = document.activeElement;
  if (active && $("detailPane").contains(active) && /INPUT|TEXTAREA/.test(active.tagName)) return;
  renderDetail();
}

function renderDetail(focusId) {
  const isNew = state.editing === "new";
  const t = isNew ? state.draft : currentTask();
  if (!t) { closeDetail(); return; }

  const subs = t.subtasks || [];
  const subsDone = subs.filter(s => s.done).length;
  const pct = subs.length ? Math.round((subsDone / subs.length) * 100) : 0;

  const assigneeOptions = [
    { value: "", label: "Unassigned" },
    ...memberIds().map(uid => ({ value: uid, label: userOf(uid).name + (uid === state.session.uid ? " (me)" : "") })),
  ];
  if (t.assignee && !assigneeOptions.some(o => o.value === t.assignee)) {
    assigneeOptions.push({ value: t.assignee, label: userOf(t.assignee).name });
  }

  $("detailPane").innerHTML = `
    <div class="pane-head">
      <button class="icon-btn" data-act="back" title="Back">${icon("chevronLeft")}</button>
      <div class="title">${isNew ? "New task" : "Task"}</div>
      ${isNew ? "" : `<button class="icon-btn" data-act="open-app" title="Open in TaskFlow">${icon("externalLink")}</button>`}
    </div>

    <div class="pane-body">
      <div class="field">
        <input id="dTitle" class="input input-title" placeholder="Task title" value="${M.esc(t.title)}" />
      </div>

      <div class="field">
        <label class="field-label">Description</label>
        <textarea id="dDesc" class="textarea" placeholder="Add more detail…">${M.esc(t.description)}</textarea>
      </div>

      <div class="grid-2">
        <div class="field">
          <label class="field-label">Status</label>
          ${selectHtml("dStatus", M.STATUSES.map(s => ({ value: s, label: M.STATUS_LABELS[s] })), t.status)}
        </div>
        <div class="field">
          <label class="field-label">Priority</label>
          ${selectHtml("dPriority", M.PRIORITIES.map(p => ({ value: p, label: M.PRIORITY_LABELS[p] })), t.priority)}
        </div>
        <div class="field">
          <label class="field-label">Assignee</label>
          ${selectHtml("dAssignee", assigneeOptions, t.assignee || "")}
        </div>
        <div class="field">
          <label class="field-label">Due date</label>
          <input id="dDue" class="input" type="date" value="${M.esc(t.dueDate || "")}" />
        </div>
      </div>

      <div class="field">
        <label class="field-label">Labels</label>
        <div class="chips">
          ${(t.labels || []).map(l => `
            <span class="chip" style="background:${M.getLabelColor(l)}">${M.esc(l)}
              <span class="x" data-act="rm-label" data-label="${M.esc(l)}">×</span>
            </span>`).join("")}
        </div>
        <div class="row-add">
          <input id="labelInput" class="input" placeholder="Add a label…" />
          <button class="btn btn-outline btn-sm" data-act="add-label">Add</button>
        </div>
      </div>

      ${isNew ? "" : `
      <div class="field">
        <label class="field-label">Subtasks ${subs.length ? `(${subsDone}/${subs.length})` : ""}</label>
        ${subs.length ? `<div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>` : ""}
        <div style="margin-top:4px">
          ${subs.map((s, i) => `
            <div class="subtask ${s.done ? "done" : ""}">
              <button class="check ${s.done ? "on" : ""}" data-act="toggle-sub" data-index="${i}">${icon("check", 10)}</button>
              <span>${M.esc(s.title)}</span>
              <button class="rm" data-act="rm-sub" data-index="${i}" title="Remove">×</button>
            </div>`).join("")}
        </div>
        <div class="row-add">
          <input id="subInput" class="input" placeholder="Add a subtask…" />
          <button class="btn btn-outline btn-sm" data-act="add-sub">Add</button>
        </div>
      </div>

      <div class="field">
        <label class="field-label">Comments</label>
        <div>
          ${(t.comments || []).map(c => `
            <div class="comment">
              ${avatarHtml(c.userId, "sm")}
              <div class="comment-body">
                <div class="comment-head">
                  <span class="comment-author">${M.esc(userOf(c.userId).name)}</span>
                  <span class="comment-time">${M.esc(M.timeAgo(c.createdAt))}</span>
                </div>
                <div class="comment-text">${M.esc(c.text)}</div>
              </div>
            </div>`).join("") || `<p style="font-size:11.5px;color:var(--text-3)">No comments yet.</p>`}
        </div>
        <div class="row-add">
          <input id="commentInput" class="input" placeholder="Write a comment…" />
          <button class="btn btn-outline btn-sm" data-act="add-comment">${icon("send", 13)}</button>
        </div>
      </div>`}
    </div>

    <div class="pane-foot">
      ${isNew
        ? `<button class="btn btn-primary" data-act="create">${icon("plus", 13)} Create task</button>`
        : `<button class="btn btn-danger btn-sm" data-act="delete">${icon("trash", 13)} Delete</button>`}
      <span class="spacer"></span>
      <span id="saveState" class="saving"></span>
    </div>`;

  wireDetailFields(isNew);
  if (focusId) $(focusId)?.focus();
}

function setSaveState(text, kind) {
  const el = $("saveState");
  if (!el) return;
  el.className = "saving" + (kind ? " " + kind : "");
  el.textContent = text || "";
}

// ── Writes ────────────────────────────────────────────────────
async function save(patch) {
  const id = state.editing;
  if (!id || id === "new") return;

  setSaveState("Saving…");
  state.selfWrite++;
  state.cache = await patchCachedTask(id, { ...patch, updatedAt: Date.now() });

  try {
    await updateTask(id, patch);
    setSaveState("Saved", "ok");
    setTimeout(() => setSaveState(""), 1400);
  } catch (e) {
    setSaveState("Not saved", "err");
    toast(e.message === "SESSION_EXPIRED" ? "Session expired — sign in again" : e.message, true);
    await refresh({ quiet: true });   // pull back the server's version
  }
}

/** Move a task to another stage from the list, without opening it. */
async function changeStatus(taskId, status) {
  state.selfWrite++;
  state.cache = await patchCachedTask(taskId, { status, updatedAt: Date.now() });
  renderList();
  if (state.editing === taskId) renderDetail();

  try {
    await updateTask(taskId, { status });
  } catch (e) {
    toast(e.message, true);
    await refresh({ quiet: true });
  }
}

function toggleDone(taskId) {
  const t = (state.cache.tasks || []).find(x => x.id === taskId);
  if (!t) return;
  return changeStatus(taskId, t.status === "done" ? "todo" : "done");
}

// ── Stage menu ────────────────────────────────────────────────
let closeMenuListener = null;

function closeStatusMenu() {
  document.getElementById("statusMenu")?.remove();
  if (closeMenuListener) {
    document.removeEventListener("click", closeMenuListener);
    closeMenuListener = null;
  }
}

function openStatusMenu(anchor, taskId) {
  closeStatusMenu();
  const task = (state.cache.tasks || []).find(t => t.id === taskId);
  if (!task) return;

  const menu = document.createElement("div");
  menu.className = "menu";
  menu.id = "statusMenu";
  menu.innerHTML = `<div class="menu-label">Move to</div>` + M.STATUSES.map(s => `
    <button class="menu-item ${s === task.status ? "current" : ""}" data-status="${s}">
      <span class="sdot" style="background:${M.STATUS_COLORS[s]}"></span>
      ${M.STATUS_LABELS[s]}
      ${s === task.status ? `<span class="tick">${icon("check", 12)}</span>` : ""}
    </button>`).join("");
  document.body.appendChild(menu);

  // Keep it inside the popup: drop below the button, flip above when tight.
  const a = anchor.getBoundingClientRect();
  const top = a.bottom + 4 + menu.offsetHeight > window.innerHeight - 6
    ? Math.max(6, a.top - menu.offsetHeight - 4)
    : a.bottom + 4;
  menu.style.top = `${top}px`;
  menu.style.left = `${Math.max(6, a.right - menu.offsetWidth)}px`;

  menu.addEventListener("click", e => {
    const item = e.target.closest("[data-status]");
    if (!item) return;
    const status = item.dataset.status;
    closeStatusMenu();
    if (status !== task.status) changeStatus(taskId, status);
  });

  // Defer, so the click that opened the menu doesn't immediately close it.
  closeMenuListener = () => closeStatusMenu();
  setTimeout(() => document.addEventListener("click", closeMenuListener), 0);
}

async function submitNew() {
  const draft = state.draft;
  if (!draft.title.trim()) { toast("Give the task a title", true); $("dTitle")?.focus(); return; }

  setSaveState("Creating…");
  const now = Date.now();
  const task = {
    id: newTaskId(),
    title: draft.title.trim(),
    description: draft.description || "",
    status: draft.status || "todo",
    priority: draft.priority || "medium",
    assignee: draft.assignee || "",
    coAssignees: [],
    dueDate: draft.dueDate || "",
    location: "", locationLat: "", locationLng: "",
    labels: draft.labels || [],
    stakeholders: [],
    subtasks: [], comments: [], attachments: [],
    createdAt: now, updatedAt: now,
    createdBy: state.session.uid,
    ownerUid: state.session.uid,
    teamId: state.cache.activeTeamId,
  };

  try {
    const saved = await createTask(task);
    state.selfWrite++;
    state.cache = await addCachedTask(saved);
    toast("Task created");
    openDetail(saved.id);
    renderList();
  } catch (e) {
    setSaveState("Not created", "err");
    toast(e.message, true);
  }
}

async function removeTask(taskId) {
  try {
    await deleteTask(taskId);
    state.selfWrite++;
    state.cache = await removeCachedTask(taskId);
    toast("Task deleted");
    closeDetail();
  } catch (e) {
    toast(e.message, true);
  }
}

// ── Event wiring ──────────────────────────────────────────────
function wireEvents() {
  $("refreshBtn").addEventListener("click", () => refresh());

  $("themeBtn").addEventListener("click", async () => {
    const theme = state.prefs.theme === "dark" ? "light" : "dark";
    state.prefs = await setPrefs({ theme });
    applyTheme(theme);
  });

  $("signoutBtn").addEventListener("click", async () => {
    await signOut();
    await clearCache();
    chrome.runtime.sendMessage({ type: "tf:signed-out" }).catch(() => {});
    showSignedOut();
  });

  $("openAppBtn").addEventListener("click", () => {
    chrome.tabs.create({ url: CONFIG.appUrl });
  });

  $("newTaskBtn").addEventListener("click", openNew);

  $("teamSelect").addEventListener("change", async e => {
    setSync("Loading team…");
    try {
      state.selfWrite++;
      state.cache = await switchTeam(e.target.value);
      state.prefs = await getPrefs();
      renderList();
    } catch (err) {
      setSync(err.message, true);
    }
  });

  let searchTimer = null;
  $("searchInput").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderList, 120);
  });

  $("scopeTabs").addEventListener("click", async e => {
    const btn = e.target.closest("button[data-scope]");
    if (!btn) return;
    state.prefs = await setPrefs({ scope: btn.dataset.scope });
    renderList();
  });

  $("list").addEventListener("click", async e => {
    const stage = e.target.closest('[data-act="status-menu"]');
    if (stage) { e.stopPropagation(); openStatusMenu(stage, stage.dataset.id); return; }

    const check = e.target.closest('[data-act="toggle-done"]');
    if (check) { e.stopPropagation(); toggleDone(check.dataset.id); return; }

    const group = e.target.closest('[data-act="toggle-group"]');
    if (group) {
      const collapsed = { ...(state.prefs.collapsed || {}) };
      collapsed[group.dataset.status] = !collapsed[group.dataset.status];
      state.prefs = await setPrefs({ collapsed });
      renderList();
      return;
    }

    const row = e.target.closest('[data-act="open"]');
    if (row) openDetail(row.dataset.id);
  });

  $("list").addEventListener("scroll", closeStatusMenu, { passive: true });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && document.getElementById("statusMenu")) { closeStatusMenu(); return; }
    if (e.key === "Escape" && state.editing) { closeDetail(); return; }
    if (e.key === "/" && !state.editing && document.activeElement !== $("searchInput")) {
      e.preventDefault();
      $("searchInput").focus();
    }
  });

  // Another surface (the background sync) touched the cache.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.tf_cache) return;
    if (state.selfWrite > 0) { state.selfWrite--; return; }
    state.cache = changes.tf_cache.newValue;
    renderTeams();
    renderList();
    if (state.editing && state.editing !== "new") renderDetailIfIdle();
  });
}

function wireDetailFields(isNew) {
  // Text fields: keep the draft/cache in step, save shortly after typing stops.
  const bindText = (id, field) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("input", () => {
      if (isNew) { state.draft[field] = el.value; return; }
      clearTimeout(state.saveTimer);
      setSaveState("Saving…");
      state.saveTimer = setTimeout(() => save({ [field]: el.value }), 600);
    });
    el.addEventListener("blur", () => {
      if (isNew) return;
      clearTimeout(state.saveTimer);
      const t = currentTask();
      if (t && t[field] !== el.value) save({ [field]: el.value });
    });
  };
  bindText("dTitle", "title");
  bindText("dDesc", "description");

  const bindPick = (id, field) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("change", () => {
      if (isNew) { state.draft[field] = el.value; return; }
      save({ [field]: el.value });
    });
  };
  bindPick("dStatus", "status");
  bindPick("dPriority", "priority");
  bindPick("dAssignee", "assignee");
  bindPick("dDue", "dueDate");

  const enterTriggers = (inputId, action) => {
    const el = $(inputId);
    if (!el) return;
    el.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); $("detailPane").querySelector(`[data-act="${action}"]`)?.click(); }
    });
  };
  enterTriggers("labelInput", "add-label");
  enterTriggers("subInput", "add-sub");
  enterTriggers("commentInput", "add-comment");
}

// Delegated once onto the pane element itself — renderDetail() only swaps
// its innerHTML, so re-binding here would stack duplicate handlers.
function wirePane() {
  const pane = $("detailPane");
  pane.addEventListener("click", async e => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "back") { closeDetail(); return; }
    if (act === "open-app") { chrome.tabs.create({ url: CONFIG.appUrl }); return; }

    const isNew = state.editing === "new";
    const t = isNew ? state.draft : currentTask();
    if (!t) return;

    if (act === "create") { submitNew(); return; }

    if (act === "delete") {
      // Two-step delete — no confirm() dialogs inside a popup.
      if (btn.dataset.armed) { removeTask(state.editing); return; }
      btn.dataset.armed = "1";
      btn.textContent = "Tap again to delete";
      setTimeout(() => {
        if (!btn.isConnected) return;
        delete btn.dataset.armed;
        btn.innerHTML = `${icon("trash", 13)} Delete`;
      }, 3000);
      return;
    }

    if (act === "add-label") {
      const input = $("labelInput");
      const value = (input.value || "").trim();
      if (!value) return;
      const labels = [...(t.labels || [])];
      if (labels.includes(value)) { input.value = ""; return; }
      labels.push(value);
      input.value = "";
      if (isNew) { state.draft.labels = labels; renderDetail("labelInput"); }
      else { await save({ labels }); renderDetail("labelInput"); }
      return;
    }

    if (act === "rm-label") {
      const labels = (t.labels || []).filter(l => l !== btn.dataset.label);
      if (isNew) { state.draft.labels = labels; renderDetail(); }
      else { await save({ labels }); renderDetail(); }
      return;
    }

    if (act === "add-sub") {
      const input = $("subInput");
      const value = (input.value || "").trim();
      if (!value) return;
      const subtasks = [...(t.subtasks || []), { id: newTaskId(), title: value, done: false }];
      input.value = "";
      await save({ subtasks });
      renderDetail("subInput");
      return;
    }

    if (act === "toggle-sub") {
      const i = Number(btn.dataset.index);
      const subtasks = (t.subtasks || []).map((s, idx) => (idx === i ? { ...s, done: !s.done } : s));
      await save({ subtasks });
      renderDetail();
      return;
    }

    if (act === "rm-sub") {
      const i = Number(btn.dataset.index);
      const subtasks = (t.subtasks || []).filter((_, idx) => idx !== i);
      await save({ subtasks });
      renderDetail();
      return;
    }

    if (act === "add-comment") {
      const input = $("commentInput");
      const text = (input.value || "").trim();
      if (!text) return;
      const comments = [...(t.comments || []), {
        id: newTaskId(), userId: state.session.uid, text, createdAt: Date.now(),
      }];
      input.value = "";
      await save({ comments });
      renderDetail("commentInput");
      return;
    }
  });
}

// ── Toast ─────────────────────────────────────────────────────
let toastTimer = null;
function toast(message, isError) {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = message;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2600);
}
