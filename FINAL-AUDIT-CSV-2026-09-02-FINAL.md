# SubhArambh Business App V8 — Final CSV + Backend Integrity Audit

Date: 2026-09-02

## Critical correction
The previous CSV-PapaParse package was found to contain an incorrect `server.js` that duplicated the Excel mapping module. This release corrects that regression by restoring the complete V8 Express + Socket.IO backend from the verified ALL-FIXES build while retaining the CSV/PapaParse and frontend CSV-upload changes.

## Verified
- `server.js` is the full backend (105,917 bytes), not `excel-mapping.js`.
- Express app and HTTP/Socket.IO server are defined.
- Authentication route `/api/auth/login-password` exists.
- Server startup uses `server.listen(...)` after database readiness.
- `db.js` is required by `server.js`.
- Excel/CSV mapping remains in `excel-mapping.js`.
- PapaParse `^5.7.0` is declared in `package.json`.
- Admin upload input accepts `.xlsx,.xls,.csv`.
- Node syntax checks pass for `server.js`, `excel-mapping.js`, `public/app.js`, and `public/admin.js`.
- ZIP integrity was checked after packaging.

## Important runtime truth
A full production end-to-end test requires installing npm dependencies and configuring external services (PostgreSQL, OTP provider, Vapi/voice provider, WhatsApp provider/API, and TURN where required). The sandbox cannot truthfully certify those external integrations without their live configuration. No provider delivery is claimed as tested here.

## Release rule
This ZIP is an existing-project repair. No new demo application was substituted and the existing V8 frontend/backend structure is retained.
