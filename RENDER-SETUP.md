# Render Setup — V8

1. Create a PostgreSQL database.
2. Create the Web Service from this repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Set `NODE_ENV=production`.
6. Set `DEMO_MODE=false`.
7. Set a random `JWT_SECRET` of at least 32 characters.
8. Set `DATABASE_URL` from Render PostgreSQL.
9. Configure your real OTP delivery provider.
10. Configure `AI_MESSAGE_API_KEY` for AI message generation.
11. Configure Vapi/Bolna/Bland credentials for real AI calling if required.
12. Set `APP_BASE_URL` to the public HTTPS URL when using provider webhooks.

## Important media note
Uploaded local files are suitable for testing but are not durable storage on a normal ephemeral web service. For production posters/PDFs, use an external object/media store and save its URL in the event/template/campaign.

## Safe rollout
Deploy V8 to a separate test service first. Import a small copy of the Excel data, test login, event editing, campaigns, AI drafts, PWA installation and calling configuration, then switch production.
