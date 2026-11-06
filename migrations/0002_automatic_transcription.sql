-- Automated transcription job queue; does not alter historical lectures or approvals.
CREATE TABLE IF NOT EXISTS processing_jobs (
  lecture_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','complete','failed','cancelled')),
  stage TEXT NOT NULL DEFAULT 'waiting',
  attempts INTEGER NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  highlight_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (lecture_id) REFERENCES lectures(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_status ON processing_jobs(status,updated_at);
-- Videos uploaded before the patch should also be transcribed automatically.
INSERT OR IGNORE INTO processing_jobs (lecture_id,status,stage)
SELECT id,'queued','waiting' FROM lectures
WHERE status='uploaded' AND r2_key IS NOT NULL;
