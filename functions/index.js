const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const crypto = require("crypto");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Set with:  firebase functions:secrets:set CHAT_WEBHOOK_URL
const CHAT_WEBHOOK_URL = defineSecret("CHAT_WEBHOOK_URL");

// Which team public tickets land in. Leave unset when there is exactly one
// team — the function resolves it automatically.
const TICKET_TEAM_ID = defineString("TICKET_TEAM_ID", { default: "" });

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


/* ============================================================
   PUBLIC TICKET INTAKE  —  POST /api/ticket
   Backs public/submit.html. Anyone with the link can file a ticket, so this
   runs with no caller identity: it validates hard, rate-limits per IP, stores
   attachments itself, and writes the task with the Admin SDK (firestore.rules
   still blocks anonymous clients from touching /tasks directly).
   ============================================================ */

// Every error reply carries a stable `code` as well as English text, so the
// bilingual form can show the message in whichever language the visitor chose.
const TICKET_LIMITS = {
  titleMax: 140,
  descriptionMax: 5000,
  emailMax: 160,
  files: 5,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  perIpPerHour: 6,
};

// Request type → the label the task carries on the board.
const TICKET_CATEGORIES = {
  bug: "Bug",
  feature: "Feature",
  access: "Access",
  data: "Data",
  other: "Support",
};

const TICKET_PRIORITIES = ["low", "medium", "high", "urgent"];

const ALLOWED_UPLOAD_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
};

// Same id scheme as the web app's uid(), so tickets look native on the board.
function taskId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function cleanText(value, max) {
  return String(value == null ? "" : value).replace(/\s+$/g, "").trim().slice(0, max);
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

/** Hashed so we rate-limit by IP without storing anyone's address. */
function clientKey(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = fwd || req.ip || req.socket?.remoteAddress || "unknown";
  return crypto.createHash("sha256").update("tf-ticket:" + ip).digest("hex").slice(0, 32);
}

/** Fixed-window counter in Firestore; returns false once the window is full. */
async function withinRateLimit(key) {
  const hour = Math.floor(Date.now() / 3600000);
  const ref = db.collection("ticketLimits").doc(`${key}_${hour}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const count = snap.exists ? snap.data().count || 0 : 0;
    if (count >= TICKET_LIMITS.perIpPerHour) return false;
    tx.set(ref, {
      count: count + 1,
      hour,
      // Cheap TTL marker; set a Firestore TTL policy on this field to auto-clean.
      expiresAt: admin.firestore.Timestamp.fromMillis((hour + 2) * 3600000),
    });
    return true;
  });
}

/** The team tickets belong to: the configured one, else the only one there is. */
async function loadTicketTeam() {
  const configured = TICKET_TEAM_ID.value();
  const snap = await db.collection("teams").get();
  const doc = configured ? snap.docs.find((d) => d.id === configured)
            : snap.size === 1 ? snap.docs[0] : null;
  if (!doc) {
    if (snap.size === 0) throw new Error("No team exists to file the ticket against");
    throw new Error("Several teams exist — set the TICKET_TEAM_ID parameter");
  }
  return { id: doc.id, memberIds: (doc.data() || {}).memberIds || [] };
}

/**
 * Who a ticket may be addressed to. Names only — this is served to an
 * unauthenticated page, so it must not hand out the team's email addresses.
 */
async function listTicketAssignees(team) {
  const usersSnap = await db.collection("users").get();
  const byId = {};
  usersSnap.forEach((d) => { byId[d.id] = d.data() || {}; });
  return team.memberIds
    .filter((uid) => byId[uid])
    .map((uid) => ({ id: uid, name: byId[uid].name || "Member" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Decode one client attachment and put it in Storage. Access is via an
 * unguessable download token in the URL, so storage.rules can stay closed.
 */
async function storeAttachment(bucket, ticketId, index, file) {
  const ext = ALLOWED_UPLOAD_TYPES[file.type];
  if (!ext) throw new Error(`Unsupported file type: ${file.type}`);

  const base64 = String(file.data || "").split(",").pop();
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) throw new Error("Empty attachment");
  if (buffer.length > TICKET_LIMITS.fileBytes) throw new Error("Attachment is too large");

  const safeName = cleanText(file.name, 80).replace(/[^\w.\- ]+/g, "_") || `attachment.${ext}`;
  const token = crypto.randomUUID();
  const path = `tickets/${ticketId}/${index}-${safeName}`;

  await bucket.file(path).save(buffer, {
    resumable: false,
    metadata: {
      contentType: file.type,
      cacheControl: "private, max-age=31536000",
      metadata: { firebaseStorageDownloadTokens: token },
    },
  });

  return {
    name: safeName,
    url:
      `https://firebasestorage.googleapis.com/v0/b/${bucket.name}` +
      `/o/${encodeURIComponent(path)}?alt=media&token=${token}`,
    size: buffer.length,
    contentType: file.type,
  };
}

function ticketChatPayload(task, requesterEmail, ticketId) {
  const attachments = task.attachments.length
    ? `${SEP}<font color="#9aa0a6">${task.attachments.length} attachment(s)</font>`
    : "";
  return {
    cardsV2: [
      {
        cardId: "new-ticket-" + ticketId,
        card: {
          header: { title: "New ticket", subtitle: escapeHtml(requesterEmail) },
          sections: [
            {
              widgets: [
                { textParagraph: { text: `<b>${escapeHtml(task.title)}</b>` } },
                {
                  textParagraph: {
                    text:
                      `<font color="${PRIORITY_COLOR[task.priority]}">` +
                      `${PRIORITY_LABEL[task.priority]}</font>${SEP}` +
                      `<font color="#9aa0a6">${escapeHtml(requesterEmail)}</font>${attachments}`,
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

exports.submitTicket = onRequest(
  { region: "asia-southeast1", cors: true, memory: "512MiB", secrets: [CHAT_WEBHOOK_URL] },
  async (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }

    try {
      const body = req.body || {};

      // Honeypot: a real person never fills a field they cannot see. Answer 200
      // so bots learn nothing from the response.
      if (cleanText(body.website, 40)) {
        logger.info("Ticket rejected: honeypot filled");
        res.status(200).json({ ok: true, ticketId: taskId() });
        return;
      }

      const title = cleanText(body.title, TICKET_LIMITS.titleMax);
      const description = cleanText(body.description, TICKET_LIMITS.descriptionMax);
      const requesterEmail = cleanText(body.requesterEmail, TICKET_LIMITS.emailMax).toLowerCase();

      if (title.length < 3) { res.status(400).json({ code: "title_required", error: "Please give the request a subject." }); return; }
      if (!looksLikeEmail(requesterEmail)) { res.status(400).json({ code: "email_invalid", error: "That email address doesn't look right." }); return; }

      const priority = TICKET_PRIORITIES.includes(body.priority) ? body.priority : "medium";
      const categoryLabel = TICKET_CATEGORIES[body.category] || TICKET_CATEGORIES.other;

      const files = Array.isArray(body.files) ? body.files.slice(0, TICKET_LIMITS.files) : [];

      // Vet attachments before doing any work, so a bad file is a clear 400
      // rather than an opaque failure halfway through the upload.
      const rejected = files.find((f) => !ALLOWED_UPLOAD_TYPES[f && f.type]);
      if (rejected) {
        res.status(400).json({ code: "file_type",
          error: `"${cleanText(rejected.name, 60) || "That file"}" isn't an image or PDF.` });
        return;
      }
      const sizeOf = (f) => (String(f.data || "").length * 3) / 4;
      if (files.some((f) => sizeOf(f) > TICKET_LIMITS.fileBytes)) {
        res.status(413).json({ code: "file_too_large", error: "One of those attachments is larger than 8 MB." });
        return;
      }
      if (files.reduce((sum, f) => sum + sizeOf(f), 0) > TICKET_LIMITS.totalBytes) {
        res.status(413).json({ code: "files_too_large", error: "Those attachments are too large. Try fewer, or smaller ones." });
        return;
      }

      if (!(await withinRateLimit(clientKey(req)))) {
        res.status(429).json({ code: "rate_limited", error: "Too many tickets from here in the last hour. Please try again later." });
        return;
      }

      const team = await loadTicketTeam();
      const ticketId = taskId();

      // Never take an assignee on trust from a public form: it counts only if
      // it is genuinely a member of the team the ticket lands in.
      const requestedAssignee = cleanText(body.assignee, 128);
      const assignee = team.memberIds.includes(requestedAssignee) ? requestedAssignee : "";

      let attachments = [];
      if (files.length) {
        const bucket = admin.storage().bucket();
        attachments = await Promise.all(
          files.map((file, i) => storeAttachment(bucket, ticketId, i, file))
        );
      }

      const now = Date.now();
      const task = {
        id: ticketId,
        title,
        description: `Submitted by ${requesterEmail}\n\n` + (description || "(no details given)"),
        status: "todo",
        priority,
        assignee,
        coAssignees: [],
        dueDate: "",
        location: "",
        locationLat: "",
        locationLng: "",
        labels: ["Ticket", categoryLabel],
        stakeholders: [],
        subtasks: [],
        comments: [],
        attachments,
        createdAt: now,
        updatedAt: now,
        createdBy: "",
        ownerUid: "",
        teamId: team.id,
        // Structured copy of what the description says, for later filtering
        source: "ticket",
        requesterEmail,
      };

      await db.collection("tasks").doc(ticketId).set(task);
      logger.info("Ticket created", { ticketId, teamId: team.id, assignee, attachments: attachments.length });

      // Best-effort notification — a failed webhook must not lose the ticket.
      try {
        await postToChat(CHAT_WEBHOOK_URL.value(), ticketChatPayload(task, requesterEmail, ticketId));
      } catch (e) {
        logger.warn("Ticket Chat notification failed: " + e.message);
      }

      res.status(200).json({ ok: true, ticketId });
    } catch (e) {
      logger.error("Ticket submission failed", e);
      res.status(500).json({ code: "server_error", error: "Something went wrong on our side. Please try again." });
    }
  }
);


// ── Who can a public ticket be addressed to?  GET /api/team ───
exports.ticketAssignees = onRequest(
  { region: "asia-southeast1", cors: true, memory: "256MiB" },
  async (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "GET") { res.status(405).json({ error: "Use GET" }); return; }
    try {
      const members = await listTicketAssignees(await loadTicketTeam());
      res.set("Cache-Control", "public, max-age=300");
      res.status(200).json({ members });
    } catch (e) {
      logger.error("Assignee list failed", e);
      // The form degrades to "anyone on the team", so this is not fatal.
      res.status(200).json({ members: [] });
    }
  }
);
