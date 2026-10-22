# Public ticket form

A page anyone can open — no login — to file a request. Each submission becomes
a normal task on the board, so it shows up in the web app and the Chrome
extension like any other.

**URL:** https://taskflow-be186.web.app/submit

## How it works

```
                    ┌─GET  /api/team───▶ ticketAssignees ─▶ names for the picker
public/submit.html ─┤
                    └─POST /api/ticket─▶ submitTicket ─┬─▶ Cloud Storage  tickets/<id>/…
   (same origin, so no CORS preflight)                 ├─▶ Firestore      tasks/<id>
                                                       └─▶ Google Chat notification
```

`firestore.rules` still blocks anonymous clients from writing to `/tasks`. The
form never touches Firestore directly — the function does it with the Admin
SDK, which is what lets the page stay public without loosening the rules.

## Setup — one manual step

**Firebase Storage must be enabled before this works.** It is not, as of
writing (the bucket 404s), and it can only be turned on from the console:

1. https://console.firebase.google.com/project/taskflow-be186/storage → **Get started**
2. Pick the `asia-southeast1` region to sit next to the functions
3. Then deploy: `firebase deploy --only hosting,functions,storage`

⚠️ Until Storage is on, a bare `firebase deploy` **fails**, because
`firebase.json` now declares a storage target. Use
`firebase deploy --only hosting,functions` in the meantime — the form works,
but attachments will error.

## Where tickets land

The function files against the one team that exists. If you ever add a second
team, set the target explicitly:

```bash
firebase functions:config:unset   # not needed; params are set at deploy time
# then redeploy with the param set:
TICKET_TEAM_ID=<teamId> firebase deploy --only functions:submitTicket
```

## The task a ticket creates

Same shape `saveTask()` writes in `public/app.js`, so nothing special is needed
to display it:

| Field | Value |
|---|---|
| `status` | `todo` |
| `assignee` | the uid the submitter picked, else empty (unassigned, for triage) |
| `labels` | `["Ticket", <category>]` — Bug / Feature / Access / Data / Support |
| `description` | `Submitted by <email>` then the details |
| `attachments` | `[{ name, url, size, contentType }]`, url is a tokenised Storage link |
| `source`, `requesterEmail` | structured copy, for filtering later |

Attachments are readable through an unguessable download token in the URL, so
`storage.rules` denies all direct client access — nothing needs it.

## Addressing a ticket to someone

The form shows a **"Who should handle this?"** picker, filled from
`GET /api/team` — the members of the target team, **names only**. Email
addresses are deliberately withheld, since that endpoint is public and would
otherwise be a harvesting target.

The chosen value is a uid, and `submitTicket` re-checks it against the team's
`memberIds` before using it. Anything else — a stale uid, a guess, an injection
attempt — is silently dropped and the ticket arrives unassigned rather than
being rejected.

If the endpoint is unreachable or the team has no members, the picker stays
hidden and tickets simply arrive unassigned; submission is unaffected.

## Language

The page is bilingual, **Thai by default**, with a ไทย/EN toggle that persists
in `localStorage`. Copy lives in the `COPY` table in `submit.js`.

Error replies from `submitTicket` carry a stable `code` (`email_invalid`,
`rate_limited`, …) alongside English text. The page translates the code, so a
Thai visitor never sees an English server message; the English text is the
fallback for a code the page doesn't know.

## Abuse controls

| Control | Value |
|---|---|
| Honeypot field | Silently accepted, nothing written |
| Rate limit | 6 tickets per IP per hour (`ticketLimits` collection, IP is hashed) |
| Field caps | title 140, details 5000, email 160 |
| Attachments | 5 files, 8 MB each, 20 MB total, images + PDF only |
| Client-side | Big photos resized to 2000px before upload |

This is deliberately lightweight. If it ever gets abused, the next step is a
CAPTCHA (reCAPTCHA/Turnstile) on the form, or restricting `requesterEmail` to
known domains in `submitTicket`.

### Cleaning up rate-limit docs

`ticketLimits` accumulates one small doc per IP-hour. Each carries an
`expiresAt` field — set a [Firestore TTL policy](https://console.firebase.google.com/project/taskflow-be186/firestore/ttl)
on `ticketLimits.expiresAt` and they delete themselves.
