-- v1.4: explicitly queued, reviewed Reel exports. Existing media and approvals are preserved.
CREATE TABLE IF NOT EXISTS reel_render_jobs (
  clip_id TEXT PRIMARY KEY REFERENCES clips(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','rendering','uploading','complete','failed','cancelled')),
  stage TEXT NOT NULL DEFAULT 'queued',
  run_id TEXT,
  progress_pct INTEGER NOT NULL DEFAULT 0,
  brand_name TEXT NOT NULL DEFAULT 'Masjid At-Towfiq | Bolton',
  crop_mode TEXT NOT NULL DEFAULT 'centre' CHECK(crop_mode IN ('centre','left','right','blur')),
  caption_style TEXT NOT NULL DEFAULT 'classic' CHECK(caption_style IN ('classic','bold')),
  output_key TEXT,
  output_size INTEGER NOT NULL DEFAULT 0,
  upload_id TEXT,
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reel_render_status ON reel_render_jobs(status, updated_at);
CREATE TABLE IF NOT EXISTS reel_upload_parts (
  clip_id TEXT NOT NULL REFERENCES reel_render_jobs(clip_id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  PRIMARY KEY (clip_id,part_number)
);

CREATE TABLE IF NOT EXISTS brand_assets (
  name TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
