CREATE TABLE IF NOT EXISTS app_records (
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection, record_id)
);
CREATE INDEX IF NOT EXISTS app_records_collection_idx ON app_records(collection);
CREATE INDEX IF NOT EXISTS app_records_phone_idx ON app_records((data->>'phone')) WHERE collection IN ('users','marketingContacts');
CREATE INDEX IF NOT EXISTS app_records_owner_idx ON app_records((data->>'ownerId')) WHERE collection IN ('marketingContacts','campaigns','events','messageTemplates','aiCallCampaigns','aiCallJobs','aiCallScripts','auditLogs');
