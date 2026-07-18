-- 012_staff_treatment_minutes.sql
-- Adds non-billable "Self Treat" time to time_entries.
--
-- Staff sometimes receive free/discounted treatments while onsite. That time is
-- NOT billable, so they are meant to "clock out" for it. This column captures
-- those minutes, parallel to break_minutes. Both are subtracted from onsite
-- duration to arrive at billable `hours` (which is still computed client-side and
-- stored net, exactly as break_minutes has always worked — no server-side re-derivation).
--
-- Apply via Supabase SQL Editor or the /migrate skill. Safe/idempotent.

ALTER TABLE time_entries
  ADD COLUMN IF NOT EXISTS staff_treatment_minutes INTEGER DEFAULT 0;
