const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Set with:  firebase functions:secrets:set CHAT_WEBHOOK_URL
const CHAT_WEBHOOK_URL = defineSecret("CHAT_WEBHOOK_URL");

// Active statuses only (exclude "done")
const ACTIVE = ["todo", "inprogress", "review"];

// Count colours (rendered via <font color> inline markup — Cards v2)
const COUNT_COLOR = { todo: "#9aa0a6", inprogress: "#7cb0ff", review: "#cd9cf0" };
const SEP = '<font color="#5f6368"> · </font>';

// Priority → dot colour + display order (higher = more urgent)
const PRIORITY_COLOR = { urgent: "#ef4444", high: "#f97316", medium: "#f59e0b", low: "#22c55e" };
const PRIORITY_ORDER = { urgent: 4, high: 3, medium: 2, low: 1 };
const PRIORITY_LABEL = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };

// Today's date as YYYY-MM-DD in Asia/Bangkok (matches the app's dueDate strings)
function bangkokDateKey(d) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Bangkok",
  }).format(d);
}

// A count segment, coloured; the value is bold when non-zero so the load pops
function countSeg(value, label, color) {
  const inner = value > 0 ? `<b>${value} ${label}</b>` : `${value} ${label}`;
  return `<font color="${color}">${inner}</font>`;
}

// ── Core: build the Cards v2 payload from Firestore ───────────
async function buildWorkloadPayload() {
  const now = new Date();
  const todayKey = bangkokDateKey(now);

  // Load all members (users collection: doc id = uid)
  const usersSnap = await db.collection("users").get();
  const names = {};
  usersSnap.forEach((d) => {
    const u = d.data() || {};
    names[d.id] = u.name || u.email || "Member";
  });

  // Single pass over tasks: per-assignee active tally + due-today list
  const tasksSnap = await db.collection("tasks").get();
  const tally = {};
  const dueToday = [];
  tasksSnap.forEach((d) => {
    const t = d.data() || {};
    if (!ACTIVE.includes(t.status)) return;
    const uid = t.assignee;
    if (uid) {
      if (!tally[uid]) tally[uid] = { todo: 0, inprogress: 0, review: 0 };
      tally[uid][t.status] += 1;
    }
    if (t.dueDate && t.dueDate.slice(0, 10) === todayKey) {
      dueToday.push({
        title: t.title || "Untitled task",
        assignee: names[uid] || "Unassigned",
        priority: PRIORITY_LABEL[t.priority] ? t.priority : "medium",
      });
    }
  });

  const rows = Object.keys(tally)
    .map((uid) => {
      const c = tally[uid];
      return {
        name: names[uid] || "Unknown member",
        todo: c.todo,
        inprogress: c.inprogress,
        review: c.review,
        total: c.todo + c.inprogress + c.review,
      };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);

  dueToday.sort((a, b) => (PRIORITY_ORDER[b.priority] || 0) - (PRIORITY_ORDER[a.priority] || 0));

  const totalActive = rows.reduce((s, r) => s + r.total, 0);

  const prettyDate = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Asia/Bangkok",
  }).format(now);

  const duePart = dueToday.length ? `${dueToday.length} due today` : "nothing due today";
  const subtitle = `${prettyDate} · ${totalActive} active · ${duePart}`;

  const sections = [];

  // ── Team section ──
  // Per member: a decoratedText (avatar icon + name + "N active" label) followed
  // by a textParagraph carrying the colour-coded counts (colours only render in
  // free-text markup fields, not in decoratedText labels).
  if (rows.length) {
    const widgets = [];
    rows.forEach((r) => {
      widgets.push({
        decoratedText: {
          startIcon: { knownIcon: "PERSON" },
          topLabel: `${r.total} active`,
          text: `<b>${escapeHtml(r.name)}</b>`,
          wrapText: true,
        },
      });
      widgets.push({
        textParagraph: {
          text:
            countSeg(r.todo, "To Do", COUNT_COLOR.todo) +
            SEP +
            countSeg(r.inprogress, "In Progress", COUNT_COLOR.inprogress) +
            SEP +
            countSeg(r.review, "Review", COUNT_COLOR.review),
        },
      });
    });
    sections.push({ header: "Team", widgets });
  } else {
    sections.push({
      header: "Team",
      widgets: [{ textParagraph: { text: "No active tasks — everyone's clear." } }],
    });
  }

  // ── Due today section ──
  const dueWidgets = dueToday.length
    ? dueToday.slice(0, 10).map((t) => ({
        decoratedText: {
          text:
            `<font color="${PRIORITY_COLOR[t.priority] || "#9aa0a6"}">●</font> ` +
            escapeHtml(t.title),
          bottomLabel: `${t.assignee} · ${PRIORITY_LABEL[t.priority] || "Medium"}`,
          wrapText: true,
        },
      }))
    : [{ textParagraph: { text: '<font color="#9aa0a6">Nothing due today.</font>' } }];
  if (dueToday.length > 10) {
    dueWidgets.push({
      textParagraph: { text: `<font color="#9aa0a6">+${dueToday.length - 10} more due today</font>` },
    });
  }
  sections.push({
    header: `Due today${dueToday.length ? " · " + dueToday.length : ""}`,
    widgets: dueWidgets,
  });

  return {
    cardsV2: [
      {
        cardId: "daily-workload",
        card: {
          header: { title: "Daily Workload", subtitle },
          sections,
        },
      },
    ],
  };
}

// Minimal HTML escape for text placed inside Cards v2 markup fields
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function postToChat(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Chat webhook failed: ${res.status} ${body}`);
  }
}

// ── Scheduled: every day at 09:00 Asia/Bangkok ────────────────
exports.dailyWorkloadReport = onSchedule(
  {
    schedule: "0 9 * * *",
    timeZone: "Asia/Bangkok",
    region: "asia-southeast1",
    secrets: [CHAT_WEBHOOK_URL],
  },
  async () => {
    const payload = await buildWorkloadPayload();
    await postToChat(CHAT_WEBHOOK_URL.value(), payload);
    logger.info("Daily workload report sent to Google Chat");
  }
);

// ── Manual trigger for testing:  open the function URL in a browser ──
exports.sendWorkloadNow = onRequest(
  { region: "asia-southeast1", secrets: [CHAT_WEBHOOK_URL] },
  async (req, res) => {
    try {
      const payload = await buildWorkloadPayload();
      await postToChat(CHAT_WEBHOOK_URL.value(), payload);
      res.status(200).send("Sent ✅\n\n" + JSON.stringify(payload, null, 2));
    } catch (e) {
      logger.error(e);
      res.status(500).send("Error: " + e.message);
    }
  }
);
