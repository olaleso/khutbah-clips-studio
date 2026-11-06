-- v1.3: exact duration and monotonic progress along the original audio timeline.
-- This does not change job state; a running job can continue until a controlled upgrade.
ALTER TABLE processing_jobs ADD COLUMN duration_seconds REAL NOT NULL DEFAULT 0;
ALTER TABLE processing_jobs ADD COLUMN progress_seconds REAL NOT NULL DEFAULT 0;
