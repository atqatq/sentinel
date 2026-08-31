-- 0006_open_po_status — the M5 supply-status producer's status surface (§14.6c).
--
-- The audit's M5: the supply axis consumed `status`-bearing facts no export
-- defined and no code derived. §14.6c makes the producers normative and adds
-- `Purchase Order Status` to the Open-POs export (priority-1 ADD, cutover W1).
-- This column is where the normalized vocabulary lands:
--   'OPEN' | 'CANCELLED' | 'CLOSED' | NULL
-- NULL = the feed did not carry the column — §14.6c's live-line degradation
-- (disclosed at the run, never silently absorbed). Any other value is a
-- wiring error: ingestion quarantines it (PO_STATUS_UNKNOWN), so it can
-- never be stored; the producer refuses it fail-closed all the same.

ALTER TABLE "open_po_line" ADD COLUMN "status" TEXT;

COMMENT ON COLUMN "open_po_line"."status" IS
  'Purchase Order Status surface (§14.6c): OPEN | CANCELLED | CLOSED | NULL (feed omitted the column — live-line degradation, disclosed at the run)';
