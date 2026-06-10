// ============================================================
// GOOGLE API CONFIGURATION
// ============================================================
// To enable Google integrations:
// 1. Go to https://console.cloud.google.com/
// 2. Create a new project (or use existing)
// 3. Enable these APIs:
//    - Gmail API
//    - Google Drive API
//    - Google Calendar API
//    - Google Chat API (requires Google Workspace)
// 4. Go to "Credentials" → Create "OAuth 2.0 Client ID"
//    - Application type: Web application
//    - Authorized JavaScript origins: http://localhost (or your domain)
// 5. Also create an "API Key" in Credentials
// 6. Copy this file as config.js and replace the values below

const GOOGLE_CONFIG = {
  clientId: "YOUR_CLIENT_ID.apps.googleusercontent.com",
  apiKey: "YOUR_API_KEY",
  scopes: [
    "openid",
    "profile",
    "email",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/chat.messages",
    "https://www.googleapis.com/auth/chat.spaces",
    "https://www.googleapis.com/auth/chat.memberships.readonly",
    "https://www.googleapis.com/auth/contacts.readonly",
  ].join(" "),
  discoveryDocs: [
    "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest",
    "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
    "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
  ],
};
