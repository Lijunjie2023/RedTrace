CREATE TABLE IF NOT EXISTS classification_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  classification_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  item_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(191) NOT NULL,
  description VARCHAR(500) NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'enabled',
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_classification_items_type_code (classification_type, item_code),
  KEY idx_classification_items_list (classification_type, status, sort_order, id),
  CONSTRAINT chk_classification_items_type CHECK (classification_type IN ('category', 'problem_type', 'topic')),
  CONSTRAINT chk_classification_items_status CHECK (status IN ('enabled', 'disabled'))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS analysis_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  content_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  post_id BIGINT UNSIGNED NULL,
  comment_id BIGINT UNSIGNED NULL,
  input_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  model_name VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  prompt_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  taxonomy_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'running',
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  sentiment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  content_nature VARCHAR(191) NULL,
  category_id BIGINT UNSIGNED NULL,
  product_series VARCHAR(191) NULL,
  product_model VARCHAR(191) NULL,
  user_stage VARCHAR(191) NULL,
  risk_level VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  confidence VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  result_json JSON NULL,
  prompt_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  completion_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  total_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_summary VARCHAR(500) NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_analysis_records_idempotency (idempotency_key),
  KEY idx_analysis_records_post_current (post_id, status, completed_at, id),
  KEY idx_analysis_records_comment_current (comment_id, status, completed_at, id),
  KEY idx_analysis_records_status (status, updated_at),
  KEY idx_analysis_records_category (category_id, status),
  CONSTRAINT fk_analysis_records_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_analysis_records_comment FOREIGN KEY (comment_id) REFERENCES comments (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_analysis_records_category FOREIGN KEY (category_id) REFERENCES classification_items (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_analysis_records_target CHECK (
    (content_type = 'post' AND post_id IS NOT NULL AND comment_id IS NULL)
    OR (content_type = 'comment' AND post_id IS NULL AND comment_id IS NOT NULL)
  ),
  CONSTRAINT chk_analysis_records_status CHECK (status IN ('running', 'success', 'failed')),
  CONSTRAINT chk_analysis_records_sentiment CHECK (sentiment IS NULL OR sentiment IN ('positive', 'neutral', 'negative', 'unknown')),
  CONSTRAINT chk_analysis_records_risk CHECK (risk_level IS NULL OR risk_level IN ('normal', 'watch', 'high_risk')),
  CONSTRAINT chk_analysis_records_confidence CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low'))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS analysis_problem_types (
  analysis_record_id BIGINT UNSIGNED NOT NULL,
  classification_item_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (analysis_record_id, classification_item_id),
  KEY idx_analysis_problem_types_item (classification_item_id, analysis_record_id),
  CONSTRAINT fk_analysis_problem_types_record FOREIGN KEY (analysis_record_id) REFERENCES analysis_records (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_analysis_problem_types_item FOREIGN KEY (classification_item_id) REFERENCES classification_items (id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS analysis_topics (
  analysis_record_id BIGINT UNSIGNED NOT NULL,
  classification_item_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (analysis_record_id, classification_item_id),
  KEY idx_analysis_topics_item (classification_item_id, analysis_record_id),
  CONSTRAINT fk_analysis_topics_record FOREIGN KEY (analysis_record_id) REFERENCES analysis_records (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_analysis_topics_item FOREIGN KEY (classification_item_id) REFERENCES classification_items (id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS manual_corrections (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  content_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  post_id BIGINT UNSIGNED NULL,
  comment_id BIGINT UNSIGNED NULL,
  patch_json JSON NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  corrected_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_manual_corrections_post (post_id),
  UNIQUE KEY uq_manual_corrections_comment (comment_id),
  KEY idx_manual_corrections_active (content_type, deleted_at),
  CONSTRAINT fk_manual_corrections_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_manual_corrections_comment FOREIGN KEY (comment_id) REFERENCES comments (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_manual_corrections_target CHECK (
    (content_type = 'post' AND post_id IS NOT NULL AND comment_id IS NULL)
    OR (content_type = 'comment' AND post_id IS NULL AND comment_id IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
-- statement-breakpoint
INSERT INTO classification_items (classification_type, item_code, display_name, description, sort_order)
VALUES
  ('category', 'air_conditioner', '空调', NULL, 10),
  ('category', 'refrigerator', '冰箱', NULL, 20),
  ('category', 'washing_machine', '洗衣机', NULL, 30),
  ('category', 'water_heater', '热水器', NULL, 40),
  ('category', 'kitchen_appliance', '厨电', NULL, 50),
  ('problem_type', 'product_quality', '产品质量', '故障、损坏或耐用性问题', 10),
  ('problem_type', 'performance', '使用效果', '核心功能或性能未达到预期', 20),
  ('problem_type', 'noise', '噪音', NULL, 30),
  ('problem_type', 'installation', '安装问题', NULL, 40),
  ('problem_type', 'after_sales', '售后服务', NULL, 50),
  ('problem_type', 'logistics', '物流问题', NULL, 60),
  ('problem_type', 'price', '价格争议', NULL, 70),
  ('topic', 'cooling_heating_effect', '制冷制热效果', NULL, 10),
  ('topic', 'installation_experience', '安装体验', NULL, 20),
  ('topic', 'after_sales_response', '售后响应', NULL, 30),
  ('topic', 'product_reliability', '产品可靠性', NULL, 40),
  ('topic', 'noise_experience', '噪音体验', NULL, 50)
ON DUPLICATE KEY UPDATE item_code = VALUES(item_code)
