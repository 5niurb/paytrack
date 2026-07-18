-- LM PayTrack Database Schema for Supabase
-- Run this SQL in Supabase SQL Editor to create the database tables
-- Last updated: 2026-04-16 (synced with production schema)
--
-- NOTE: RLS is intentionally ENABLED on employees and employee_onboarding
-- to block direct anon-key access (Supabase security advisory). The Express
-- server uses the service-role key (supabaseAdmin) which bypasses RLS.
-- Do NOT disable RLS on these tables — that re-exposes employee data publicly.
-- Other tables (time_entries, invoices, etc.) do not require RLS as they
-- contain no PII that could be exploited without also knowing employee IDs.

-- ============ CORE TABLES ============

CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  pin TEXT NOT NULL UNIQUE,
  email TEXT,
  phone TEXT,
  hourly_wage DECIMAL(10,2) DEFAULT 0,
  additional_pay_rate DECIMAL(10,2),
  rate_notes TEXT,
  commission_rate DECIMAL(10,2) DEFAULT 0,
  pay_type TEXT DEFAULT 'hourly',
  designation TEXT,
  contractor_type TEXT,
  start_date DATE,
  ic_agreement_signed BOOLEAN DEFAULT FALSE,
  ic_agreement_signed_at TIMESTAMP WITH TIME ZONE,
  onboarding_token TEXT,
  onboarding_completed_at TIMESTAMP WITH TIME ZONE,
  status TEXT DEFAULT 'active',                    -- 'active' | 'inactive'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS time_entries (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  date DATE NOT NULL,
  start_time TEXT,
  end_time TEXT,
  break_minutes INTEGER DEFAULT 0,
  staff_treatment_minutes INTEGER DEFAULT 0,
  hours DECIMAL(10,2) NOT NULL,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_entries (
  id SERIAL PRIMARY KEY,
  time_entry_id INTEGER NOT NULL REFERENCES time_entries(id),
  client_name TEXT NOT NULL,
  procedure_name TEXT,
  notes TEXT,
  amount_earned DECIMAL(10,2) DEFAULT 0,
  tip_amount DECIMAL(10,2) DEFAULT 0,
  tip_received_cash BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_sales (
  id SERIAL PRIMARY KEY,
  time_entry_id INTEGER NOT NULL REFERENCES time_entries(id),
  product_name TEXT NOT NULL,
  sale_amount DECIMAL(10,2) DEFAULT 0,
  commission_amount DECIMAL(10,2) DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  pay_period_start DATE NOT NULL,
  pay_period_end DATE NOT NULL,
  total_hours DECIMAL(10,2) DEFAULT 0,
  total_wages DECIMAL(10,2) DEFAULT 0,
  total_commissions DECIMAL(10,2) DEFAULT 0,
  total_tips DECIMAL(10,2) DEFAULT 0,
  total_product_commissions DECIMAL(10,2) DEFAULT 0,
  cash_tips_received DECIMAL(10,2) DEFAULT 0,
  total_payable DECIMAL(10,2) DEFAULT 0,
  submitted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  email_sent BOOLEAN DEFAULT FALSE
);

-- ============ ONBOARDING TABLE ============
-- Stores W-9, ID, license, insurance, banking info collected during worker onboarding.
-- Sensitive fields (TIN, routing, account) are AES-256-GCM encrypted server-side.
-- Only last-4 digits are stored in plaintext for display; encrypted blobs are opaque.

CREATE TABLE IF NOT EXISTS employee_onboarding (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

  -- Personal info
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  middle_name TEXT,
  preferred_name TEXT,
  mobile_phone TEXT,
  date_of_birth DATE,

  -- Address
  address_street TEXT,
  address_city TEXT,
  address_state TEXT,
  address_zip TEXT,

  -- W-9 / Tax
  tin_type TEXT,                           -- 'ssn' or 'ein'
  tin_last4 TEXT,                          -- last 4 digits, plaintext
  tin_encrypted TEXT,                      -- AES-256-GCM encrypted TIN
  w9_entity_name TEXT,
  w9_tax_classification TEXT,
  w9_collected_at TIMESTAMP WITH TIME ZONE,

  -- Driver's license / Gov ID
  driver_license_number TEXT,
  driver_license_state TEXT,
  driver_license_upload_path TEXT,         -- Supabase Storage path

  -- Professional licenses (JSONB array of license objects)
  professional_licenses JSONB,

  -- Insurance (professional liability)
  insurer_name TEXT,
  insurance_policy_number TEXT,
  insurance_expiration DATE,
  insurance_upload_path TEXT,              -- Supabase Storage path
  prof_liability_per_occurrence NUMERIC,
  prof_liability_aggregate NUMERIC,

  -- Banking / payment
  bank_name TEXT,
  bank_account_owner_name TEXT,
  bank_account_type TEXT,                  -- 'checking' or 'savings'
  bank_routing_last4 TEXT,
  bank_account_last4 TEXT,
  bank_routing_encrypted TEXT,             -- AES-256-GCM; null for Zelle path
  bank_account_encrypted TEXT,             -- AES-256-GCM; null for Zelle path
  payment_method TEXT,                     -- 'zelle' or 'ach'
  zelle_contact TEXT,

  -- Schedule
  time_commitment_bucket TEXT,             -- 'under_15' | '15_to_25' | '25_to_35' | 'over_35'
  other_commitments TEXT,

  -- Attestation (IC agreement)
  attestation_checked BOOLEAN NOT NULL DEFAULT FALSE,
  attestation_signature TEXT NOT NULL,
  attestation_date DATE NOT NULL,

  submitted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============ EMPLOYEE DOCUMENTS TABLE ============
-- Admin-uploaded compliance docs (ID, insurance, W9, contracts) per employee.
-- Separate from employee_onboarding (which requires worker attestation).

CREATE TABLE IF NOT EXISTS employee_documents (
  id            bigint      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  employee_id   integer     NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  document_type text        NOT NULL, -- 'driver_license' | 'insurance' | 'w9' | 'professional_license' | 'contract' | 'other'
  file_path     text        NOT NULL, -- Supabase Storage path (bucket: onboarding-documents)
  file_name     text,                 -- original filename
  notes         text,
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE employee_documents ENABLE ROW LEVEL SECURITY;

-- ============ TAX FILINGS TABLE ============
-- Stores 1099-NEC and other annual tax filing data.
-- Maps to Avalara/Track1099 CSV template columns.
-- Designed for 10+ years of historical data per contractor.
-- TIN is AES-256-GCM encrypted server-side; only last-4 stored in plaintext.

CREATE TABLE IF NOT EXISTS tax_filings (
  id                          bigint      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  employee_id                 integer     REFERENCES employees(id) ON DELETE SET NULL,
  tax_year                    smallint    NOT NULL,
  form_type                   text        NOT NULL DEFAULT '1099-NEC',
  filing_status               text        NOT NULL DEFAULT 'draft', -- draft | ready | filed | corrected
  filed_at                    timestamptz,

  -- Payer info
  payer_name                  text        NOT NULL DEFAULT 'LM Operations Inc',
  payer_ein                   text,
  payer_state_no              text,

  -- Recipient identity
  reference_id                text,
  recipient_name              text        NOT NULL,
  recipient_second_name       text,
  federal_id_type             smallint,   -- 1=EIN 2=SSN 3=ITIN 4=ATIN
  tin_last4                   text,
  tin_encrypted               text,       -- AES-256-GCM encrypted TIN
  second_tin_notice           boolean     NOT NULL DEFAULT false,
  account_number              text,
  office_code                 text,

  -- Address
  address_street              text,
  address_street2             text,
  address_city                text,
  address_state               text,
  address_zip                 text,
  address_province            text,
  address_country_code        text        DEFAULT 'US',
  recipient_email             text,

  -- 1099-NEC boxes
  box_1_nonemployee_comp      numeric(12,2) NOT NULL DEFAULT 0,
  box_2_direct_sales          boolean     NOT NULL DEFAULT false,
  box_3_golden_parachute      numeric(12,2),
  box_4_federal_tax_withheld  numeric(12,2),
  box_5_state_tax_withheld    numeric(12,2),
  box_6_state                 text,
  box_7_state_income          numeric(12,2),
  box_5b_local_tax_withheld   numeric(12,2),
  box_6b_locality             text,
  box_6b_locality_no          text,
  box_7b_local_income         numeric(12,2),

  source                      text,       -- 'manual' | 'csv_import' | 'calculated'
  notes                       text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- Prevent duplicate filings for the same employee+year+form combination
CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_filings_unique_filing
  ON tax_filings (employee_id, tax_year, form_type)
  WHERE employee_id IS NOT NULL;

ALTER TABLE tax_filings ENABLE ROW LEVEL SECURITY;

-- ============ INDEXES ============

CREATE INDEX IF NOT EXISTS idx_time_entries_employee_id ON time_entries(employee_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_date ON time_entries(date);
CREATE INDEX IF NOT EXISTS idx_client_entries_time_entry_id ON client_entries(time_entry_id);
CREATE INDEX IF NOT EXISTS idx_product_sales_time_entry_id ON product_sales(time_entry_id);
CREATE INDEX IF NOT EXISTS idx_invoices_employee_id ON invoices(employee_id);
CREATE INDEX IF NOT EXISTS idx_invoices_pay_period ON invoices(pay_period_start, pay_period_end);
CREATE INDEX IF NOT EXISTS idx_onboarding_employee_id ON employee_onboarding(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_documents_employee_id ON employee_documents(employee_id);
CREATE INDEX IF NOT EXISTS idx_employees_onboarding_token ON employees(onboarding_token);
CREATE INDEX IF NOT EXISTS idx_tax_filings_employee_id ON tax_filings(employee_id);
CREATE INDEX IF NOT EXISTS idx_tax_filings_year ON tax_filings(tax_year);

-- ============ RLS ============
-- Enable RLS on sensitive tables to block direct anon-key access.
-- Server uses service-role key which bypasses RLS — no policies needed.

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_onboarding ENABLE ROW LEVEL SECURITY;

-- ============ GRANTS ============

GRANT ALL ON employees TO anon, authenticated;
GRANT ALL ON time_entries TO anon, authenticated;
GRANT ALL ON client_entries TO anon, authenticated;
GRANT ALL ON product_sales TO anon, authenticated;
GRANT ALL ON invoices TO anon, authenticated;
GRANT ALL ON employee_onboarding TO anon, authenticated;
GRANT ALL ON employee_documents TO anon, authenticated;
GRANT ALL ON tax_filings TO anon, authenticated;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

-- ============ SAMPLE DATA ============

INSERT INTO employees (name, pin, hourly_wage, pay_type)
VALUES ('Sample Employee', '1234', 15.00, 'hourly')
ON CONFLICT (pin) DO NOTHING;

-- ============ Migration 007: Compliance schema ============
-- Added 2026-05-05: compliance document tracking workflow (COI, W9, contract)
-- NOTE: employee_id uses INTEGER to match employees.id SERIAL PRIMARY KEY
-- NOTE: Single-use enforcement for tokens is application-enforced in routes/compliance.js

-- Token-based compliance requests (one per active link)
CREATE TABLE IF NOT EXISTS compliance_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id integer NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('upload', 'esign')),
  document_type text NOT NULL CHECK (document_type IN ('coi', 'w9', 'contract')),
  token text UNIQUE NOT NULL DEFAULT gen_random_uuid()::text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compliance_requests_token ON compliance_requests(token);
CREATE INDEX IF NOT EXISTS idx_compliance_requests_employee ON compliance_requests(employee_id);

ALTER TABLE compliance_requests ENABLE ROW LEVEL SECURITY;

-- Document records (one per submitted document)
CREATE TABLE IF NOT EXISTS compliance_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id integer NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  document_type text NOT NULL CHECK (document_type IN ('coi', 'w9', 'contract')),
  storage_path text,

  -- COI extracted fields
  insurer_name text,
  policy_number text,
  expiration_date date,
  per_occurrence numeric(12,2),
  aggregate numeric(12,2),

  -- Raw AI output + worker edits
  ai_extracted jsonb,
  worker_confirmed_at timestamptz,
  worker_edits jsonb,

  -- Admin review
  admin_approved_at timestamptz,
  admin_approved_by text,
  admin_action text CHECK (admin_action IN ('approved', 'edited', 'rejected')),

  -- Workflow state
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'extracted', 'worker_confirmed', 'approved', 'rejected')),

  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compliance_docs_employee ON compliance_documents(employee_id);
CREATE INDEX IF NOT EXISTS idx_compliance_docs_status ON compliance_documents(status);
CREATE INDEX IF NOT EXISTS idx_compliance_docs_type ON compliance_documents(document_type);

ALTER TABLE compliance_documents ENABLE ROW LEVEL SECURITY;

GRANT ALL ON compliance_requests TO anon, authenticated;
GRANT ALL ON compliance_documents TO anon, authenticated;

-- Add compliance columns to employees
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS coi_expiry date,
  ADD COLUMN IF NOT EXISTS coi_insurer text,
  ADD COLUMN IF NOT EXISTS professional_license_number text,
  ADD COLUMN IF NOT EXISTS professional_license_type text,
  ADD COLUMN IF NOT EXISTS professional_license_expiry date,
  ADD COLUMN IF NOT EXISTS w9_signed boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS contract_signed boolean DEFAULT false;
