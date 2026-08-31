# SubhArambh Business App — Final Base

All-in-one business communication platform for SubhArambh India: chat, groups, status, voice/video call signaling, customer CRM, Excel membership import, campaigns, in-app broadcast, AI call scripts/queue, and a dedicated Owner Admin Panel.

## Customer app
- WhatsApp-style chat UI
- One-to-one and group chat
- Status, profile, media/file upload
- WebRTC voice/video call signaling
- Business marketing and in-app broadcast

## Owner/Admin panel
Open `/admin` after signing in to the main app as the configured owner.
- Dashboard
- Members / Excel import
- Valid / Expired / New / Unknown status
- Campaigns and in-app broadcast
- AI calling scripts and queue
- Users & roles
- Activity overview

## Render
See `RENDER-SETUP.md`.

## Demo mode
Set `DEMO_MODE=true`. OTP is `123456`. No real SMS, WhatsApp or phone calls are sent.

## Production note
For a real commercial deployment, move JSON storage to PostgreSQL, use persistent object storage for uploads, add HTTPS/WebRTC TURN infrastructure, and integrate approved WhatsApp/telephony/AI providers with consent and applicable rules.
