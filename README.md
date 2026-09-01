# SubhArambh Business App V8 — Final Complete

Single consolidated V8 project for the SubhArambh business communication platform.

## Main modules
- Owner/Admin and permissions
- Members with Excel import, edit and export
- Artists, topics, classes, masterclasses, seminars and workshops
- Event lifecycle with edit/archive/restore/delete protection
- Zoom/meeting links and poster/media
- Message templates and in-app campaigns
- AI message generation with Owner approval before send
- AI calling scripts, consent-aware queue and provider adapters
- PWA install support for supported browsers
- PostgreSQL migration foundation

## Production requirements
Set secrets only in the hosting provider environment. At minimum: `JWT_SECRET`, `DATABASE_URL`, `NODE_ENV=production`, `DEMO_MODE=false`, and your real OTP/AI provider settings.

For persistent production media, use an external object/media URL or configure persistent storage. The local `uploads/` directory on a normal Render web service is not a permanent media store.
