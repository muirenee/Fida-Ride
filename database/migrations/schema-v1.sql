-- Fida-Ride core relational schema v1
-- PostgreSQL 15+ with PostGIS enabled.
--
-- Design rules:
--   1. GPS geometry uses SRID 4326 (WGS 84).
--   2. Redis remains the real-time driver-location store; PostgreSQL persists
--      transactional/geospatial history.
--   3. Cached wallet balances are read optimizations only. The immutable,
--      posted double-entry ledger is the financial source of truth.

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE SCHEMA IF NOT EXISTS core AUTHORIZATION CURRENT_USER;

SET LOCAL search_path TO core, public;

-- -----------------------------------------------------------------------------
-- Shared timestamp trigger
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- Users
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.users (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    first_name          VARCHAR(100) NOT NULL,
    last_name           VARCHAR(100) NOT NULL,
    email               VARCHAR(320),
    phone               VARCHAR(32),

    -- Cached balance only; ledger is authoritative.
    wallet_balance      NUMERIC(19,4) NOT NULL DEFAULT 0,
    wallet_currency     CHAR(3) NOT NULL DEFAULT 'RWF',

    rating              NUMERIC(3,2) NOT NULL DEFAULT 5.00,
    status              VARCHAR(24) NOT NULL DEFAULT 'active',

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_users_identity_contact
        CHECK (email IS NOT NULL OR phone IS NOT NULL),
    CONSTRAINT chk_users_rating
        CHECK (rating >= 0.00 AND rating <= 5.00),
    CONSTRAINT chk_users_status
        CHECK (status IN ('active', 'suspended', 'blocked', 'deleted')),
    CONSTRAINT chk_users_wallet_currency
        CHECK (wallet_currency ~ '^[A-Z]{3}$')
);

-- PostgreSQL unique indexes are B-tree by default.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_ci
    ON core.users (LOWER(email))
    WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone
    ON core.users (phone)
    WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_status
    ON core.users (status);

DROP TRIGGER IF EXISTS trg_users_set_updated_at ON core.users;
CREATE TRIGGER trg_users_set_updated_at
BEFORE UPDATE ON core.users
FOR EACH ROW
EXECUTE FUNCTION core.set_updated_at();

-- -----------------------------------------------------------------------------
-- Drivers
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.drivers (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id                 UUID NOT NULL UNIQUE,
    vehicle_type            VARCHAR(32) NOT NULL,
    license_plate           VARCHAR(32) NOT NULL,
    verification_status     VARCHAR(24) NOT NULL DEFAULT 'pending',

    -- Cached balance only; ledger is authoritative.
    current_wallet_balance  NUMERIC(19,4) NOT NULL DEFAULT 0,
    wallet_currency         CHAR(3) NOT NULL DEFAULT 'RWF',

    -- Operational snapshot only. Real-time availability/location lives in Redis.
    is_online               BOOLEAN NOT NULL DEFAULT FALSE,
    is_available            BOOLEAN NOT NULL DEFAULT FALSE,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_drivers_user
        FOREIGN KEY (user_id)
        REFERENCES core.users(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_drivers_vehicle_type
        CHECK (vehicle_type IN (
            'taxi',
            'moto',
            'premium',
            'tuk_tuk',
            'ev',
            'accessible',
            'other'
        )),
    CONSTRAINT chk_drivers_verification_status
        CHECK (verification_status IN ('pending', 'approved', 'rejected', 'suspended')),
    CONSTRAINT chk_drivers_wallet_currency
        CHECK (wallet_currency ~ '^[A-Z]{3}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_drivers_license_plate_ci
    ON core.drivers (LOWER(license_plate));

CREATE INDEX IF NOT EXISTS idx_drivers_verification_status
    ON core.drivers (verification_status);

CREATE INDEX IF NOT EXISTS idx_drivers_vehicle_type_status
    ON core.drivers (vehicle_type, verification_status);

CREATE INDEX IF NOT EXISTS idx_drivers_dispatch_eligibility
    ON core.drivers (vehicle_type, is_online, is_available)
    WHERE verification_status = 'approved';

DROP TRIGGER IF EXISTS trg_drivers_set_updated_at ON core.drivers;
CREATE TRIGGER trg_drivers_set_updated_at
BEFORE UPDATE ON core.drivers
FOR EACH ROW
EXECUTE FUNCTION core.set_updated_at();

-- -----------------------------------------------------------------------------
-- Trips: core ride lifecycle aggregate
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.trips (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rider_id            UUID NOT NULL,
    driver_id           UUID,

    status              VARCHAR(24) NOT NULL DEFAULT 'created',
    fare_amount         NUMERIC(19,4),
    currency            CHAR(3) NOT NULL DEFAULT 'RWF',
    surge_multiplier    NUMERIC(8,4) NOT NULL DEFAULT 1.0000,
    payment_method      VARCHAR(16) NOT NULL,

    pickup_location     GEOMETRY(Point, 4326) NOT NULL,
    dropoff_location    GEOMETRY(Point, 4326) NOT NULL,
    ride_path           GEOMETRY(LineString, 4326),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    matching_started_at TIMESTAMPTZ,
    accepted_at         TIMESTAMPTZ,
    picked_up_at        TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    cancelled_at        TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_trips_rider
        FOREIGN KEY (rider_id)
        REFERENCES core.users(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_trips_driver
        FOREIGN KEY (driver_id)
        REFERENCES core.drivers(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_trips_status
        CHECK (status IN (
            'created',
            'matching',
            'accepted',
            'picked_up',
            'completed',
            'cancelled'
        )),
    CONSTRAINT chk_trips_payment_method
        CHECK (payment_method IN ('cash', 'card', 'wallet')),
    CONSTRAINT chk_trips_fare_nonnegative
        CHECK (fare_amount IS NULL OR fare_amount >= 0),
    CONSTRAINT chk_trips_surge_multiplier
        CHECK (surge_multiplier >= 1.0000),
    CONSTRAINT chk_trips_currency
        CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT chk_trips_driver_assignment
        CHECK (
            status IN ('created', 'matching', 'cancelled')
            OR driver_id IS NOT NULL
        ),
    CONSTRAINT chk_trips_completion_path
        CHECK (
            status <> 'completed'
            OR (completed_at IS NOT NULL AND ride_path IS NOT NULL)
        )
);

-- PostGIS GiST indexes accelerate bounding-box/spatial predicates.
CREATE INDEX IF NOT EXISTS idx_trips_pickup_location_gist
    ON core.trips USING GIST (pickup_location);

CREATE INDEX IF NOT EXISTS idx_trips_dropoff_location_gist
    ON core.trips USING GIST (dropoff_location);

CREATE INDEX IF NOT EXISTS idx_trips_ride_path_gist
    ON core.trips USING GIST (ride_path);

CREATE INDEX IF NOT EXISTS idx_trips_status
    ON core.trips (status);

CREATE INDEX IF NOT EXISTS idx_trips_status_created_at
    ON core.trips (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trips_rider_created_at
    ON core.trips (rider_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trips_driver_created_at
    ON core.trips (driver_id, created_at DESC)
    WHERE driver_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trips_driver_active
    ON core.trips (driver_id, status)
    WHERE driver_id IS NOT NULL
      AND status IN ('accepted', 'picked_up');

DROP TRIGGER IF EXISTS trg_trips_set_updated_at ON core.trips;
CREATE TRIGGER trg_trips_set_updated_at
BEFORE UPDATE ON core.trips
FOR EACH ROW
EXECUTE FUNCTION core.set_updated_at();

-- -----------------------------------------------------------------------------
-- Ledger accounts
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.ledger_accounts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_type      VARCHAR(24) NOT NULL,
    owner_id        UUID,
    account_code    VARCHAR(64) NOT NULL,
    account_type    VARCHAR(16) NOT NULL,
    currency        CHAR(3) NOT NULL,
    status          VARCHAR(16) NOT NULL DEFAULT 'active',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_ledger_accounts_owner_type
        CHECK (owner_type IN ('driver', 'rider', 'platform', 'corporate', 'system')),
    CONSTRAINT chk_ledger_accounts_type
        CHECK (account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
    CONSTRAINT chk_ledger_accounts_currency
        CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT chk_ledger_accounts_status
        CHECK (status IN ('active', 'frozen', 'closed'))
);

-- COALESCE makes NULL-owner platform/system accounts unique as well.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_account_identity
    ON core.ledger_accounts (
        owner_type,
        COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::UUID),
        account_code,
        currency
    );

CREATE INDEX IF NOT EXISTS idx_ledger_accounts_owner
    ON core.ledger_accounts (owner_type, owner_id);

DROP TRIGGER IF EXISTS trg_ledger_accounts_set_updated_at ON core.ledger_accounts;
CREATE TRIGGER trg_ledger_accounts_set_updated_at
BEFORE UPDATE ON core.ledger_accounts
FOR EACH ROW
EXECUTE FUNCTION core.set_updated_at();

-- -----------------------------------------------------------------------------
-- Driver wallets
-- One wallet per driver/currency. Balance is a cache/reconciliation aid only.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.driver_wallets (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    driver_id           UUID NOT NULL,
    ledger_account_id   UUID NOT NULL UNIQUE,
    currency            CHAR(3) NOT NULL,
    balance             NUMERIC(19,4) NOT NULL DEFAULT 0,
    reserved_balance    NUMERIC(19,4) NOT NULL DEFAULT 0,
    version             BIGINT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_driver_wallets_driver
        FOREIGN KEY (driver_id)
        REFERENCES core.drivers(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_driver_wallets_ledger_account
        FOREIGN KEY (ledger_account_id)
        REFERENCES core.ledger_accounts(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_driver_wallets_currency
        CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT chk_driver_wallets_reserved_nonnegative
        CHECK (reserved_balance >= 0),
    CONSTRAINT uq_driver_wallet_currency
        UNIQUE (driver_id, currency)
);

CREATE INDEX IF NOT EXISTS idx_driver_wallets_driver
    ON core.driver_wallets (driver_id);

CREATE OR REPLACE FUNCTION core.assert_driver_wallet_account()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_owner_type VARCHAR(24);
    v_owner_id   UUID;
    v_currency   CHAR(3);
BEGIN
    SELECT owner_type, owner_id, currency
      INTO v_owner_type, v_owner_id, v_currency
      FROM core.ledger_accounts
     WHERE id = NEW.ledger_account_id;

    IF v_owner_type IS NULL THEN
        RAISE EXCEPTION 'Ledger account % does not exist', NEW.ledger_account_id;
    END IF;

    IF v_owner_type <> 'driver'
       OR v_owner_id IS DISTINCT FROM NEW.driver_id
       OR v_currency <> NEW.currency THEN
        RAISE EXCEPTION
            'Driver wallet/account mismatch for driver %, account %',
            NEW.driver_id,
            NEW.ledger_account_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_driver_wallet_account ON core.driver_wallets;
CREATE TRIGGER trg_driver_wallet_account
BEFORE INSERT OR UPDATE OF driver_id, ledger_account_id, currency
ON core.driver_wallets
FOR EACH ROW
EXECUTE FUNCTION core.assert_driver_wallet_account();

DROP TRIGGER IF EXISTS trg_driver_wallets_set_updated_at ON core.driver_wallets;
CREATE TRIGGER trg_driver_wallets_set_updated_at
BEFORE UPDATE ON core.driver_wallets
FOR EACH ROW
EXECUTE FUNCTION core.set_updated_at();

-- -----------------------------------------------------------------------------
-- Ledger transaction headers
-- Pending journals may be assembled; once posted they become immutable.
-- idempotency_key prevents duplicate financial effects from retries/webhooks.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.ledger_transactions (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_type    VARCHAR(32) NOT NULL,
    reference_type      VARCHAR(32),
    reference_id        UUID,
    idempotency_key     VARCHAR(128) NOT NULL UNIQUE,
    currency            CHAR(3) NOT NULL,
    status              VARCHAR(16) NOT NULL DEFAULT 'pending',
    description         TEXT,
    metadata            JSONB NOT NULL DEFAULT '{}'::JSONB,
    posted_at           TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_ledger_transactions_type
        CHECK (transaction_type IN (
            'fare',
            'platform_commission',
            'payout',
            'cancellation_fee',
            'cash_settlement',
            'wallet_topup',
            'refund',
            'adjustment'
        )),
    CONSTRAINT chk_ledger_transactions_currency
        CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT chk_ledger_transactions_status
        CHECK (status IN ('pending', 'posted')),
    CONSTRAINT chk_ledger_transactions_posted_at
        CHECK (
            (status = 'pending' AND posted_at IS NULL)
            OR
            (status = 'posted' AND posted_at IS NOT NULL)
        )
);

CREATE INDEX IF NOT EXISTS idx_ledger_transactions_type_created
    ON core.ledger_transactions (transaction_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ledger_transactions_reference
    ON core.ledger_transactions (reference_type, reference_id)
    WHERE reference_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ledger_transactions_status_created
    ON core.ledger_transactions (status, created_at DESC);

-- -----------------------------------------------------------------------------
-- Ledger entries
-- Every posted transaction must have >= 2 lines and total debits = credits.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.ledger_entries (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id      UUID NOT NULL,
    ledger_account_id   UUID NOT NULL,
    entry_side          VARCHAR(6) NOT NULL,
    amount              NUMERIC(19,4) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_ledger_entries_transaction
        FOREIGN KEY (transaction_id)
        REFERENCES core.ledger_transactions(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_ledger_entries_account
        FOREIGN KEY (ledger_account_id)
        REFERENCES core.ledger_accounts(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_ledger_entries_side
        CHECK (entry_side IN ('debit', 'credit')),
    CONSTRAINT chk_ledger_entries_amount_positive
        CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_transaction
    ON core.ledger_entries (transaction_id);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_account_created
    ON core.ledger_entries (ledger_account_id, created_at DESC);

-- Serializes ledger-line mutation against posting by locking the parent journal row.
-- This prevents a concurrent writer from appending a line after another session posts it.
CREATE OR REPLACE FUNCTION core.guard_ledger_entry_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_transaction_id UUID;
    v_account_id     UUID;
    v_tx_status      VARCHAR(16);
    v_tx_currency    CHAR(3);
    v_account_currency CHAR(3);
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_transaction_id := OLD.transaction_id;
        v_account_id := OLD.ledger_account_id;
    ELSE
        v_transaction_id := NEW.transaction_id;
        v_account_id := NEW.ledger_account_id;
    END IF;

    SELECT status, currency
      INTO v_tx_status, v_tx_currency
      FROM core.ledger_transactions
     WHERE id = v_transaction_id
     FOR UPDATE;

    IF v_tx_status IS NULL THEN
        RAISE EXCEPTION 'Ledger transaction % does not exist', v_transaction_id;
    END IF;

    IF v_tx_status <> 'pending' THEN
        RAISE EXCEPTION
            'Ledger transaction % is posted and immutable',
            v_transaction_id;
    END IF;

    IF TG_OP <> 'DELETE' THEN
        SELECT currency
          INTO v_account_currency
          FROM core.ledger_accounts
         WHERE id = v_account_id;

        IF v_account_currency IS NULL THEN
            RAISE EXCEPTION 'Ledger account % does not exist', v_account_id;
        END IF;

        IF v_tx_currency <> v_account_currency THEN
            RAISE EXCEPTION
                'Currency mismatch for transaction %, transaction currency %, account currency %',
                v_transaction_id,
                v_tx_currency,
                v_account_currency;
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_ledger_entry_mutation ON core.ledger_entries;
CREATE TRIGGER trg_guard_ledger_entry_mutation
BEFORE INSERT OR UPDATE OR DELETE ON core.ledger_entries
FOR EACH ROW
EXECUTE FUNCTION core.guard_ledger_entry_mutation();

-- Posting is the accounting commit point. The row lock serializes posting against
-- ledger-line mutations; the balance is checked in the same DB transaction.
CREATE OR REPLACE FUNCTION core.post_ledger_transaction(p_transaction_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_status       VARCHAR(16);
    v_debit_total  NUMERIC(19,4);
    v_credit_total NUMERIC(19,4);
    v_line_count   BIGINT;
BEGIN
    SELECT status
      INTO v_status
      FROM core.ledger_transactions
     WHERE id = p_transaction_id
     FOR UPDATE;

    IF v_status IS NULL THEN
        RAISE EXCEPTION 'Ledger transaction % does not exist', p_transaction_id;
    END IF;

    IF v_status = 'posted' THEN
        -- Idempotent posting: an already-posted transaction is a no-op.
        RETURN;
    END IF;

    SELECT
        COALESCE(SUM(amount) FILTER (WHERE entry_side = 'debit'), 0),
        COALESCE(SUM(amount) FILTER (WHERE entry_side = 'credit'), 0),
        COUNT(*)
      INTO v_debit_total, v_credit_total, v_line_count
      FROM core.ledger_entries
     WHERE transaction_id = p_transaction_id;

    IF v_line_count < 2 THEN
        RAISE EXCEPTION
            'Ledger transaction % must contain at least two entries',
            p_transaction_id;
    END IF;

    IF v_debit_total <> v_credit_total THEN
        RAISE EXCEPTION
            'Unbalanced ledger transaction %: debits %, credits %',
            p_transaction_id,
            v_debit_total,
            v_credit_total;
    END IF;

    UPDATE core.ledger_transactions
       SET status = 'posted',
           posted_at = NOW(),
           updated_at = NOW()
     WHERE id = p_transaction_id;
END;
$$;

-- Direct attempts to mark a transaction posted must satisfy the same accounting rules.
CREATE OR REPLACE FUNCTION core.validate_ledger_transaction_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_debit_total  NUMERIC(19,4);
    v_credit_total NUMERIC(19,4);
    v_line_count   BIGINT;
BEGIN
    IF OLD.status = 'posted' THEN
        RAISE EXCEPTION
            'Posted ledger transaction % is immutable; use a compensating transaction',
            OLD.id;
    END IF;

    IF NEW.status = 'posted' AND OLD.status <> 'posted' THEN
        SELECT
            COALESCE(SUM(amount) FILTER (WHERE entry_side = 'debit'), 0),
            COALESCE(SUM(amount) FILTER (WHERE entry_side = 'credit'), 0),
            COUNT(*)
          INTO v_debit_total, v_credit_total, v_line_count
          FROM core.ledger_entries
         WHERE transaction_id = OLD.id;

        IF v_line_count < 2 OR v_debit_total <> v_credit_total THEN
            RAISE EXCEPTION
                'Cannot post unbalanced ledger transaction %: lines %, debits %, credits %',
                OLD.id,
                v_line_count,
                v_debit_total,
                v_credit_total;
        END IF;

        NEW.posted_at := COALESCE(NEW.posted_at, NOW());
    END IF;

    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_ledger_transaction_update ON core.ledger_transactions;
CREATE TRIGGER trg_validate_ledger_transaction_update
BEFORE UPDATE ON core.ledger_transactions
FOR EACH ROW
EXECUTE FUNCTION core.validate_ledger_transaction_update();

CREATE OR REPLACE FUNCTION core.prevent_ledger_transaction_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'Ledger transactions cannot be deleted; use a compensating transaction';
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_ledger_transaction_delete ON core.ledger_transactions;
CREATE TRIGGER trg_prevent_ledger_transaction_delete
BEFORE DELETE ON core.ledger_transactions
FOR EACH ROW
EXECUTE FUNCTION core.prevent_ledger_transaction_delete();

-- -----------------------------------------------------------------------------
-- Documentation
-- -----------------------------------------------------------------------------
COMMENT ON COLUMN core.users.wallet_balance IS
    'Read-optimized cached balance. Do not treat as the financial source of truth.';

COMMENT ON COLUMN core.drivers.current_wallet_balance IS
    'Read-optimized cached driver balance. Authoritative value derives from the ledger.';

COMMENT ON COLUMN core.driver_wallets.balance IS
    'Cached wallet balance for fast reads; authoritative value derives from posted ledger entries.';

COMMENT ON TABLE core.ledger_transactions IS
    'Journal headers. Build while pending; post atomically after debit/credit validation.';

COMMENT ON TABLE core.ledger_entries IS
    'Double-entry debit/credit lines. Lines become immutable when their journal is posted.';

COMMIT;
