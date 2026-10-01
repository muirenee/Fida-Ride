-- Fida-Ride fraud/security schema v6
-- PostgreSQL 15+
--
-- Adds explicit security-hold states and an append-only audit trail.
-- Risk scores remain short-lived in Redis; PostgreSQL stores durable decisions/evidence.

BEGIN;

SET LOCAL search_path TO core, public;

ALTER TABLE core.users
    DROP CONSTRAINT IF EXISTS chk_users_status;

ALTER TABLE core.users
    ADD CONSTRAINT chk_users_status
    CHECK (status IN ('active', 'flagged', 'suspended', 'blocked', 'deleted'));

ALTER TABLE core.drivers
    DROP CONSTRAINT IF EXISTS chk_drivers_verification_status;

ALTER TABLE core.drivers
    ADD CONSTRAINT chk_drivers_verification_status
    CHECK (verification_status IN ('pending', 'approved', 'flagged', 'rejected', 'suspended'));

CREATE TABLE IF NOT EXISTS core.security_audit_logs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    actor_user_id   UUID,
    driver_id       UUID,
    device_hash     CHAR(64),
    request_id      VARCHAR(128),

    source          VARCHAR(32) NOT NULL,
    event_type      VARCHAR(64) NOT NULL,
    severity        VARCHAR(16) NOT NULL,
    action          VARCHAR(16) NOT NULL,

    risk_score      INTEGER NOT NULL DEFAULT 0,
    confidence      NUMERIC(5,4) NOT NULL DEFAULT 0.0000,

    reason_codes    JSONB NOT NULL DEFAULT '[]'::JSONB,
    metadata        JSONB NOT NULL DEFAULT '{}'::JSONB,

    CONSTRAINT chk_security_audit_severity
        CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
    CONSTRAINT chk_security_audit_action
        CHECK (action IN ('observe', 'flagged', 'suspended', 'blocked')),
    CONSTRAINT chk_security_audit_risk_score
        CHECK (risk_score >= 0),
    CONSTRAINT chk_security_audit_confidence
        CHECK (confidence >= 0.0000 AND confidence <= 1.0000),
    CONSTRAINT chk_security_audit_reason_codes_json
        CHECK (jsonb_typeof(reason_codes) = 'array'),
    CONSTRAINT chk_security_audit_metadata_json
        CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_security_audit_user_time
    ON core.security_audit_logs (actor_user_id, occurred_at DESC)
    WHERE actor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_security_audit_driver_time
    ON core.security_audit_logs (driver_id, occurred_at DESC)
    WHERE driver_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_security_audit_event_time
    ON core.security_audit_logs (event_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_security_audit_action_time
    ON core.security_audit_logs (action, occurred_at DESC)
    WHERE action <> 'observe';

CREATE OR REPLACE FUNCTION core.prevent_security_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'security_audit_logs is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_security_audit_no_update_delete
    ON core.security_audit_logs;

CREATE TRIGGER trg_security_audit_no_update_delete
BEFORE UPDATE OR DELETE ON core.security_audit_logs
FOR EACH ROW
EXECUTE FUNCTION core.prevent_security_audit_mutation();

COMMIT;
