/* ============================================================
   TASKFLOW EXTENSION — SERVICE WORKER
   Keeps the toolbar badge current and refreshes the task cache in
   the background so the popup opens with something to show.
   ============================================================ */
"use strict";

import { getSession } from "./lib/auth.js";
import { syncAll, syncTasks, updateBadge, clearCache } from "./lib/store.js";

const SYNC_ALARM = "tf-sync";
const SYNC_PERIOD_MINUTES = 10;

async function ensureAlarm() {
  const existing = await chrome.alarms.get(SYNC_ALARM);
  if (!existing) {
    await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES, delayInMinutes: 1 });
  }
}

async function backgroundSync(full = false) {
  const session = await getSession();
  if (!session) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  try {
    await (full ? syncAll() : syncTasks());
  } catch (e) {
    if (e.message === "SESSION_EXPIRED") {
      await clearCache();
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setTitle({ title: "TaskFlow — sign in again" });
    } else {
      console.warn("[TaskFlow] background sync failed:", e.message);
    }
  }
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); backgroundSync(true); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); backgroundSync(true); });

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === SYNC_ALARM) backgroundSync();
});

// The popup and the sign-in tab talk to the worker through these.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "tf:signed-in") {
    backgroundSync(true).then(() => sendResponse({ ok: true }));
    return true;   // async response
  }
  if (msg?.type === "tf:signed-out") {
    clearCache()
      .then(() => chrome.action.setBadgeText({ text: "" }))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "tf:refresh-badge") {
    updateBadge().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
