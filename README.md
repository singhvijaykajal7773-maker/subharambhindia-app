# SubhArambhIndia Chat & Business Marketing Demo v2

A local, working demo of a secure chat application plus a business marketing/CRM workspace. It runs without Meta/WhatsApp credentials. **DEMO MODE never sends real WhatsApp messages.**

## What is included

### Chat
- Demo phone OTP login (`123456`) and username/password login
- 1-to-1 and group chat
- Real-time Socket.IO messaging
- Read receipts, typing, reactions, edit/delete
- Media/file upload with an allow-list and 25 MB limit
- 24-hour Status/Stories
- Presence, profiles and block/unblock

### Business Marketing / CRM Demo
- Customer contacts and groups
- Opt-in tracking
- Manual customer creation
- Demo contact import
- Marketing campaign creation
- Campaign start/pause/resume state
- Simulated queued/sent/delivered/read statistics
- Dashboard analytics
- Per-user audit log

### Security improvements
- JWT issuer/audience validation
- Stronger password hashing (bcrypt cost 12)
- Minimum JWT secret length enforced
- Authentication request rate limiting
- Secure response headers
- Same-origin CORS by default
- Server-side chat membership checks for Socket.IO events
- Input length/format validation
- File type allow-list and size limit
- Tenant-like ownership checks for marketing data
- Secrets kept in `.env`

## Important limitations

This is a **student/local demo**, not a production WhatsApp replacement.

- Data uses `data/db.json`; production should use PostgreSQL and a proper migration system.
- Demo OTP is displayed on screen; no SMS provider is connected.
- Demo campaigns simulate delivery and do not send WhatsApp messages.
- No unofficial WhatsApp automation or restriction bypass is included.
- No claim is made that any software is impossible to hack.
- Before public deployment, add HTTPS, PostgreSQL, Redis/BullMQ, a managed secret store, stronger observability, backups, malware scanning and a professional security review.

## Requirements

- Node.js 18 or newer
- npm

## Windows setup

1. Extract the ZIP.
2. Open Terminal inside the `subharambh-chat` folder.
3. Run:

```bash
npm install
```

4. Copy `.env.example` to `.env`.
5. Change `JWT_SECRET` to a random string of at least 32 characters.
6. Start:

```bash
npm start
```

7. Open **http://localhost:5000** in Chrome.

## Demo login

Enter any valid phone number, click Send OTP, and use:

`123456`

For a new account, choose a name, username and password (password must be at least 8 characters).

To test chat between two accounts, use two browser windows/incognito with different phone numbers.

## Marketing demo

After login, click **Marketing** in the left navigation.

Click **Demo Data** to create sample opt-in customers, then **Create Marketing Campaign** and start it. The progress is simulated locally.

## Environment

See `.env.example`:

- `PORT` — local server port
- `JWT_SECRET` — required random secret, 32+ characters
- `DEMO_MODE` — keep `true` for student mode
- `CORS_ORIGIN` — allowed browser origin

## Production roadmap

1. PostgreSQL + Prisma migrations
2. Redis + BullMQ workers
3. Official WhatsApp Business/Cloud API provider
4. Verified webhooks
5. HTTPS and managed secrets
6. 2FA and email verification
7. Multi-tenant billing/usage controls
8. Security testing and backup/restore plan


## Owner Control Center (added)

Set `OWNER_PHONE` in the deployment environment to the owner's verified phone number (for example `+91...`). The matching account receives the Owner tab.

### Excel import
The Owner panel accepts `.xlsx` / `.xls` and maps these columns: `name`, `phone`, `status`, `expiryDate`, `contentType`, `callingType`, `group`, `optIn`, `notes`. See `docs/EXCEL_TEMPLATE.csv`.

### AI calling automation
Owner can create scripts for `expired`, `valid`, `new`, and `unknown` members. `Auto-Queue by Status` selects the enabled script matching each member's status and creates a call job. This build intentionally does **not** bypass carrier/provider limits or make unapproved bulk calls. Real phone calls require an approved voice/telephony provider and its credentials, consent, opt-out handling, rate limits, webhooks, recordings/transcripts policy, and production storage. Until configured, jobs remain queued and cannot place a real call.

### Production requirements
The existing demo still uses `data/db.json`. For a commercial multi-user service, migrate to PostgreSQL, add a queue/worker such as Redis/BullMQ, managed secrets, backups, monitoring, malware scanning, and security testing before production.


## V4 Business Suite Update
- WebRTC one-to-one voice/video calling with Socket.IO signaling.
- Camera/microphone permissions enabled for same-origin WebRTC contexts.
- In-app business broadcast endpoint: `/api/marketing/campaigns/:id/send-internal` sends a campaign to matching registered app users without an arbitrary 5-recipient batch rule.
- Business user roles endpoint for owner-managed role/permission updates.
- External WhatsApp/telephony delivery remains provider-based; the app does not bypass third-party limits or consent rules.
