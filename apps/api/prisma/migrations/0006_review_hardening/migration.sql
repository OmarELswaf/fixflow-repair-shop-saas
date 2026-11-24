-- Reviewed Phase 4 backstops. Apply as migration owner, not app role.
ALTER TABLE repair_orders ADD CONSTRAINT repair_assignment_membership_fk
  FOREIGN KEY ("tenantId", "assignedTechnicianId")
  REFERENCES memberships ("tenantId", "userId");
CREATE FUNCTION fixflow_reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'History is append-only' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER repair_events_append_only BEFORE UPDATE OR DELETE ON repair_events
  FOR EACH ROW EXECUTE FUNCTION fixflow_reject_history_mutation();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION fixflow_reject_history_mutation();
