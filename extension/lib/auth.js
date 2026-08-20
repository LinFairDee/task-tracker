/* ============================================================
   TASKFLOW EXTENSION — FIREBASE AUTH (REST)
   Google OAuth via chrome.identity → Firebase Identity Toolkit.
   The Firebase refresh token is what keeps us signed in; the Google
   OAuth step only happens once (or after an explicit sign-out).
   ============================================================ */
"use strict";

import { CONFIG } from "../config.js";

const SIGN_IN_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${CONFIG.firebase.apiKey}`;
const REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${CONFIG.firebase.apiKey}`;
const SESSION_KEY = "tf_session";

// Refresh a little early so a request never races the expiry.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

let _refreshInFlight = null;

// ── Session storage ───────────────────────────────────────────
export async function getSession() {
  const { [SESSION_KEY]: session } = await chrome.storage.local.get(SESSION_KEY);
  return session || null;
}

async function putSession(session) {
  await chrome.storage.local.set({ [SESSION_KEY]: session });
  return session;
}

export async function signOut() {
  _refreshInFlight = null;
  // Drop Chrome's cached Google token too, so the next sign-in can pick a
  // different account instead of silently reusing this one.
  try { await chrome.identity.clearAllCachedAuthTokens(); } catch (e) {}
  await chrome.storage.local.remove(SESSION_KEY);
}

export function isAllowedEmail(email) {
  if (!CONFIG.allowedDomain) return true;
  return (email || "").toLowerCase().endsWith("@" + CONFIG.allowedDomain.toLowerCase());
}

// ── Interactive sign-in (must run from a tab, not the popup) ──
// Both paths below open their own window, which closes the browser-action
// popup and kills its JS context — so signin.html drives this.
export async function beginInteractiveSignIn() {
  // A Chrome-extension OAuth client (manifest.oauth2) is the preferred route:
  // Chrome brokers the token itself, so there is no redirect URI to register.
  if (chrome.runtime.getManifest().oauth2?.client_id) {
    try {
      return await signInWithChromeIdentity();
    } catch (e) {
      if (/cancel|did not approve|closed/i.test(e.message)) throw e;
      console.warn("[TaskFlow] getAuthToken failed, trying the web auth flow:", e.message);
    }
  }
  return signInWithWebAuthFlow();
}

/** Chrome hands us a Google access token for the profile's account. */
async function signInWithChromeIdentity() {
  const result = await chrome.identity.getAuthToken({ interactive: true });
  // Chrome ≥105 resolves to { token, grantedScopes }; older builds to a string.
  const googleToken = typeof result === "string" ? result : result?.token;
  if (!googleToken) throw new Error("Chrome did not return a Google token");

  return exchangeWithFirebase(
    `access_token=${encodeURIComponent(googleToken)}&providerId=google.com`,
    chrome.identity.getRedirectURL(),
    googleToken,
  );
}

/** Fallback for a plain Web OAuth client: implicit flow in a popup window. */
async function signInWithWebAuthFlow() {
  const redirectUri = chrome.identity.getRedirectURL();
  const nonce = crypto.randomUUID();

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", CONFIG.googleClientId);
  authUrl.searchParams.set("response_type", "id_token");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("prompt", "select_account");
  if (CONFIG.allowedDomain) authUrl.searchParams.set("hd", CONFIG.allowedDomain);

  const redirected = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });
  if (!redirected) throw new Error("Sign-in was cancelled");

  const fragment = new URLSearchParams(new URL(redirected).hash.slice(1));
  if (fragment.get("error")) throw new Error(fragment.get("error"));

  const googleIdToken = fragment.get("id_token");
  if (!googleIdToken) throw new Error("Google did not return an ID token");

  return exchangeWithFirebase(
    `id_token=${encodeURIComponent(googleIdToken)}&providerId=google.com`,
    redirectUri,
    null,
  );
}

/** Trade a Google credential for a Firebase session. */
async function exchangeWithFirebase(postBody, requestUri, googleToken) {
  const res = await fetch(SIGN_IN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postBody, requestUri, returnSecureToken: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Firebase sign-in failed");

  if (!isAllowedEmail(data.email)) {
    await signOut();
    throw new Error(`Only @${CONFIG.allowedDomain} accounts can sign in`);
  }

  return putSession({
    googleToken,
    uid: data.localId,
    email: data.email || "",
    name: data.displayName || data.email || "Google User",
    picture: data.photoUrl || "",
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + Number(data.expiresIn || 3600) * 1000,
  });
}

// ── Silent refresh ────────────────────────────────────────────
async function refreshSession(session) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
  });
  const res = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!res.ok) {
    // TOKEN_EXPIRED / USER_DISABLED / invalid grant — the session is dead.
    await signOut();
    throw new Error("SESSION_EXPIRED");
  }
  return putSession({
    ...session,
    idToken: data.id_token,
    refreshToken: data.refresh_token || session.refreshToken,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  });
}

/** A valid Firebase ID token, refreshed if needed. Throws SESSION_EXPIRED. */
export async function getIdToken({ force = false } = {}) {
  const session = await getSession();
  if (!session) throw new Error("SESSION_EXPIRED");

  const stale = force || Date.now() > session.expiresAt - EXPIRY_SKEW_MS;
  if (!stale) return session.idToken;

  if (!_refreshInFlight) {
    _refreshInFlight = refreshSession(session).finally(() => { _refreshInFlight = null; });
  }
  const fresh = await _refreshInFlight;
  return fresh.idToken;
}
