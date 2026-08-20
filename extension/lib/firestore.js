/* ============================================================
   TASKFLOW EXTENSION — FIRESTORE REST CLIENT
   Talks to the same taskflow database the web app uses, over the
   v1 REST API with a Firebase ID token, so firestore.rules still apply.
   ============================================================ */
"use strict";

import { CONFIG } from "../config.js";
import { getIdToken } from "./auth.js";

const BASE =
  `https://firestore.googleapis.com/v1/projects/${CONFIG.firebase.projectId}` +
  `/databases/(default)/documents`;

// ── Value codec (JS ⇄ Firestore protobuf-ish JSON) ────────────
export function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string")  return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === "object") return { mapValue: { fields: encodeFields(v) } };
  return { stringValue: String(v) };
}

export function encodeFields(obj) {
  const fields = {};
  Object.entries(obj).forEach(([k, v]) => {
    if (v === undefined) return;      // mirror the web app dropping undefined
    fields[k] = encodeValue(v);
  });
  return fields;
}

export function decodeValue(v) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue"    in v) return v.stringValue;
  if ("integerValue"   in v) return Number(v.integerValue);
  if ("doubleValue"    in v) return Number(v.doubleValue);
  if ("booleanValue"   in v) return v.booleanValue;
  if ("nullValue"      in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("referenceValue" in v) return v.referenceValue;
  if ("arrayValue"     in v) return (v.arrayValue.values || []).map(decodeValue);
  if ("mapValue"       in v) return decodeFields(v.mapValue.fields || {});
  return null;
}

export function decodeFields(fields) {
  const out = {};
  Object.entries(fields || {}).forEach(([k, v]) => { out[k] = decodeValue(v); });
  return out;
}

function docToObj(doc) {
  return { id: doc.name.split("/").pop(), ...decodeFields(doc.fields) };
}

// ── Authenticated request with one retry on a stale token ─────
async function req(path, { method = "GET", body, retried = false } = {}) {
  const token = await getIdToken({ force: retried });
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !retried) {
    return req(path, { method, body, retried: true });
  }
  if (!res.ok) {
    // :runQuery reports failures as [{error:{…}}]; everything else as {error:{…}}.
    const body = await res.json().catch(() => null);
    const err = Array.isArray(body) ? body.find(r => r?.error) : body;
    throw new Error(err?.error?.message || `Firestore ${res.status}`);
  }
  // DELETE returns an empty body
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function runQuery(structuredQuery) {
  const rows = await req(":runQuery", { method: "POST", body: { structuredQuery } });
  // The first row can be a readTime-only marker with no document.
  return (rows || []).filter(r => r.document).map(r => docToObj(r.document));
}

const eq = (fieldPath, value) => ({
  fieldFilter: { field: { fieldPath }, op: "EQUAL", value: encodeValue(value) },
});
const arrayContains = (fieldPath, value) => ({
  fieldFilter: { field: { fieldPath }, op: "ARRAY_CONTAINS", value: encodeValue(value) },
});

// ── Reads ─────────────────────────────────────────────────────
export function fetchTasks(teamId) {
  return runQuery({ from: [{ collectionId: "tasks" }], where: eq("teamId", teamId) });
}

export function fetchMyTeams(uid) {
  return runQuery({ from: [{ collectionId: "teams" }], where: arrayContains("memberIds", uid) });
}

export async function fetchDirectory() {
  // Small shared directory (everyone who has ever signed in) — one page is plenty.
  const data = await req("/users?pageSize=500");
  const dir = {};
  (data.documents || []).forEach(d => { const u = docToObj(d); dir[u.id] = u; });
  return dir;
}

// ── Writes ────────────────────────────────────────────────────
/** Patch only the given fields, leaving everything else on the doc alone. */
export async function updateTask(taskId, patch) {
  const fields = { ...patch, updatedAt: Date.now() };
  const mask = Object.keys(fields).map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");
  const doc = await req(`/tasks/${encodeURIComponent(taskId)}?${mask}`, {
    method: "PATCH",
    body: { fields: encodeFields(fields) },
  });
  return docToObj(doc);
}

/** Create a task with the same id scheme the web app's uid() uses. */
export async function createTask(task) {
  const id = task.id || newTaskId();
  const now = Date.now();
  const full = { createdAt: now, updatedAt: now, ...task, id };
  const doc = await req(`/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { fields: encodeFields(full) },
  });
  return docToObj(doc);
}

export function deleteTask(taskId) {
  return req(`/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
}

export function newTaskId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
