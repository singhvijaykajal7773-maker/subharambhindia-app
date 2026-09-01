# V8 Security Checklist

- DEMO_MODE must be false in production.
- JWT_SECRET must be a long random secret.
- OTP verification is rate limited and locked after repeated failures.
- AI provider keys stay server-side.
- Owner approval is required before an AI message draft can be sent.
- AI calling requires explicit calling consent/opt-in.
- Service worker does not cache `/api/`, `/uploads/` or `/admin` routes.
- Event Zoom/media URLs are not silently truncated at 200 characters; V8 allows up to 2048 characters for these URL fields.
- Archive before permanent event deletion.
- Test on a separate Render service before production cutover.
