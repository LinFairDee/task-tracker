/* ============================================================
   TASKFLOW EXTENSION — SHARED CONSTANTS & HELPERS
   Mirrors public/app.js so the extension speaks the same
   vocabulary as the web app (statuses, colours, date wording).
   ============================================================ */
"use strict";

export const STATUSES = ["todo", "inprogress", "review", "done"];
export const STATUS_LABELS = { todo: "To Do", inprogress: "In Progress", review: "Review", done: "Done" };
export const STATUS_COLORS = { todo: "#94a3b8", inprogress: "#3b82f6", review: "#a855f7", done: "#22c55e" };

export const PRIORITIES = ["low", "medium", "high", "urgent"];
export const PRIORITY_LABELS = { low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };
export const PRIORITY_COLORS = { urgent: "#ef4444", high: "#f97316", medium: "#f59e0b", low: "#22c55e" };
export const PRIORITY_ORDER = { urgent: 4, high: 3, medium: 2, low: 1 };

export const AVATAR_COLORS = [
  "#6c63ff", "#a855f7", "#ec4899", "#ef4444", "#f97316",
  "#f59e0b", "#22c55e", "#14b8a6", "#3b82f6", "#06b6d4",
];

const LABEL_COLORS = {
  "Bug": "#ef4444", "Feature": "#a855f7", "Design": "#3b82f6", "Backend": "#f97316",
  "Frontend": "#14b8a6", "Urgent": "#ef4444", "Research": "#6366f1", "Testing": "#22c55e",
  "Docs": "#f59e0b", "DevOps": "#ec4899",
};
const LABEL_PALETTE = ["#ef4444", "#a855f7", "#3b82f6", "#f97316", "#14b8a6", "#6366f1", "#22c55e", "#f59e0b", "#ec4899", "#06b6d4"];

export function getLabelColor(label) {
  if (LABEL_COLORS[label]) return LABEL_COLORS[label];
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = label.charCodeAt(i) + ((hash << 5) - hash);
  return LABEL_PALETTE[Math.abs(hash) % LABEL_PALETTE.length];
}

export function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}

export function avatarColor(seed) {
  return AVATAR_COLORS[Math.abs(hashStr(seed || "?")) % AVATAR_COLORS.length];
}

export function initials(name) {
  if (!name) return "?";
  return name.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
}

export function esc(str) {
  if (str === 0) return "0";
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── Dates ─────────────────────────────────────────────────────
export function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const diff = Math.round((d - now) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff < 0) return `${Math.abs(diff)}d overdue`;
  if (diff < 7) return `in ${diff}d`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function isOverdue(dateStr) {
  if (!dateStr) return false;
  return new Date(dateStr + "T23:59:59") < new Date();
}

export function isDueToday(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr + "T00:00:00");
  const now = new Date();
  return d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate();
}

export function timeAgo(ts) {
  if (!ts) return "never";
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Teams ─────────────────────────────────────────────────────
export function personalTeamId(uid) { return "user:" + uid; }
export function isPersonalTeam(teamId) { return !teamId || teamId.startsWith("user:"); }

// ── Task predicates ───────────────────────────────────────────
export function isMine(task, uid) {
  return task.assignee === uid || (task.coAssignees || []).includes(uid);
}

/** Open tasks assigned to me that are due today or already late. */
export function needsAttention(task, uid) {
  if (task.status === "done") return false;
  if (!isMine(task, uid)) return false;
  return isOverdue(task.dueDate) || isDueToday(task.dueDate);
}

export function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] || 0;
    const pb = PRIORITY_ORDER[b.priority] || 0;
    if (pa !== pb) return pb - pa;
    // Dated work first, soonest at the top
    if (!!a.dueDate !== !!b.dueDate) return a.dueDate ? -1 : 1;
    if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}
