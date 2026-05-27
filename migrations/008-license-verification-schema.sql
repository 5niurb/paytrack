-- Migration 008: Add license verification fields and indexes
-- Run in Supabase SQL Editor
--
-- If migration was partially applied, these manual fixes may be needed:
--   ALTER TABLE compliance_documents ADD COLUMN license_status text;
--   ALTER TABLE compliance_documents ADD COLUMN license_verified_at timestamptz;
--   ALTER TABLE compliance_documents ADD COLUMN license_profession text;
--   ALTER TABLE compliance_documents ADD COLUMN license_expiry_notified_at timestamptz;
--   CREATE INDEX IF NOT EXISTS idx_compliance_docs_status_doc_type ON compliance_documents(status, document_type);

-- Add license verification columns to compliance_documents
ALTER TABLE compliance_documents
  ADD COLUMN IF NOT EXISTS license_status text
    CHECK (license_status IN ('valid', 'expired', 'invalid', 'not_found')),
  ADD COLUMN IF NOT EXISTS license_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS license_profession text,
  ADD COLUMN IF NOT EXISTS license_expiry_notified_at timestamptz;

-- Create index for efficient compliance status queries
CREATE INDEX IF NOT EXISTS idx_compliance_docs_status_doc_type ON compliance_documents(status, document_type);

-- Add columns to employees for tracking signed status
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS last_compliance_scan timestamptz,
  ADD COLUMN IF NOT EXISTS compliance_scan_notes text;
