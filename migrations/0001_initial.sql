-- Khutbah Clips Studio Release 1 — Cloudflare D1
CREATE TABLE IF NOT EXISTS lectures (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  speaker TEXT NOT NULL DEFAULT '',
  lecture_type TEXT NOT NULL DEFAULT 'Khutbah',
  youtube_url TEXT,
  source_filename TEXT,
  source_size INTEGER,
  source_mime TEXT,
  r2_key TEXT,
  upload_id TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  rights_confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS upload_parts (
  lecture_id TEXT NOT NULL,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  PRIMARY KEY (lecture_id, part_number),
  FOREIGN KEY (lecture_id) REFERENCES lectures(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id TEXT PRIMARY KEY,
  lecture_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  FOREIGN KEY (lecture_id) REFERENCES lectures(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_transcript_lecture_start ON transcript_segments(lecture_id, start_ms);

CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY,
  lecture_id TEXT NOT NULL,
  title TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  rationale TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'needs_review',
  check_context INTEGER NOT NULL DEFAULT 0,
  check_quotes INTEGER NOT NULL DEFAULT 0,
  check_captions INTEGER NOT NULL DEFAULT 0,
  check_rights INTEGER NOT NULL DEFAULT 0,
  reviewer_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (lecture_id) REFERENCES lectures(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_clips_lecture ON clips(lecture_id);
CREATE INDEX IF NOT EXISTS idx_clips_status ON clips(status);
