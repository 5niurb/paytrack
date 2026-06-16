-- ============================================================
-- Migration 002: Worker Self-Onboarding
-- Run in Supabase SQL Editor
-- Created: 2026-04-16
-- ============================================================

-- ============================================================
-- PART 1: Extend employees table
-- ============================================================

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS designation TEXT,
  ADD COLUMN IF NOT EXISTS contractor_type TEXT,
  ADD COLUMN IF NOT EXISTS start_date DATE,
  ADD COLUMN IF NOT EXISTS ic_agreement_signed BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS ic_agreement_signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_token TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_employees_onboarding_token ON employees(onboarding_token);

-- ============================================================
-- PART 2: employee_onboarding table
-- Stores the full IC onboarding packet submitted by the worker.
-- Sensitive fields (SSN, bank routing/account) are stored as
-- last-4 masks in plain columns; the *_encrypted columns hold
-- AES-256-GCM ciphertext produced at the application layer
-- (lib/crypto.js, key = PAYTRACK_ENCRYPTION_KEY). All read/write
-- paths in server.js encrypt via encryptValue() before insert.
-- ============================================================

CREATE TABLE IF NOT EXISTS employee_onboarding (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

  -- Identity
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  middle_name TEXT,
  preferred_name TEXT,
  other_email TEXT,
  home_phone TEXT,
  work_phone TEXT,
  date_of_birth DATE,

  -- Address
  address_street TEXT,
  address_city TEXT,
  address_state TEXT,
  address_zip TEXT,

  -- Tax / W-9
  tin_last4 TEXT,           -- last 4 digits of SSN/EIN — always stored
  tin_type TEXT,            -- 'SSN' or 'EIN'
  tin_encrypted TEXT,       -- AES-256-GCM ciphertext (lib/crypto.js)
  w9_entity_name TEXT,
  w9_tax_classification TEXT,
  w9_exempt_payee_code TEXT,
  w9_signed_at DATE,
  w9_collected_at TIMESTAMPTZ DEFAULT NOW(),

  -- License / Certifications
  license_number TEXT,
  license_expiration DATE,
  certifications TEXT,
  driver_license_no TEXT,
  driver_license_expiry DATE,

  -- Insurance
  insurer_name TEXT,
  insurance_expiration DATE,
  prof_liability_per_occurrence DECIMAL(12,2),
  prof_liability_aggregate DECIMAL(12,2),

  -- Banking
  bank_name TEXT,
  bank_account_owner_name TEXT,
  bank_account_type TEXT,    -- 'checking' or 'savings'
  bank_routing_last4 TEXT,   -- last 4 of routing — always stored
  bank_account_last4 TEXT,   -- last 4 of account — always stored
  bank_routing_encrypted TEXT,  -- AES-256-GCM ciphertext (lib/crypto.js)
  bank_account_encrypted TEXT,  -- AES-256-GCM ciphertext (lib/crypto.js)
  payment_method TEXT,          -- 'direct_deposit' or 'zelle' or 'check'
  zelle_contact TEXT,

  -- Contract / Work Details
  time_commitment_hours_per_week INTEGER,
  services_offered TEXT[],
  other_commitments TEXT,
  exhibit_a_rate DECIMAL(10,2),
  exhibit_a_rate_notes TEXT,

  -- Attestation
  attestation_checked BOOLEAN NOT NULL DEFAULT false,
  attestation_signature TEXT NOT NULL,   -- typed name
  attestation_date DATE NOT NULL,

  -- Metadata
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employee_onboarding_employee_id ON employee_onboarding(employee_id);

-- Grant access
GRANT ALL ON employee_onboarding TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE employee_onboarding_id_seq TO anon, authenticated;

-- ============================================================
-- ROLLBACK (paste separately if needed)
-- ============================================================
-- ALTER TABLE employees
--   DROP COLUMN IF EXISTS phone,
--   DROP COLUMN IF EXISTS designation,
--   DROP COLUMN IF EXISTS contractor_type,
--   DROP COLUMN IF EXISTS start_date,
--   DROP COLUMN IF EXISTS ic_agreement_signed,
--   DROP COLUMN IF EXISTS ic_agreement_signed_at,
--   DROP COLUMN IF EXISTS onboarding_token,
--   DROP COLUMN IF EXISTS onboarding_completed_at;
-- DROP TABLE IF EXISTS employee_onboarding;
-- DROP INDEX IF EXISTS idx_employees_onboarding_token;
