-- Audit log is append-only: reject UPDATE/DELETE at the database level.
CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

-- Terminal events are append-only as well (session recordings must not be edited).
DROP TRIGGER IF EXISTS terminal_events_no_update ON terminal_events;
CREATE TRIGGER terminal_events_no_update BEFORE UPDATE OR DELETE ON terminal_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

-- Row Level Security as defence in depth. The application connects as the table
-- owner in the default setup (RLS bypassed); when a dedicated app role is used,
-- set `app.current_tenant` per transaction and these policies apply.
ALTER TABLE ssh_hosts ENABLE ROW LEVEL SECURITY;
ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE terminal_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_conversations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_hosts ON ssh_hosts;
CREATE POLICY tenant_isolation_hosts ON ssh_hosts USING (org_id::text = current_setting('app.current_tenant', true) OR current_setting('app.current_tenant', true) IS NULL);
DROP POLICY IF EXISTS tenant_isolation_credentials ON credentials;
CREATE POLICY tenant_isolation_credentials ON credentials USING (org_id::text = current_setting('app.current_tenant', true) OR current_setting('app.current_tenant', true) IS NULL);
DROP POLICY IF EXISTS tenant_isolation_sessions ON terminal_sessions;
CREATE POLICY tenant_isolation_sessions ON terminal_sessions USING (org_id::text = current_setting('app.current_tenant', true) OR current_setting('app.current_tenant', true) IS NULL);
DROP POLICY IF EXISTS tenant_isolation_conversations ON agent_conversations;
CREATE POLICY tenant_isolation_conversations ON agent_conversations USING (org_id::text = current_setting('app.current_tenant', true) OR current_setting('app.current_tenant', true) IS NULL);
