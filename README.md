# Loot Vault

A gaming-style download gate. Visitors must watch your video, subscribe, like and comment before they get a download link. Every check runs on the server using the visitor's own Google sign-in, and the file is only handed out through short-lived links.

## 1. Google Cloud setup

1. Open Google Cloud Console and create a project.
2. Enable **YouTube Data API v3**.
3. Set up the **OAuth consent screen** (External). Add the scope `.../auth/youtube.readonly`. While the app is in Testing mode, add every tester's Google email under Test users (max 100). For public use, submit the app for verification.
4. Create **Credentials > OAuth client ID > Web application**.
   Authorized redirect URI: `https://YOUR-DOMAIN/auth/callback` (for local testing also add `http://localhost:3000/auth/callback`).
5. Copy the Client ID and Client secret.

## 2. Run it

```bash
npm install
cp .env.example .env      # then fill in the values
npm start
```

Requires Node.js 20.6 or newer. Open `http://localhost:3000`, then `http://localhost:3000/admin`.

## 3. Configure in the admin panel

- **Video:** paste the video link or ID.
- **Channel ID:** YouTube Studio > Settings > Channel > Advanced settings. It starts with `UC`.
- **Quests:** switch watch, subscribe, like and comment on or off.
- **Loot file:** upload a file (stored in `data/files`, never served directly) or use an external HTTPS link.
- **Players:** see who unlocked, export CSV, reset or block accounts.

## How the checks work

| Quest | How it is verified |
|---|---|
| Watch | The page sends a heartbeat every 5 seconds while the YouTube player is playing. The server adds credit based on its own clock, so skipping ahead or spamming requests gains nothing. |
| Subscribe | `subscriptions.list` with the visitor's token |
| Like | `videos.getRating` with the visitor's token |
| Comment | `commentThreads.list`, scanning the newest 1000 top-level comments for the visitor's channel |

After all checks pass the server issues a one-time link (`/d/<token>`) that expires after the lifetime you set and works for at most 3 requests (so interrupted downloads can resume).

## Deploying

- Use HTTPS and set `BASE_URL` to the https address; set `TRUST_PROXY=1` behind a proxy.
- Run a single instance. Sessions and download tokens live in memory, so a restart signs everyone out (settings and unlock records are kept in `data/db.json`).
- Back up the `data/` folder.
- If you use Nginx, raise `client_max_body_size` to match `MAX_UPLOAD_MB`.

## Known limits

- A determined user can fake watch heartbeats with a script. The server still forces real elapsed time, but no website can prove a human is watching.
- Likes, comments and subscriptions can be removed after unlocking. Unlocks are not re-checked.
- Subscribers who keep their subscriptions private may fail the subscribe check.
- Comments held for review by YouTube, or older than the newest 1000, may not be found. Raise the page count in `checkComment` for very busy videos.
- YouTube API quota is 10,000 units per day by default; each verification uses a handful of units.
- In `url` delivery mode the visitor is redirected to your link, so use a private or expiring URL.
