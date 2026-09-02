-- Non-breaking production relational schema reference.
-- The current repository remains backward compatible through app_records JSONB.
-- These tables are the target for the next zero-downtime data migration.
CREATE TABLE IF NOT EXISTS business_events (id UUID PRIMARY KEY, owner_id UUID NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, artist TEXT, topic TEXT, event_date DATE, event_time TEXT, location TEXT, zoom_link TEXT, status TEXT NOT NULL DEFAULT 'draft', script TEXT, media_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS business_events_owner_date_idx ON business_events(owner_id,event_date);
CREATE TABLE IF NOT EXISTS message_templates (id UUID PRIMARY KEY, owner_id UUID NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, media_url TEXT, media_type TEXT, enabled BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS campaigns (id UUID PRIMARY KEY, owner_id UUID NOT NULL, event_id UUID, template_id UUID, name TEXT NOT NULL, message TEXT, status TEXT NOT NULL DEFAULT 'draft', scheduled_at TIMESTAMPTZ, mode TEXT NOT NULL DEFAULT 'IN_APP', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS campaigns_owner_status_idx ON campaigns(owner_id,status,scheduled_at);
CREATE TABLE IF NOT EXISTS campaign_recipients (id UUID PRIMARY KEY, campaign_id UUID NOT NULL, contact_id UUID, user_id UUID, status TEXT NOT NULL DEFAULT 'queued', sent_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ, read_at TIMESTAMPTZ, failed_reason TEXT);
CREATE INDEX IF NOT EXISTS campaign_recipients_campaign_idx ON campaign_recipients(campaign_id,status);
CREATE TABLE IF NOT EXISTS ai_message_drafts (id UUID PRIMARY KEY, owner_id UUID NOT NULL, event_id UUID, template_id UUID, instruction TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', approved_by UUID, approved_at TIMESTAMPTZ, sent_campaign_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS ai_message_drafts_owner_status_idx ON ai_message_drafts(owner_id,status);


-- V8 additions for event media and AI calling persistence targets.
ALTER TABLE business_events ADD COLUMN IF NOT EXISTS zoom_link TEXT;
ALTER TABLE business_events ADD COLUMN IF NOT EXISTS media_type TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS media_url TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS media_type TEXT;
ALTER TABLE ai_message_drafts ADD COLUMN IF NOT EXISTS media_url TEXT;
ALTER TABLE ai_message_drafts ADD COLUMN IF NOT EXISTS media_type TEXT;
CREATE TABLE IF NOT EXISTS ai_call_scripts (id UUID PRIMARY KEY, owner_id UUID NOT NULL, name TEXT NOT NULL, script TEXT NOT NULL, match_status TEXT, enabled BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS ai_call_campaigns (id UUID PRIMARY KEY, owner_id UUID NOT NULL, name TEXT NOT NULL, script_id UUID NOT NULL, target_statuses TEXT, start_at TIMESTAMPTZ, end_at TIMESTAMPTZ, concurrency INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'scheduled', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS ai_call_jobs (id UUID PRIMARY KEY, owner_id UUID NOT NULL, campaign_id UUID, contact_id UUID, phone TEXT NOT NULL, name TEXT, script_id UUID, provider TEXT, provider_call_id TEXT, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS ai_call_jobs_campaign_status_idx ON ai_call_jobs(campaign_id,status);
