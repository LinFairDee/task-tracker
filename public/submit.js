/* ============================================================
   TASKFLOW — PUBLIC TICKET FORM
   Posts to /api/ticket, which Firebase Hosting rewrites to the
   submitTicket function — same origin, so there is no CORS hop.
   ============================================================ */
"use strict";

const ENDPOINT = "/api/ticket";
const TEAM_ENDPOINT = "/api/team";

const LIMITS = {
  files: 5,
  // What we may send. Large images are resized down to fit rather than refused,
  // so this is a ceiling on the upload, not on what someone may pick.
  fileBytes: 8 * 1024 * 1024,
  // What we will even open — guards against a browser running out of memory.
  inputBytes: 30 * 1024 * 1024,
  // Downscale anything bigger than this so a phone photo doesn't become a 12MB
  // POST; screenshots under the threshold are sent untouched to stay crisp.
  scaleAbove: 1.5 * 1024 * 1024,
  maxEdge: 2000,
  jpegQuality: 0.85,
};

const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"];

// ── Copy ─────────────────────────────────────────────────────
// Thai is the default; the toggle is for anyone who prefers English.
// Server errors arrive with a `code`, which we look up here so the message
// matches the chosen language rather than whatever the function replied in.
const COPY = {
  th: {
    docTitle: "ส่งคำขอ — TaskFlow",
    heading: "ส่งคำขอ",
    subheading: "บอกเราว่าคุณต้องการอะไร แล้วเราจะรับเรื่องต่อ · ช่องที่มี * ต้องกรอก",
    emailLabel: "อีเมลของคุณ *", emailPh: "you@fairdee.co.th",
    categoryLabel: "คำขอประเภทไหน",
    cat_bug: "มีบางอย่างใช้งานไม่ได้", cat_feature: "ขอฟีเจอร์ใหม่หรือปรับปรุง",
    cat_access: "สิทธิ์เข้าใช้งานหรือบัญชี", cat_data: "ข้อมูลหรือรายงาน", cat_other: "เรื่องอื่น ๆ",
    assigneeLabel: "ต้องการให้ใครดูแลเรื่องนี้", anyone: "ใครก็ได้ในทีม",
    priorityLabel: "ด่วนแค่ไหน",
    p_low: "ไม่ด่วน", p_medium: "ปานกลาง", p_high: "ด่วน", p_urgent: "ด่วนมาก",
    titleLabel: "หัวข้อ *", titlePh: "สรุปสั้น ๆ เช่น ส่งออกรายงานประจำเดือนไม่ได้",
    detailsLabel: "รายละเอียด",
    detailsPh: "เกิดอะไรขึ้น คาดว่าควรเป็นอย่างไร และข้อมูลที่ช่วยให้เราตรวจสอบตามได้",
    filesLabel: "ไฟล์แนบ",
    dropAria: "เพิ่มไฟล์แนบ — คลิก ลากไฟล์มาวาง หรือวางภาพหน้าจอ",
    dropTitle: "คลิกเพื่อเลือกไฟล์",
    dropHint: "หรือลากมาวางที่นี่ — วางภาพหน้าจอด้วย ⌘V ก็ได้",
    dropMeta: "รูปภาพหรือ PDF · ไม่เกิน 5 ไฟล์ · รูปใหญ่ย่อให้อัตโนมัติ",
    send: "ส่งคำขอ", sending: "กำลังส่ง…", uploading: "กำลังอัปโหลด…",
    doneTitle: "ได้รับคำขอแล้ว",
    doneBody: "ขอบคุณครับ เรื่องเข้าบอร์ดแล้ว เดี๋ยวจะมีคนมารับเรื่อง",
    refLabel: "เลขอ้างอิง", again: "ส่งคำขออีกเรื่อง",

    e_email: "รูปแบบอีเมลไม่ถูกต้อง",
    e_title: "กรุณากรอกหัวข้อ",
    e_generic: "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง",
    e_read: "อ่านไฟล์นี้ไม่ได้",
    e_maxFiles: (n) => `แนบไฟล์ได้ไม่เกิน ${n} ไฟล์`,
    e_type: (f) => `"${f}" ไม่ใช่รูปภาพหรือ PDF จึงข้ามไฟล์นี้ไป`,
    e_tooBig: (f) => `"${f}" ใหญ่เกินกว่าจะแนบได้`,
    e_pdfBig: (f) => `"${f}" เป็น PDF ขนาดเกิน 8 MB ซึ่งย่อขนาดไม่ได้`,
    e_stillBig: (f) => `"${f}" ยังเกิน 8 MB หลังย่อแล้ว กรุณาครอปหรือส่งไฟล์ที่เล็กลง`,

    title_required: "กรุณากรอกหัวข้อ",
    email_invalid: "รูปแบบอีเมลไม่ถูกต้อง",
    file_type: "มีไฟล์ที่ไม่ใช่รูปภาพหรือ PDF",
    file_too_large: "ไฟล์แนบมีขนาดเกิน 8 MB",
    files_too_large: "ไฟล์แนบรวมกันใหญ่เกินไป กรุณาลดจำนวนหรือขนาดไฟล์",
    rate_limited: "ส่งคำขอบ่อยเกินไป กรุณาลองใหม่ในภายหลัง",
    server_error: "เกิดข้อผิดพลาดฝั่งเรา กรุณาลองใหม่อีกครั้ง",
  },
  en: {
    docTitle: "Submit a request — TaskFlow",
    heading: "Submit a request",
    subheading: "Tell us what you need and we'll pick it up · Fields marked * are required",
    emailLabel: "Your email *", emailPh: "you@fairdee.co.th",
    categoryLabel: "What kind of request is this?",
    cat_bug: "Something is broken", cat_feature: "New feature or improvement",
    cat_access: "Access or account", cat_data: "Data or report", cat_other: "Something else",
    assigneeLabel: "Who should handle this?", anyone: "Anyone on the team",
    priorityLabel: "How urgent is it?",
    p_low: "Low", p_medium: "Medium", p_high: "High", p_urgent: "Urgent",
    titleLabel: "Subject *", titlePh: "Short summary — e.g. Cannot export the monthly report",
    detailsLabel: "Details",
    detailsPh: "What happened, what you expected, and anything that helps us reproduce it.",
    filesLabel: "Attachments",
    dropAria: "Add attachments — click, drag files here, or paste a screenshot",
    dropTitle: "Click to choose files",
    dropHint: "or drag them here — you can also paste a screenshot with ⌘V",
    dropMeta: "Images or PDF · up to 5 files · big photos are resized for you",
    send: "Send request", sending: "Sending…", uploading: "Uploading…",
    doneTitle: "Request received",
    doneBody: "Thanks — it's on the board and someone will pick it up.",
    refLabel: "Reference", again: "Submit another request",

    e_email: "That email address doesn't look right.",
    e_title: "Please give the request a subject.",
    e_generic: "Something went wrong. Please try again.",
    e_read: "Could not read that file",
    e_maxFiles: (n) => `You can attach up to ${n} files.`,
    e_type: (f) => `"${f}" isn't an image or PDF, so it was skipped.`,
    e_tooBig: (f) => `"${f}" is too large to attach.`,
    e_pdfBig: (f) => `"${f}" is a PDF larger than 8 MB — PDFs can't be resized.`,
    e_stillBig: (f) => `"${f}" is still over 8 MB after resizing. Please crop it or send a smaller version.`,

    title_required: "Please give the request a subject.",
    email_invalid: "That email address doesn't look right.",
    file_type: "One of those files isn't an image or PDF.",
    file_too_large: "One of those attachments is larger than 8 MB.",
    files_too_large: "Those attachments are too large. Try fewer, or smaller ones.",
    rate_limited: "Too many requests from here in the last hour. Please try again later.",
    server_error: "Something went wrong on our side. Please try again.",
  },
};

const LANG_KEY = "tf_ticket_lang";
let lang = "th";
const t = (key, ...args) => {
  const value = (COPY[lang] || COPY.th)[key];
  return typeof value === "function" ? value(...args) : (value ?? key);
};

// Small inline icons — the page draws no emoji.
const ICON = {
  file:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>' +
    '<path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
    'stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
};

const $ = (id) => document.getElementById(id);
const form = $("ticketForm");
const dropzone = $("dropzone");
const fileInput = $("fileInput");
const thumbs = $("thumbs");

let priority = "medium";
let attachments = [];   // { id, name, type, data, size, previewUrl }
let sending = false;

// ── Errors ───────────────────────────────────────────────────
function setError(key, message) {
  const el = document.querySelector(`[data-err="${key}"]`);
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("show", !!message);
  const control = $(key);
  if (control) control.classList.toggle("invalid", !!message);
}

function clearErrors() {
  document.querySelectorAll(".err").forEach((el) => {
    el.textContent = "";
    el.classList.remove("show");
  });
  document.querySelectorAll(".control.invalid").forEach((el) => el.classList.remove("invalid"));
}

// ── Language ─────────────────────────────────────────────────
function applyLang(next) {
  lang = COPY[next] ? next : "th";
  try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* private mode */ }

  document.documentElement.lang = lang;
  document.title = t("docTitle");
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAria));
  });
  $("lang").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.lang === lang));

  $("submitBtn").textContent = t("send");
  renderThumbs();   // remove-buttons carry a translated aria-label
}

$("lang").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-lang]");
  if (btn) applyLang(btn.dataset.lang);
});

try {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved && COPY[saved]) lang = saved;
} catch (e) { /* private mode */ }
applyLang(lang);

// ── Who can it be addressed to ───────────────────────────────
// Names only — the endpoint deliberately withholds email addresses. If it
// fails, the field stays hidden and the ticket simply arrives unassigned.
(async function loadAssignees() {
  try {
    const res = await fetch(TEAM_ENDPOINT);
    if (!res.ok) return;
    const { members } = await res.json();
    if (!Array.isArray(members) || !members.length) return;

    const select = $("assignee");
    members.forEach((m) => {
      const option = document.createElement("option");
      option.value = m.id;
      option.textContent = m.name;
      select.appendChild(option);
    });
    $("assigneeField").hidden = false;
  } catch (e) {
    /* leave the field hidden */
  }
})();

// ── Priority ─────────────────────────────────────────────────
$("priority").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-value]");
  if (!btn) return;
  priority = btn.dataset.value;
  $("priority").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
});

// ── Description counter ──────────────────────────────────────
$("description").addEventListener("input", (e) => {
  $("descCount").textContent = e.target.value.length;
});

// ── Attachments ──────────────────────────────────────────────
const readAsDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(t("e_read")));
    reader.readAsDataURL(blob);
  });

const loadImage = (dataUrl) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(t("e_read")));
    img.src = dataUrl;
  });

const dataUrlBytes = (url) => Math.round((url.split(",")[1] || "").length * 3 / 4);

/**
 * Shrink oversized images, but never make one worse. A UI screenshot is a big
 * PNG that compresses beautifully, and re-encoding it as JPEG can come out
 * larger *and* blurrier — so we generate the candidates and keep the smallest
 * one that is actually an improvement.
 */
async function prepare(file) {
  const dataUrl = await readAsDataUrl(file);
  const original = { name: file.name, type: file.type, data: dataUrl, size: file.size, previewUrl: dataUrl };

  if (file.type === "application/pdf") return { ...original, previewUrl: null };

  const img = await loadImage(dataUrl);
  const longest = Math.max(img.width, img.height);
  if (file.size <= LIMITS.scaleAbove && longest <= LIMITS.maxEdge) return original;


  const scale = Math.min(1, LIMITS.maxEdge / longest);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);

  const base = file.name.replace(/\.[^.]+$/, "");
  const candidates = [original];
  const jpeg = canvas.toDataURL("image/jpeg", LIMITS.jpegQuality);
  candidates.push({ name: base + ".jpg", type: "image/jpeg", data: jpeg,
                    size: dataUrlBytes(jpeg), previewUrl: jpeg });
  // Flat-colour screenshots stay smaller and sharper as PNG.
  if (file.type === "image/png") {
    const png = canvas.toDataURL("image/png");
    candidates.push({ name: base + ".png", type: "image/png", data: png,
                      size: dataUrlBytes(png), previewUrl: png });
  }

  const best = candidates.reduce((a, b) => (b.size < a.size ? b : a));
  if (best.size > LIMITS.fileBytes) {
    throw new Error(t("e_stillBig", file.name));
  }
  return best;
}

async function addFiles(list) {
  setError("files", "");
  const incoming = Array.from(list || []);
  if (!incoming.length) return;

  for (const file of incoming) {
    if (attachments.length >= LIMITS.files) {
      setError("files", t("e_maxFiles", LIMITS.files));
      break;
    }
    if (!ACCEPTED.includes(file.type)) {
      setError("files", t("e_type", file.name));
      continue;
    }
    if (file.size > LIMITS.inputBytes) {
      setError("files", t("e_tooBig", file.name));
      continue;
    }
    if (file.type === "application/pdf" && file.size > LIMITS.fileBytes) {
      setError("files", t("e_pdfBig", file.name));
      continue;
    }
    try {
      const prepared = await prepare(file);
      prepared.id = Math.random().toString(36).slice(2, 9);
      attachments.push(prepared);
      renderThumbs();
    } catch (e) {
      setError("files", e.message);
    }
  }
  renderThumbs();
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024
    ? (bytes / 1024 / 1024).toFixed(1) + " MB"
    : Math.max(1, Math.round(bytes / 1024)) + " KB";
}

function renderThumbs() {
  thumbs.innerHTML = attachments
    .map(
      (a) => `
      <div class="thumb" data-id="${a.id}">
        ${a.previewUrl
          ? `<img src="${a.previewUrl}" alt="" />`
          : `<div class="doc">${ICON.file}</div>`}
        <div class="meta" title="${escapeAttr(a.name)}">${escapeAttr(a.name)}</div>
        <button class="rm" type="button" data-remove="${a.id}" aria-label="${escapeAttr(a.name)}">${ICON.close}</button>
      </div>`
    )
    .join("");
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

thumbs.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-remove]");
  if (!btn) return;
  attachments = attachments.filter((a) => a.id !== btn.dataset.remove);
  setError("files", "");
  renderThumbs();
});

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener("change", () => {
  addFiles(fileInput.files);
  fileInput.value = "";
});

["dragenter", "dragover"].forEach((type) =>
  dropzone.addEventListener(type, (e) => { e.preventDefault(); dropzone.classList.add("over"); })
);
["dragleave", "drop"].forEach((type) =>
  dropzone.addEventListener(type, (e) => { e.preventDefault(); dropzone.classList.remove("over"); })
);
dropzone.addEventListener("drop", (e) => addFiles(e.dataTransfer?.files));

// Paste a screenshot straight into the form — the fastest path for a bug report.
document.addEventListener("paste", (e) => {
  const files = Array.from(e.clipboardData?.files || []);
  if (files.length) { e.preventDefault(); addFiles(files); }
});

// ── Submit ───────────────────────────────────────────────────
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (sending) return;
  clearErrors();

  const email = $("email").value.trim();
  const title = $("title").value.trim();

  let firstBad = null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    setError("email", t("e_email"));
    firstBad = firstBad || "email";
  }
  if (title.length < 3) { setError("title", t("e_title")); firstBad = firstBad || "title"; }
  if (firstBad) { $(firstBad).focus(); return; }

  sending = true;
  const btn = $("submitBtn");
  btn.disabled = true;
  btn.textContent = t(attachments.length ? "uploading" : "sending");

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requesterEmail: email,
        title,
        description: $("description").value.trim(),
        category: $("category").value,
        assignee: $("assignee").value,
        priority,
        website: $("website").value,          // honeypot
        files: attachments.map((a) => ({ name: a.name, type: a.type, data: a.data })),
      }),
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.ok) {
      // Prefer our own translation of the server's code; fall back to its text.
      throw new Error((payload.code && t(payload.code)) || payload.error || t("e_generic"));
    }

    $("ticketRef").textContent = payload.ticketId;
    form.classList.add("hidden");
    $("done").classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    setError("form", err.message || t("e_generic"));
  } finally {
    sending = false;
    btn.disabled = false;
    btn.textContent = t("send");
  }
});

// ── Submit another ───────────────────────────────────────────
$("againBtn").addEventListener("click", () => {
  form.reset();
  attachments = [];
  priority = "medium";
  $("priority").querySelectorAll("button").forEach((b) =>
    b.classList.toggle("active", b.dataset.value === "medium")
  );
  $("descCount").textContent = "0";
  $("assignee").value = "";
  renderThumbs();
  clearErrors();
  $("done").classList.add("hidden");
  form.classList.remove("hidden");
  $("email").focus();
});
