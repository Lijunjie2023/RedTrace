ALTER TABLE analysis_records
  ADD COLUMN owner_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER idempotency_key,
  ADD COLUMN lease_expires_at DATETIME(3) NULL AFTER owner_token,
  ADD UNIQUE KEY uq_analysis_records_owner_token (owner_token),
  ADD KEY idx_analysis_records_claim (status, lease_expires_at)
