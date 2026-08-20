/* ============================================================
   TASKFLOW EXTENSION — SIGN-IN TAB
   Runs in a real tab because chrome.identity.launchWebAuthFlow
   opens its own window, which would tear down the popup.
   ============================================================ */
"use strict";

import { CONFIG } from "./config.js";
import { beginInteractiveSignIn, getSession } from "./lib/auth.js";
import { getPrefs } from "./lib/store.js";

const $ = id => document.getElementById(id);

(async function init() {
  const prefs = await getPrefs();
  document.documentElement.setAttribute("data-theme", prefs.theme);

  const session = await getSession();
  if (session) showDone(session);

  $("goBtn").addEventListener("click", start);
})();

function showDone(session) {
  $("heading").textContent = "You're signed in";
  $("blurb").textContent = `${session.name} · ${session.email}. Click the TaskFlow icon in your toolbar to see your tasks.`;
  $("goBtn").textContent = "Close this tab";
  $("goBtn").onclick = () => window.close();
}

async function start() {
  const btn = $("goBtn");
  btn.disabled = true;
  btn.textContent = "Waiting for Google…";
  $("error").classList.add("hidden");
  $("hint").classList.add("hidden");

  try {
    const session = await beginInteractiveSignIn();
    await chrome.runtime.sendMessage({ type: "tf:signed-in" }).catch(() => {});
    btn.disabled = false;
    showDone(session);
    setTimeout(() => window.close(), 1800);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Try again";
    $("error").textContent = e.message || "Sign-in failed";
    $("error").classList.remove("hidden");

    const hint = setupHint(e.message || "");
    if (hint) { $("hint").textContent = hint; $("hint").classList.remove("hidden"); }
  }
}

/**
 * Sign-in failures on a fresh install are all one-line console fixes, so name
 * the exact fix rather than echoing Chrome's or Google's wording.
 */
function setupHint(message) {
  const clientId = chrome.runtime.getManifest().oauth2?.client_id || CONFIG.googleClientId;

  if (/bad client id|invalid client|client_id/i.test(message)) {
    return `Chrome rejected the OAuth client id. Check that manifest.json → oauth2.client_id ` +
           `is exactly the "Chrome extension" client from Google Cloud Console, and that its ` +
           `Item ID matches this extension (${chrome.runtime.id}). Currently: ${clientId}`;
  }

  if (/not signed in|no.*account/i.test(message)) {
    return "Chrome itself isn't signed in to a Google account. Sign in to Chrome " +
           "(profile menu, top-right), then try again.";
  }

  if (/not granted|revoked|approve|interaction/i.test(message)) {
    return "Access wasn't granted. Try again and approve the permission prompt — " +
           "the extension only asks for your name, email and profile picture.";
  }

  // Only reachable on the web-client fallback path.
  if (/redirect_uri|invalid_request|unauthorized|400/i.test(message)) {
    return `If Google said "redirect_uri_mismatch": OAuth client ${clientId} → ` +
           `Authorised redirect URIs → add exactly: ${chrome.identity.getRedirectURL()}`;
  }

  if (/INVALID_IDP_RESPONSE|audience|CREDENTIAL|INVALID_ID_TOKEN|OPERATION_NOT_ALLOWED/i.test(message)) {
    return `Firebase project "${CONFIG.firebase.projectId}" doesn't trust OAuth client ` +
           `${clientId}. The client must live in the same GCP project as Firebase, or be ` +
           `whitelisted under Firebase Console → Authentication → Sign-in method → Google ` +
           `→ "Whitelist client IDs from external projects".`;
  }

  if (/only @|domain/i.test(message)) {
    return `The extension is limited to @${CONFIG.allowedDomain} accounts. ` +
           `Change allowedDomain in extension/config.js to widen that.`;
  }
  return "";
}
