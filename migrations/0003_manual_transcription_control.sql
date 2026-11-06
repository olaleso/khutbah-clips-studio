-- v1.2: jobs require an explicit Start action in Clip Studio.
-- Keep the original status CHECK constraint.  'cancelled' with stage='ready_to_start'
-- represents a ready-but-not-started job; with stage='stopped' it was halted.
-- A per-run token prevents an older worker from saving results after a stop/restart.
ALTER TABLE processing_jobs ADD COLUMN run_id TEXT;
UPDATE processing_jobs
SET status='cancelled', stage='ready_to_start', error_message='', run_id=NULL, updated_at=datetime('now')
WHERE status='queued';
UPDATE processing_jobs
SET status='cancelled', stage='interrupted', error_message='Previous process stopped; choose Start transcription to resume from the beginning.',
    finished_at=datetime('now'), run_id=NULL, updated_at=datetime('now')
WHERE status='processing';
