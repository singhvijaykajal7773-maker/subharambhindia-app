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

### WhatsApp Business (optional, real outbound)
Set the current Meta Graph API version plus:
- `WHATSAPP_API_VERSION`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_VERIFY_TOKEN`

Business-initiated WhatsApp campaigns use approved template messages. Without these credentials the Admin Panel explicitly shows **WhatsApp: NOT CONNECTED** and will not claim delivery.


## Provider configuration — real calls and WhatsApp

The application is wired for real provider APIs; it does not fake delivery or call completion.

### AI voice calling
For Vapi, set `AI_CALL_PROVIDER=vapi`, `VAPI_API_KEY` (or `VAPI_PRIVATE_KEY`), `VAPI_PHONE_NUMBER_ID`, and `VAPI_ASSISTANT_ID`. Vapi's current outbound call API uses `POST /call` with `phoneNumberId`, `assistantId`, and a destination customer number. The assistant/phone number must be configured in Vapi first.

For India/international calling, use a supported provider/number arrangement; do not assume a free US number can call Indian numbers.

### WhatsApp Business
Use Meta WhatsApp Cloud API with an approved business-initiated message template. Set `WHATSAPP_API_VERSION`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and `WHATSAPP_VERIFY_TOKEN`. The app will block a WhatsApp campaign when the connection or approved template is missing.

### Database
Production must use Render PostgreSQL via `DATABASE_URL`. The local JSON fallback is for development only.
