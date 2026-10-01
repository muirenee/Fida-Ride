-- Fida-Ride administrative identity schema v11
-- PostgreSQL 15+
--
-- Administrative identities are intentionally separate from rider/driver identities.
-- Password material is stored only as Argon2id PHC strings. No default administrator
-- account is created by this migration.

BEGIN;

SET LOCAL search_path TO core, public;

CREATE TABLE IF NOT EXISTS core.admin_accounts (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username            VARCHAR(128) NOT NULL,
    password_hash       TEXT NOT NULL,
    role                VARCHAR(32) NOT NULL,
    permissions         VARCHAR(128)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(128)[],
    status              VARCHAR(16) NOT NULL DEFAULT 'active',
    failed_login_count  INTEGER NOT NULL DEFAULT 0,
    locked_until        TIMESTAMPTZ,
    last_login_at       TIMESTAMPTZ,
    password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_admin_accounts_role
        CHECK (role IN ('super_admin', 'operations_admin', 'finance_admin', 'security_admin', 'support_admin')),
    CONSTRAINT chk_admin_accounts_status
        CHECK (status IN ('active', 'disabled')),
    CONSTRAINT chk_admin_accounts_failed_login_count
        CHECK (failed_login_count >= 0),
    CONSTRAINT chk_admin_accounts_password_hash
        CHECK (password_hash LIKE '$argon2id$%'),
    CONSTRAINT chk_admin_accounts_permissions_cardinality
        CHECK (cardinality(permissions) <= 128)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_accounts_username_ci
    ON core.admin_accounts (LOWER(username));

CREATE INDEX IF NOT EXISTS idx_admin_accounts_active_username
    ON core.admin_accounts (LOWER(username))
    WHERE status = 'active';

CREATE OR REPLACE FUNCTION core.touch_admin_account_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_admin_accounts_touch_updated_at
    ON core.admin_accounts;

CREATE TRIGGER trg_admin_accounts_touch_updated_at
BEFORE UPDATE ON core.admin_accounts
FOR EACH ROW
EXECUTE FUNCTION core.touch_admin_account_updated_at();

COMMIT;
