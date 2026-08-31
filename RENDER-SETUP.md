## IMPORTANT — GitHub repository root
Upload the **contents of this ZIP directly to the GitHub repository root**. Do not put the project inside another `baseapp` or project folder.

# Render deployment

Repository root must contain `package.json`, `server.js`, `public/`, `db.js`, `data/`.

Build command: `npm install`
Start command: `npm start`
Node: 18+ (Render may use a newer compatible Node version)

Environment variables:
- `PORT=5000` (Render may override the listening port; the app also reads process.env.PORT)
- `JWT_SECRET=<32+ random characters>`
- `DEMO_MODE=true`
- `OWNER_PHONE=+91XXXXXXXXXX`
- `CORS_ORIGIN=https://YOUR-SERVICE.onrender.com`

After the first deploy, copy the exact Render service URL into `CORS_ORIGIN` and redeploy.

Owner login: use the same normalized phone number as `OWNER_PHONE`. In demo mode the OTP is `123456`.

Admin panel: `https://YOUR-SERVICE.onrender.com/admin`

This build is a demo/provider-ready business platform. Real WhatsApp delivery and real AI phone calls require approved provider integrations and credentials. JSON file storage is suitable for demo/testing; production should move to PostgreSQL/object storage.
