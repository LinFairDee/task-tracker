/* ============================================================
   TASKFLOW — FIRESTORE BACKEND (tasks + named teams + directory)
   Loaded AFTER app.js so it can override renderTeam()/showAddUser().
   Falls back gracefully to local-only mode if Firestore is unavailable.
   ============================================================ */
"use strict";

const FS = {
  db: null,
  myUid: null,
  activeTeamId: null,   // "user:<uid>" for personal, or a teams/{id}
  teams: [],            // named teams I'm a member of
  usersDir: {},         // uid -> { uid, name, email, picture }
  unsubTasks: null,
  unsubTeams: null,
  unsubDir: null,
  ready: false,
  teamsLoadedOnce: false, // so we only auto-pick the default team once per session
};

const ACTIVE_TEAM_KEY = "tf_activeTeam";

// ── Availability ──────────────────────────────────────────────
function fsReady() {
  return !!(FS.ready && FS.db);
}

function fsInitDb() {
  if (FS.db) return FS.db;
  if (typeof firebase === "undefined" || !firebase.firestore) {
    console.warn("[Firestore] SDK not loaded — staying in local-only mode");
    return null;
  }
  try {
    if (!firebase.apps.length && typeof firebaseConfig !== "undefined") {
      firebase.initializeApp(firebaseConfig);
    }
    FS.db = firebase.firestore();
    return FS.db;
  } catch (e) {
    console.error("[Firestore] init failed:", e);
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────
function fsPersonalTeamId(uid) { return "user:" + uid; }
function fsIsPersonal(teamId) { return !teamId || teamId.startsWith("user:"); }

// Turn a directory entry into the shape app.js expects in S.users
function fsToAppUser(uid) {
  const d = FS.usersDir[uid] || {};
  const name = d.name || d.email || "Member";
  return {
    id: uid,
    googleId: uid,
    name,
    email: d.email || "",
    picture: d.picture || "",
    color: AVATAR_COLORS[Math.abs(hashStr(d.email || uid)) % AVATAR_COLORS.length],
    role: d.role || "",
  };
}

function fsActiveTeam() {
  return FS.teams.find(t => t.id === FS.activeTeamId) || null;
}

// Recompute S.users from the active team's members (or just me when personal)
function fsSyncAppUsers() {
  const team = fsActiveTeam();
  const memberIds = team ? (team.memberIds || []) : [FS.myUid];
  // Always include myself
  const ids = Array.from(new Set([FS.myUid, ...memberIds]));
  S.users = ids.map(fsToAppUser);
  if (typeof populateUserFilters === "function") populateUserFilters();
  if (typeof updateSidebarUser === "function") updateSidebarUser();
}

// ── Bootstrap after login ─────────────────────────────────────
async function fsBootstrap(googleUser) {
  const db = fsInitDb();
  if (!db) return false;

  FS.myUid = (firebase.auth().currentUser && firebase.auth().currentUser.uid) || googleUser.sub;
  if (!FS.myUid) return false;

  // Identify the current user by Firebase uid everywhere
  S.currentUserId = FS.myUid;
  // Seed my own directory entry so the UI shows my name immediately
  FS.usersDir[FS.myUid] = {
    uid: FS.myUid,
    name: googleUser.name || "Google User",
    email: googleUser.email || "",
    picture: googleUser.picture || "",
  };
  fsSyncAppUsers();

  try {
    // 1) Upsert my profile into the shared directory
    await db.collection("users").doc(FS.myUid).set({
      uid: FS.myUid,
      name: googleUser.name || "Google User",
      email: googleUser.email || "",
      picture: googleUser.picture || "",
      lastLogin: Date.now(),
    }, { merge: true });

    // 2) Restore which team was active last
    let savedTeam = null;
    try { savedTeam = localStorage.getItem(ACTIVE_TEAM_KEY); } catch (e) {}
    FS.activeTeamId = savedTeam || fsPersonalTeamId(FS.myUid);

    // 3) Live directory of all users (for the Add Member picker)
    fsSubscribeDirectory();

    // 4) Live list of teams I belong to
    fsSubscribeMyTeams();

    // 5) Live tasks for the active team
    fsSubscribeTasks();

    FS.ready = true;
    console.log("[Firestore] ready as", FS.myUid, "team:", FS.activeTeamId);
    return true;
  } catch (e) {
    console.error("[Firestore] bootstrap failed:", e);
    showToast("Couldn't reach Firestore — is it enabled in the Firebase console?", "warning");
    return false;
  }
}

// ── Realtime subscriptions ────────────────────────────────────
function fsSubscribeDirectory() {
  if (FS.unsubDir) FS.unsubDir();
  FS.unsubDir = FS.db.collection("users").onSnapshot(snap => {
    FS.usersDir = {};
    snap.forEach(doc => { FS.usersDir[doc.id] = doc.data(); });
    fsSyncAppUsers();
    if (S.currentView === "team" && typeof renderTeam === "function") renderTeam();
  }, err => console.warn("[Firestore] directory listen error:", err.message));
}

function fsSubscribeMyTeams() {
  if (FS.unsubTeams) FS.unsubTeams();
  FS.unsubTeams = FS.db.collection("teams")
    .where("memberIds", "array-contains", FS.myUid)
    .onSnapshot(snap => {
      FS.teams = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      // On the first load, default to my team (one-team-per-user model) instead
      // of Personal, so the board shows immediately without switching.
      if (!FS.teamsLoadedOnce) {
        FS.teamsLoadedOnce = true;
        if (FS.teams.length > 0) {
          fsActivateTeam(FS.teams[0].id);
          return;
        }
      }

      // If the active named team disappeared, fall back to personal
      if (!fsIsPersonal(FS.activeTeamId) && !FS.teams.find(t => t.id === FS.activeTeamId)) {
        fsActivateTeam(fsPersonalTeamId(FS.myUid));
      } else {
        fsSyncAppUsers();
        fsRenderTeamSwitcher();
        if (S.currentView === "team" && typeof renderTeam === "function") renderTeam();
      }
    }, err => console.warn("[Firestore] teams listen error:", err.message));
}

function fsSubscribeTasks() {
  if (FS.unsubTasks) FS.unsubTasks();
  FS.unsubTasks = FS.db.collection("tasks")
    .where("teamId", "==", FS.activeTeamId)
    .onSnapshot(snap => {
      S.tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (typeof refreshCurrentView === "function") refreshCurrentView();
      if (typeof updateBadges === "function") updateBadges();
    }, err => {
      console.warn("[Firestore] tasks listen error:", err.message);
      showToast("Task sync error: " + err.message, "error");
    });
}

// ── Task writes (called from app.js CRUD) ─────────────────────
function fsSyncTask(task) {
  if (!fsReady() || !task) return;
  const clean = JSON.parse(JSON.stringify(task)); // drop undefined / functions
  clean.teamId = FS.activeTeamId;
  if (!clean.ownerUid) clean.ownerUid = FS.myUid;
  FS.db.collection("tasks").doc(task.id).set(clean, { merge: true })
    .catch(e => { console.error("[Firestore] task save failed:", e); showToast("Save failed: " + e.message, "error"); });
}

function fsDeleteTask(taskId) {
  if (!fsReady() || !taskId) return;
  FS.db.collection("tasks").doc(taskId).delete()
    .catch(e => console.error("[Firestore] task delete failed:", e));
}

// ── Team management ───────────────────────────────────────────
// Populate the global team switcher in the topbar (visible on every page).
function fsRenderTeamSwitcher() {
  const sel = document.getElementById("globalTeamSwitcher");
  if (!sel) return;
  if (!fsReady()) { sel.classList.add("hidden"); return; }
  sel.classList.remove("hidden");
  sel.innerHTML = [
    `<option value="${fsPersonalTeamId(FS.myUid)}" ${fsIsPersonal(FS.activeTeamId) ? "selected" : ""}>Personal (just me)</option>`,
    ...FS.teams.map(t => `<option value="${t.id}" ${t.id === FS.activeTeamId ? "selected" : ""}>${esc(t.name)}</option>`),
  ].join("");
}

async function fsActivateTeam(teamId) {
  FS.activeTeamId = teamId;
  try { localStorage.setItem(ACTIVE_TEAM_KEY, teamId); } catch (e) {}
  fsSyncAppUsers();
  fsSubscribeTasks();                 // re-scope tasks to the new team
  fsRenderTeamSwitcher();
  if (typeof renderTeam === "function") renderTeam();
  if (typeof refreshCurrentView === "function") refreshCurrentView();
}

// How many teams a given user already belongs to (one-team-per-user enforcement)
async function fsCountUserTeams(uid) {
  const snap = await FS.db.collection("teams")
    .where("memberIds", "array-contains", uid).get();
  return snap.size;
}

async function fsCreateTeam(name) {
  if (!fsReady()) { showToast("Firestore not ready", "warning"); return; }
  name = (name || "").trim();
  if (!name) return;
  // One team per user: if I'm already in a team, block.
  if (FS.teams.length > 0) {
    showToast("You're already in a team. Leave or delete it before creating another.", "warning");
    return;
  }
  try {
    const ref = await FS.db.collection("teams").add({
      name,
      ownerId: FS.myUid,
      memberIds: [FS.myUid],
      createdAt: Date.now(),
    });
    showToast(`Team "${name}" created`, "success");
    await fsActivateTeam(ref.id);
  } catch (e) {
    console.error("[Firestore] create team failed:", e);
    showToast("Create team failed: " + e.message, "error");
  }
}

async function fsAddMember(uid) {
  if (!fsReady()) return;
  const team = fsActiveTeam();
  if (!team) { showToast("Create a team first", "warning"); return; }
  if ((team.memberIds || []).includes(uid)) { showToast("Already in this team", "info"); return; }
  try {
    // One team per user: don't add someone who already belongs to a team.
    const existing = await fsCountUserTeams(uid);
    if (existing > 0) {
      showToast("That user is already in another team.", "warning");
      return;
    }
    await FS.db.collection("teams").doc(team.id).update({
      memberIds: firebase.firestore.FieldValue.arrayUnion(uid),
    });
    showToast("Member added", "success");
  } catch (e) {
    console.error("[Firestore] add member failed:", e);
    showToast("Add member failed: " + e.message, "error");
  }
}

async function fsRemoveMember(uid) {
  if (!fsReady()) return;
  const team = fsActiveTeam();
  if (!team) return;
  if (uid === team.ownerId) { showToast("Can't remove the team owner", "warning"); return; }
  try {
    await FS.db.collection("teams").doc(team.id).update({
      memberIds: firebase.firestore.FieldValue.arrayRemove(uid),
    });
    showToast("Member removed", "info");
  } catch (e) {
    console.error("[Firestore] remove member failed:", e);
    showToast("Remove member failed: " + e.message, "error");
  }
}

async function fsDeleteTeam() {
  if (!fsReady()) return;
  const team = fsActiveTeam();
  if (!team) { showToast("No team selected", "warning"); return; }
  if (team.ownerId !== FS.myUid) { showToast("Only the owner can delete the team", "warning"); return; }
  if (!confirm(`Delete team "${team.name}"? This can't be undone.`)) return;
  try {
    await FS.db.collection("teams").doc(team.id).delete();
    showToast(`Team "${team.name}" deleted`, "success");
    await fsActivateTeam(fsPersonalTeamId(FS.myUid)); // fall back to Personal
  } catch (e) {
    console.error("[Firestore] delete team failed:", e);
    showToast("Delete team failed: " + e.message, "error");
  }
}

// ── Team view UI (overrides app.js renderTeam + showAddUser) ──
function renderTeam() {
  const container = document.getElementById("teamHierarchy");
  if (!container) return;

  if (!fsReady()) {
    container.innerHTML = `<p style="color:var(--text-3);text-align:center;padding:40px">
      Connecting to Firestore… if this persists, enable Firestore in the Firebase console.</p>`;
    return;
  }

  const team = fsActiveTeam();
  const memberIds = team ? (team.memberIds || []) : [FS.myUid];

  // Team switcher options: personal + my named teams
  const switcher = `
    <div class="team-toolbar" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:18px">
      <label style="color:var(--text-2);font-size:13px">Team</label>
      <select class="filter-select" onchange="fsActivateTeam(this.value)">
        <option value="${fsPersonalTeamId(FS.myUid)}" ${fsIsPersonal(FS.activeTeamId) ? "selected" : ""}>Personal (just me)</option>
        ${FS.teams.map(t => `<option value="${t.id}" ${t.id === FS.activeTeamId ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
      </select>
      <button class="btn btn-sm btn-outline" onclick="promptCreateTeam()"><i data-lucide="plus"></i> New Team</button>
      ${team ? `<button class="btn btn-sm btn-primary" onclick="openAddMemberModal()"><i data-lucide="user-plus"></i> Add Member</button>` : ""}
      ${team && team.ownerId === FS.myUid ? `<button class="btn btn-sm btn-outline" onclick="fsDeleteTeam()"><i data-lucide="trash-2"></i> Delete Team</button>` : ""}
      <span style="margin-left:auto;color:var(--text-3);font-size:12px">${memberIds.length} member${memberIds.length !== 1 ? "s" : ""}</span>
    </div>`;

  const cards = memberIds.map(uid => {
    const u = fsToAppUser(uid);
    const assigned = S.tasks.filter(t => t.assignee === uid).length;
    const done = S.tasks.filter(t => t.assignee === uid && t.status === "done").length;
    const isMe = uid === FS.myUid;
    const isOwner = team && uid === team.ownerId;
    return `
      <div class="team-node-card" style="display:flex;align-items:center;gap:14px;padding:14px;margin-bottom:10px">
        ${u.picture
          ? `<img src="${u.picture}" class="avatar" style="object-fit:cover" />`
          : `<div class="avatar" style="background:${u.color}">${initials(u.name)}</div>`}
        <div style="flex:1">
          <div style="font-weight:600">${esc(u.name)}
            ${isMe ? '<span class="you-badge">YOU</span>' : ""}
            ${isOwner ? '<span class="reports-badge">Owner</span>' : ""}</div>
          <div style="color:var(--text-3);font-size:12px">${esc(u.email || "")}</div>
        </div>
        <div class="team-node-stats" style="display:flex;gap:8px">
          <div class="team-stat-pill"><strong>${assigned}</strong> tasks</div>
          <div class="team-stat-pill done-pill"><strong>${done}</strong> done</div>
        </div>
        ${team && !isOwner ? `<button class="btn btn-sm btn-outline" onclick="fsRemoveMember('${uid}')"><i data-lucide="user-minus"></i></button>` : ""}
      </div>`;
  }).join("");

  container.innerHTML = switcher + (cards || `<p style="color:var(--text-3);text-align:center;padding:30px">No members yet</p>`);
  if (window.lucide) lucide.createIcons();
}

function promptCreateTeam() {
  let modal = document.getElementById("fsCreateTeamModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "fsCreateTeamModal";
    modal.className = "modal-overlay hidden";
    modal.innerHTML = `
      <div class="modal" style="max-width:420px" onclick="event.stopPropagation()">
        <div class="modal-header">
          <h3>Create a team</h3>
          <button class="icon-btn" onclick="closeModal('fsCreateTeamModal')"><i data-lucide="x"></i></button>
        </div>
        <div class="modal-body">
          <label class="form-label">Team name</label>
          <input id="fsTeamNameInput" class="form-input" style="width:100%" placeholder="e.g. Engineering"
                 onkeydown="if(event.key==='Enter')submitCreateTeam()" />
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
            <button class="btn btn-outline" onclick="closeModal('fsCreateTeamModal')">Cancel</button>
            <button class="btn btn-primary" onclick="submitCreateTeam()">Create Team</button>
          </div>
        </div>
      </div>`;
    modal.addEventListener("click", () => closeModal("fsCreateTeamModal"));
    document.body.appendChild(modal);
  }
  modal.classList.remove("hidden");
  const input = document.getElementById("fsTeamNameInput");
  if (input) { input.value = ""; setTimeout(() => input.focus(), 50); }
  if (window.lucide) lucide.createIcons();
}

function submitCreateTeam() {
  const input = document.getElementById("fsTeamNameInput");
  const name = (input && input.value || "").trim();
  if (!name) { showToast("Enter a team name", "warning"); return; }
  closeModal("fsCreateTeamModal");
  fsCreateTeam(name);
}

// Override: the Team view "Add Member" button opens the directory picker
function showAddUser() {
  document.getElementById("userMenuDropdown")?.classList.add("hidden");
  if (fsReady()) { openAddMemberModal(); return; }
  // Fallback to the old local create-user flow
  document.getElementById("loginScreen").classList.remove("hidden");
  document.getElementById("appContainer").classList.add("hidden");
  if (typeof showCreateUser === "function") showCreateUser();
}

// ── Add Member modal (lists everyone in the Firestore directory) ──
function openAddMemberModal() {
  const team = fsActiveTeam();
  if (!team) { showToast("Create a team first, then add members", "warning"); promptCreateTeam(); return; }

  let modal = document.getElementById("fsAddMemberModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "fsAddMemberModal";
    modal.className = "modal-overlay hidden";
    modal.innerHTML = `
      <div class="modal" style="max-width:460px" onclick="event.stopPropagation()">
        <div class="modal-header">
          <h3>Add team member</h3>
          <button class="icon-btn" onclick="closeModal('fsAddMemberModal')"><i data-lucide="x"></i></button>
        </div>
        <div class="modal-body">
          <input id="fsMemberSearch" class="filter-select" style="width:100%;margin-bottom:12px" placeholder="Search people…" oninput="renderMemberPicker()" />
          <div id="fsMemberList" style="max-height:340px;overflow:auto"></div>
        </div>
      </div>`;
    modal.addEventListener("click", () => closeModal("fsAddMemberModal"));
    document.body.appendChild(modal);
  }
  modal.classList.remove("hidden");
  const search = document.getElementById("fsMemberSearch");
  if (search) search.value = "";
  renderMemberPicker();
  if (window.lucide) lucide.createIcons();
}

function renderMemberPicker() {
  const list = document.getElementById("fsMemberList");
  if (!list) return;
  const team = fsActiveTeam();
  const members = new Set(team ? (team.memberIds || []) : []);
  const q = (document.getElementById("fsMemberSearch")?.value || "").toLowerCase();

  const people = Object.values(FS.usersDir).filter(u => {
    const hay = ((u.name || "") + " " + (u.email || "")).toLowerCase();
    return hay.includes(q);
  });

  if (!people.length) {
    list.innerHTML = `<p style="color:var(--text-3);text-align:center;padding:20px">
      No one to add yet. Teammates appear here after they sign in once.</p>`;
    return;
  }

  list.innerHTML = people.map(u => {
    const already = members.has(u.uid);
    const av = u.picture
      ? `<img src="${u.picture}" class="avatar avatar-sm" style="object-fit:cover" />`
      : `<div class="avatar avatar-sm" style="background:${AVATAR_COLORS[Math.abs(hashStr(u.email || u.uid)) % AVATAR_COLORS.length]}">${initials(u.name || u.email || "?")}</div>`;
    return `
      <div style="display:flex;align-items:center;gap:12px;padding:8px 4px">
        ${av}
        <div style="flex:1">
          <div style="font-weight:500">${esc(u.name || u.email || "Member")}</div>
          <div style="color:var(--text-3);font-size:12px">${esc(u.email || "")}</div>
        </div>
        ${already
          ? `<span style="color:var(--success);font-size:12px">✓ In team</span>`
          : `<button class="btn btn-sm btn-primary" onclick="fsAddMember('${u.uid}')">Add</button>`}
      </div>`;
  }).join("");
  if (window.lucide) lucide.createIcons();
}
