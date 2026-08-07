CREATE TABLE IF NOT EXISTS service_credentials (
  credential_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ciphertext TEXT NOT NULL,
  iv VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  auth_tag VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  last_four VARCHAR(4) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (credential_kind),
  CONSTRAINT chk_service_credentials_kind CHECK (credential_kind IN ('JUSTONEAPI', 'DEEPSEEK'))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
-- statement-breakpoint
ALTER TABLE collection_tasks
  ADD COLUMN keyword VARCHAR(50) NULL AFTER trigger_type,
  ADD COLUMN requested_note_limit TINYINT UNSIGNED NULL AFTER keyword,
  ADD COLUMN fetched_post_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER failed_post_count,
  ADD COLUMN fetched_comment_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER fetched_post_count,
  ADD COLUMN stored_post_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER fetched_comment_count,
  ADD COLUMN stored_comment_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER stored_post_count,
  ADD COLUMN skipped_no_comment_post_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER stored_comment_count,
  ADD COLUMN failed_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER skipped_no_comment_post_count,
  ADD COLUMN stop_requested_at DATETIME(3) NULL AFTER failed_count,
  DROP CHECK chk_collection_tasks_status,
  ADD CONSTRAINT chk_collection_tasks_status CHECK (
    status IN ('queued', 'running', 'stopping', 'stopped', 'success', 'partial_success', 'failed')
  ),
  ADD CONSTRAINT chk_collection_tasks_requested_note_limit CHECK (
    requested_note_limit IS NULL OR requested_note_limit BETWEEN 1 AND 10
  )
