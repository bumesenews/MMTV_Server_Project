# Firebase credentials (not committed)

Place your Firebase service account key here:

```
secrets/firebase-service-account.json
```

## How to download

1. Open [Firebase Console](https://console.firebase.google.com/)
2. Select your project
3. Project settings (gear) → **Service accounts**
4. Click **Generate new private key**
5. Save the downloaded JSON as:
   `secrets/firebase-service-account.json`

## Required fields in the JSON

- `type` (`service_account`)
- `project_id`
- `private_key`
- `client_email`

## Environment

In `.env` (optional; this path is the default):

```
FIREBASE_SERVICE_ACCOUNT_PATH=./secrets/firebase-service-account.json
```

Or set `FIREBASE_SERVICE_ACCOUNT_JSON` to the full JSON string instead of a file.

## PM2 / production

Keep the file on the server at:

`<project-root>/secrets/firebase-service-account.json`

Do not commit this file. Restrict permissions, e.g. `chmod 600 secrets/firebase-service-account.json`.
