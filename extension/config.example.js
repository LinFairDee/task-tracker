// ============================================================
// TASKFLOW CHROME EXTENSION — CONFIGURATION
// ============================================================
// Copy this file to config.js and fill in the same values the web app
// uses in public/config.js. All of these are public client-side values
// (they ship inside the extension bundle) — never put a secret here.
//
// Setup checklist:
//   1. Firebase Console → Project Settings → Your apps → Web app
//      → copy apiKey / projectId / authDomain.
//   2. Google Cloud Console → APIs & Services → Credentials
//      → open the same OAuth 2.0 Web client the web app uses
//      → Authorised redirect URIs → add:
//           https://<EXTENSION_ID>.chromiumapp.org/
//        (the extension ID is pinned by the "key" in manifest.json —
//         see extension-id.txt, or read it off chrome://extensions)
//   3. Firebase Console → Authentication → Settings → Authorised domains
//      → the chromiumapp.org redirect does not need to be added, but the
//        Google sign-in provider must be enabled.

export const CONFIG = {
  firebase: {
    apiKey: "YOUR_FIREBASE_API_KEY",
    projectId: "YOUR_PROJECT_ID",
    authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  },

  // OAuth 2.0 Web client ID. The Google ID token it issues is traded for a
  // Firebase session, so this client must either live in the same GCP project
  // as the Firebase project above, or be whitelisted under
  // Firebase Console → Authentication → Sign-in method → Google
  // → "Whitelist client IDs from external projects".
  googleClientId: "YOUR_CLIENT_ID.apps.googleusercontent.com",

  // Only accounts on this Workspace domain may sign in.
  // Set to "" to allow any Google account.
  allowedDomain: "fairdee.co.th",

  // Where "Open in TaskFlow" sends you.
  appUrl: "https://YOUR_PROJECT_ID.web.app",
};
