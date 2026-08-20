/* ============================================================
   TASKFLOW EXTENSION — CACHE + SYNC
   The popup renders from chrome.storage.local instantly, then a
   background fetch refreshes it. The service worker uses the same
   cache to keep the toolbar badge honest.
   ============================================================ */
"use strict";

import { getSession } from "./auth.js";
import { fetchTasks, fetchMyTeams, fetchDirectory } from "./firestore.js";
import { personalTeamId, isPersonalTeam, needsAttention, isOverdue } from "./model.js";

const CACHE_KEY = "tf_cache";
const PREFS_KEY = "tf_prefs";

const EMPTY_CACHE = { teams: [], tasks: [], directory: {}, activeTeamId: null, syncedAt: 0 };
const DEFAULT_PREFS = { activeTeamId: null, scope: "mine", status: "", theme: "light" };

// ── Prefs ─────────────────────────────────────────────────────
export async function getPrefs() {
  const { [PREFS_KEY]: prefs } = await chrome.storage.local.get(PREFS_KEY);
  return { ...DEFAULT_PREFS, ...(prefs || {}) };
}

export async function setPrefs(patch) {
  const next = { ...(await getPrefs()), ...patch };
  await chrome.storage.local.set({ [PREFS_KEY]: next });
  return next;
}

// ── Cache ─────────────────────────────────────────────────────
export async function getCache() {
  const { [CACHE_KEY]: cache } = await chrome.storage.local.get(CACHE_KEY);
  return { ...EMPTY_CACHE, ...(cache || {}) };
}

async function putCache(patch) {
  const next = { ...(await getCache()), ...patch };
  await chrome.storage.local.set({ [CACHE_KEY]: next });
  return next;
}

export async function clearCache() {
  await chrome.storage.local.remove(CACHE_KEY);
}

/**
 * Which team the extension is looking at. Mirrors the web app: prefer the
 * team you last picked, otherwise your first team, otherwise Personal.
 */
function resolveActiveTeam(teams, preferred, uid) {
  if (preferred && (isPersonalTeam(preferred) || teams.some(t => t.id === preferred))) {
    return preferred;
  }
  return teams.length ? teams[0].id : personalTeamId(uid);
}

/** Full sync: teams + directory + the active team's tasks. */
export async function syncAll() {
  const session = await getSession();
  if (!session) throw new Error("SESSION_EXPIRED");

  const prefs = await getPrefs();
  const [teams, directory] = await Promise.all([
    fetchMyTeams(session.uid),
    fetchDirectory().catch(() => ({})),   // directory is nice-to-have, not fatal
  ]);

  const activeTeamId = resolveActiveTeam(teams, prefs.activeTeamId, session.uid);
  const tasks = await fetchTasks(activeTeamId);

  const cache = await putCache({ teams, directory, tasks, activeTeamId, syncedAt: Date.now() });
  if (activeTeamId !== prefs.activeTeamId) await setPrefs({ activeTeamId });
  await updateBadge(cache, session);
  return cache;
}

/** Cheap sync: just the active team's tasks. */
export async function syncTasks() {
  const session = await getSession();
  if (!session) throw new Error("SESSION_EXPIRED");
  const { activeTeamId } = await getCache();
  const teamId = activeTeamId || personalTeamId(session.uid);
  const tasks = await fetchTasks(teamId);
  const cache = await putCache({ tasks, activeTeamId: teamId, syncedAt: Date.now() });
  await updateBadge(cache, session);
  return cache;
}

/** Apply a change locally so the UI reacts before the write lands. */
export async function patchCachedTask(taskId, patch) {
  const cache = await getCache();
  const tasks = cache.tasks.map(t => (t.id === taskId ? { ...t, ...patch } : t));
  const next = await putCache({ tasks });
  await updateBadge(next);
  return next;
}

export async function addCachedTask(task) {
  const cache = await getCache();
  const next = await putCache({ tasks: [...cache.tasks.filter(t => t.id !== task.id), task] });
  await updateBadge(next);
  return next;
}

export async function removeCachedTask(taskId) {
  const cache = await getCache();
  const next = await putCache({ tasks: cache.tasks.filter(t => t.id !== taskId) });
  await updateBadge(next);
  return next;
}

export async function switchTeam(teamId) {
  await setPrefs({ activeTeamId: teamId });
  await putCache({ activeTeamId: teamId, tasks: [] });
  return syncTasks();
}

// ── Toolbar badge ─────────────────────────────────────────────
export async function updateBadge(cache, session) {
  try {
    session = session || (await getSession());
    if (!session) {
      await chrome.action.setBadgeText({ text: "" });
      return;
    }
    cache = cache || (await getCache());
    const due = cache.tasks.filter(t => needsAttention(t, session.uid));
    const late = due.some(t => isOverdue(t.dueDate));

    // The icon itself is accent-orange, so the badge uses the brand navy for the
    // resting state and a deeper red for late — both stay legible on top of it.
    await chrome.action.setBadgeText({ text: due.length ? String(due.length) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: late ? "#d61f1f" : "#0a0e27" });
    await chrome.action.setTitle({
      title: due.length
        ? `TaskFlow — ${due.length} task${due.length > 1 ? "s" : ""} due or overdue`
        : "TaskFlow",
    });
  } catch (e) {
    // Badge is cosmetic — never let it break a sync.
    console.warn("[TaskFlow] badge update failed:", e.message);
  }
}
