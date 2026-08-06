CREATE TABLE IF NOT EXISTS data_sources (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(191) NOT NULL,
  source_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'enabled',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_data_sources_code (source_code),
  CONSTRAINT chk_data_sources_status CHECK (status IN ('enabled', 'disabled'))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS brands (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  data_source_id BIGINT UNSIGNED NOT NULL,
  brand_name VARCHAR(191) NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'draft',
  archived_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_brands_source_name (data_source_id, brand_name),
  UNIQUE KEY uq_brands_id_source (id, data_source_id),
  KEY idx_brands_status (status, archived_at),
  CONSTRAINT fk_brands_source FOREIGN KEY (data_source_id) REFERENCES data_sources (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_brands_status CHECK (status IN ('draft', 'enabled', 'disabled', 'archived')),
  CONSTRAINT chk_brands_archive CHECK ((status = 'archived' AND archived_at IS NOT NULL) OR (status <> 'archived' AND archived_at IS NULL))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS brand_search_terms (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  brand_id BIGINT UNSIGNED NOT NULL,
  term_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  term_value VARCHAR(255) NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'enabled',
  archived_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_brand_terms_value (brand_id, term_type, term_value),
  UNIQUE KEY uq_brand_terms_id_brand (id, brand_id),
  KEY idx_brand_terms_status (brand_id, status, archived_at),
  CONSTRAINT fk_brand_terms_brand FOREIGN KEY (brand_id) REFERENCES brands (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_brand_terms_type CHECK (term_type IN ('alias', 'model', 'exclude')),
  CONSTRAINT chk_brand_terms_status CHECK (status IN ('enabled', 'disabled', 'archived')),
  CONSTRAINT chk_brand_terms_archive CHECK ((status = 'archived' AND archived_at IS NOT NULL) OR (status <> 'archived' AND archived_at IS NULL))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS collection_tasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  data_source_id BIGINT UNSIGNED NOT NULL,
  brand_id BIGINT UNSIGNED NOT NULL,
  trigger_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'queued',
  retry_of_task_id BIGINT UNSIGNED NULL,
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  succeeded_post_count INT UNSIGNED NOT NULL DEFAULT 0,
  failed_post_count INT UNSIGNED NOT NULL DEFAULT 0,
  error_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_summary VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_collection_tasks_id_source (id, data_source_id),
  KEY idx_collection_tasks_brand_time (data_source_id, brand_id, created_at),
  KEY idx_collection_tasks_status_time (status, created_at),
  KEY idx_collection_tasks_retry (retry_of_task_id),
  CONSTRAINT fk_collection_tasks_source FOREIGN KEY (data_source_id) REFERENCES data_sources (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_collection_tasks_brand_source FOREIGN KEY (brand_id, data_source_id) REFERENCES brands (id, data_source_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_collection_tasks_retry FOREIGN KEY (retry_of_task_id) REFERENCES collection_tasks (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_collection_tasks_trigger CHECK (trigger_type IN ('manual', 'scheduled', 'retry')),
  CONSTRAINT chk_collection_tasks_status CHECK (status IN ('queued', 'running', 'success', 'partial_success', 'failed'))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS posts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  data_source_id BIGINT UNSIGNED NOT NULL,
  platform_post_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_url TEXT NOT NULL,
  title TEXT NULL,
  description MEDIUMTEXT NULL,
  author_nickname VARCHAR(255) NULL,
  ip_location VARCHAR(191) NULL,
  published_at DATETIME(3) NULL,
  platform_updated_at DATETIME(3) NULL,
  displayed_time VARCHAR(191) NULL,
  tags JSON NULL,
  image_urls JSON NULL,
  availability_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'available',
  first_collected_at DATETIME(3) NOT NULL,
  last_collected_at DATETIME(3) NOT NULL,
  last_successful_task_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_posts_source_platform_id (data_source_id, platform_post_id),
  UNIQUE KEY uq_posts_id_source (id, data_source_id),
  KEY idx_posts_collected_time (last_collected_at),
  KEY idx_posts_published_time (published_at),
  KEY idx_posts_task (last_successful_task_id),
  CONSTRAINT fk_posts_source FOREIGN KEY (data_source_id) REFERENCES data_sources (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_posts_task FOREIGN KEY (last_successful_task_id) REFERENCES collection_tasks (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_posts_availability CHECK (availability_status IN ('available', 'temporarily_unavailable'))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS comments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  data_source_id BIGINT UNSIGNED NOT NULL,
  post_id BIGINT UNSIGNED NOT NULL,
  platform_comment_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  parent_comment_id BIGINT UNSIGNED NULL,
  platform_parent_comment_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  platform_target_comment_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  content MEDIUMTEXT NULL,
  author_nickname VARCHAR(255) NULL,
  published_text VARCHAR(191) NULL,
  ip_location VARCHAR(191) NULL,
  availability_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'available',
  first_collected_at DATETIME(3) NOT NULL,
  last_collected_at DATETIME(3) NOT NULL,
  last_successful_task_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_comments_source_platform_id (data_source_id, platform_comment_id),
  UNIQUE KEY uq_comments_id_source (id, data_source_id),
  KEY idx_comments_post_time (post_id, last_collected_at),
  KEY idx_comments_parent (parent_comment_id),
  KEY idx_comments_platform_parent (data_source_id, platform_parent_comment_id),
  KEY idx_comments_task (last_successful_task_id),
  CONSTRAINT fk_comments_source FOREIGN KEY (data_source_id) REFERENCES data_sources (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_comments_post_source FOREIGN KEY (post_id, data_source_id) REFERENCES posts (id, data_source_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_comments_parent_source FOREIGN KEY (parent_comment_id, data_source_id) REFERENCES comments (id, data_source_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_comments_task FOREIGN KEY (last_successful_task_id) REFERENCES collection_tasks (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_comments_availability CHECK (availability_status IN ('available', 'temporarily_unavailable'))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS post_interaction_snapshots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id BIGINT UNSIGNED NOT NULL,
  post_id BIGINT UNSIGNED NOT NULL,
  liked_count BIGINT UNSIGNED NULL,
  collected_count BIGINT UNSIGNED NULL,
  comment_count BIGINT UNSIGNED NULL,
  share_count BIGINT UNSIGNED NULL,
  observed_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_post_snapshots_task_post (task_id, post_id),
  KEY idx_post_snapshots_post_time (post_id, observed_at),
  CONSTRAINT fk_post_snapshots_task FOREIGN KEY (task_id) REFERENCES collection_tasks (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_post_snapshots_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS comment_interaction_snapshots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id BIGINT UNSIGNED NOT NULL,
  comment_id BIGINT UNSIGNED NOT NULL,
  liked_count BIGINT UNSIGNED NULL,
  observed_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_comment_snapshots_task_comment (task_id, comment_id),
  KEY idx_comment_snapshots_comment_time (comment_id, observed_at),
  CONSTRAINT fk_comment_snapshots_task FOREIGN KEY (task_id) REFERENCES collection_tasks (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_comment_snapshots_comment FOREIGN KEY (comment_id) REFERENCES comments (id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS raw_field_snapshots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id BIGINT UNSIGNED NOT NULL,
  post_id BIGINT UNSIGNED NULL,
  comment_id BIGINT UNSIGNED NULL,
  snapshot_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload JSON NOT NULL,
  redaction_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  collected_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_raw_snapshots_task_post (task_id, post_id, snapshot_kind),
  UNIQUE KEY uq_raw_snapshots_task_comment (task_id, comment_id, snapshot_kind),
  KEY idx_raw_snapshots_post_time (post_id, collected_at),
  KEY idx_raw_snapshots_comment_time (comment_id, collected_at),
  KEY idx_raw_snapshots_task (task_id),
  CONSTRAINT fk_raw_snapshots_task FOREIGN KEY (task_id) REFERENCES collection_tasks (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_raw_snapshots_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_raw_snapshots_comment FOREIGN KEY (comment_id) REFERENCES comments (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_raw_snapshot_target CHECK ((post_id IS NOT NULL AND comment_id IS NULL) OR (post_id IS NULL AND comment_id IS NOT NULL)),
  CONSTRAINT chk_raw_snapshot_kind CHECK (snapshot_kind IN ('post', 'comment'))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS brand_post_matches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  data_source_id BIGINT UNSIGNED NOT NULL,
  brand_id BIGINT UNSIGNED NOT NULL,
  search_term_id BIGINT UNSIGNED NOT NULL,
  post_id BIGINT UNSIGNED NOT NULL,
  first_matched_task_id BIGINT UNSIGNED NOT NULL,
  matched_term_snapshot VARCHAR(255) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_brand_post_matches (brand_id, search_term_id, post_id),
  KEY idx_brand_post_matches_brand_post (brand_id, post_id),
  KEY idx_brand_post_matches_task (first_matched_task_id),
  CONSTRAINT fk_matches_brand_source FOREIGN KEY (brand_id, data_source_id) REFERENCES brands (id, data_source_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_matches_term_brand FOREIGN KEY (search_term_id, brand_id) REFERENCES brand_search_terms (id, brand_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_matches_post_source FOREIGN KEY (post_id, data_source_id) REFERENCES posts (id, data_source_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_matches_task FOREIGN KEY (first_matched_task_id) REFERENCES collection_tasks (id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS collection_cursors (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  data_source_id BIGINT UNSIGNED NOT NULL,
  brand_id BIGINT UNSIGNED NOT NULL,
  stage_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scope_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  cursor_value JSON NOT NULL,
  last_successful_task_id BIGINT UNSIGNED NOT NULL,
  cursor_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  advanced_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_collection_cursors_scope (data_source_id, brand_id, stage_code, scope_key),
  KEY idx_collection_cursors_task (last_successful_task_id),
  CONSTRAINT fk_collection_cursors_brand_source FOREIGN KEY (brand_id, data_source_id) REFERENCES brands (id, data_source_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_collection_cursors_task FOREIGN KEY (last_successful_task_id) REFERENCES collection_tasks (id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS collection_locks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  data_source_id BIGINT UNSIGNED NOT NULL,
  brand_id BIGINT UNSIGNED NOT NULL,
  owner_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  task_id BIGINT UNSIGNED NOT NULL,
  lease_expires_at DATETIME(3) NOT NULL,
  acquired_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_collection_locks_source_brand (data_source_id, brand_id),
  UNIQUE KEY uq_collection_locks_owner (owner_token),
  KEY idx_collection_locks_expiry (lease_expires_at),
  KEY idx_collection_locks_task (task_id),
  CONSTRAINT fk_collection_locks_brand_source FOREIGN KEY (brand_id, data_source_id) REFERENCES brands (id, data_source_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_collection_locks_task FOREIGN KEY (task_id) REFERENCES collection_tasks (id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
-- statement-breakpoint
INSERT INTO data_sources (source_code, display_name, source_type, status)
VALUES ('xiaohongshu', '小红书', 'social_content', 'enabled')
ON DUPLICATE KEY UPDATE source_code = 'xiaohongshu'
-- statement-breakpoint
DROP TRIGGER IF EXISTS trg_collection_tasks_require_enabled_brand
-- statement-breakpoint
CREATE TRIGGER trg_collection_tasks_require_enabled_brand
BEFORE INSERT ON collection_tasks
FOR EACH ROW
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM brands
    WHERE id = NEW.brand_id
      AND data_source_id = NEW.data_source_id
      AND status = 'enabled'
      AND archived_at IS NULL
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'collection_task_brand_not_enabled';
  END IF;
END
