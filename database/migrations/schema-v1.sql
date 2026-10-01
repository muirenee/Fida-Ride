-- Fida-Ride core relational schema v1
-- PostgreSQL 15+ with PostGIS enabled.
-- Financial note: cached balance columns are for read performance only.
-- The authoritative financial source of truth is the immutable double-entry ledger.

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE SCHEMA IF NOT EXISTS core AUTHORIZATION CURRENT_USER;

SET LOCAL search_path TO core, public;

-- -----------------------------------------------------------------------------
-- Shared updated_at trigger
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

    -- Cached/read-optimized balance only. Ledger remains authoritative.
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

    -- Cached/read-optimized balance only. Ledger remains authoritative.
    current_wallet_balance  NUMERIC(19,4) NOT NULL DEFAULT 0,
    wallet_currency         CHAR(3) NOT NULL DEFAULT 'RWF',

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

-- Native PostGIS GiST indexes for spatial filtering and bounding-box searches.
CREATE INDEX IF NOT EXISTS idx_trips_pickup_location_gist
    ON core.trips
    USING GIST (pickup_location);

CREATE INDEX IF NOT EXISTS idx_trips_dropoff_location_gist
    ON core.trips
    USING GIST (dropoff_location);

CREATE INDEX IF NOT EXISTS idx_trips_ride_path_gist
    ON core.trips
    USING GIST (ride_path);

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
-- Supporting structure required for rigorous double-entry accounting.
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
        CHECK (status IN ('active', 'frozen', 'closed')),
    CONSTRAINT uq_ledger_account_identity
        UNIQUE (owner_type, owner_id, account_code, currency)
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
-- One wallet per driver/currency; balance is a cache/reconciliation aid only.
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

DROP TRIGGER IF EXISTS trg_driver_wallets_set_updated_at ON core.driver_wallets;
CREATE TRIGGER trg_driver_wallets_set_updated_at
BEFORE UPDATE ON core.driver_wallets
FOR EACH ROW
EXECUTE FUNCTION core.set_updated_at();

-- -----------------------------------------------------------------------------
-- Ledger transaction headers
-- Immutable business event / journal header. Idempotency prevents duplicate money.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.ledger_transactions (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_type    VARCHAR(32) NOT NULL,
    reference_type      VARCHAR(32),
    reference_id        UUID,
    idempotency_key     VARCHAR(128) NOT NULL UNIQUE,
    currency            CHAR(3) NOT NULL,
    description         TEXT,
    metadata            JSONB NOT NULL DEFAULT '{}'::JSONB,
    posted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

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
        CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE INDEX IF NOT EXISTS idx_ledger_transactions_type_posted
    ON core.ledger_transactions (transaction_type, posted_at DESC);

CREATE INDEX IF NOT EXISTS idx_ledger_transactions_reference
    ON core.ledger_transactions (reference_type, reference_id)
    WHERE reference_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ledger_transactions_posted_at
    ON core.ledger_transactions (posted_at DESC);

-- -----------------------------------------------------------------------------
-- Ledger entries
-- Every transaction has two or more lines whose debits and credits must balance.
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

-- Enforce currency consistency between a journal header and each participating account.
CREATE OR REPLACE FUNCTION core.assert_ledger_entry_currency_matches()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    tx_currency      CHAR(3);
    account_currency CHAR(3);
BEGIN
    SELECT currency
      INTO tx_currency
      FROM core.ledger_transactions
     WHERE id = NEW.transaction_id;

    SELECT currency
      INTO account_currency
      FROM core.ledger_accounts
     WHERE id = NEW.ledger_account_id;

    IF tx_currency IS NULL OR account_currency IS NULL THEN
        RAISE EXCEPTION 'Ledger transaction/account currency lookup failed';
    END IF;

    IF tx_currency <> account_currency THEN
        RAISE EXCEPTION
            'Currency mismatch for transaction %, transaction currency %, account currency %',
            NEW.transaction_id,
            tx_currency,
            account_currency;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ledger_entry_currency ON core.ledger_entries;
CREATE TRIGGER trg_ledger_entry_currency
BEFORE INSERT OR UPDATE ON core.ledger_entries
FOR EACH ROW
EXECUTE FUNCTION core.assert_ledger_entry_currency_matches();

-- A deferred constraint trigger validates that all lines for a transaction balance
-- before the SQL transaction commits. This allows callers to insert debit and credit
-- lines independently inside a single database transaction without transient failures.
CREATE OR REPLACE FUNCTION core.assert_ledger_transaction_balanced()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_transaction_id UUID;
    debit_total      NUMERIC(19,4);
    credit_total     NUMERIC(19,4);
    line_count       BIGINT;
BEGIN
    v_transaction_id := COALESCE(NEW.transaction_id, OLD.transaction_id);

    SELECT
        COALESCE(SUM(amount) FILTER (WHERE entry_side = 'debit'), 0),
        COALESCE(SUM(amount) FILTER (WHERE entry_side = 'credit'), 0),
        COUNT(*)
      INTO debit_total, credit_total, line_count
      FROM core.ledger_entries
     WHERE transaction_id = v_transaction_id;

    IF line_count < 2 THEN
        RAISE EXCEPTION
            'Ledger transaction % must contain at least two entries',
            v_transaction_id;
    END IF;

    IF debit_total <> credit_total THEN
        RAISE EXCEPTION
            'Unbalanced ledger transaction %: debits %, credits %',
            v_transaction_id,
            debit_total,
            credit_total;
    END IF;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_ledger_transaction_balanced ON core.ledger_entries;
CREATE CONSTRAINT TRIGGER trg_ledger_transaction_balanced
AFTER INSERT OR UPDATE OR DELETE ON core.ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION core.assert_ledger_transaction_balanced();

-- -----------------------------------------------------------------------------
-- Prevent destructive mutations of posted ledger history.
-- Corrections must be expressed as new compensating transactions.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.prevent_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'Posted ledger records are immutable; create a compensating transaction instead';
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_ledger_transaction_update_delete ON core.ledger_transactions;
CREATE TRIGGER trg_prevent_ledger_transaction_update_delete
BEFORE UPDATE OR DELETE ON core.ledger_transactions
FOR EACH ROW
EXECUTE FUNCTION core.prevent_ledger_mutation();

DROP TRIGGER IF EXISTS trg_prevent_ledger_entry_update_delete ON core.ledger_entries;
CREATE TRIGGER trg_prevent_ledger_entry_update_delete
BEFORE UPDATE OR DELETE ON core.ledger_entries
FOR EACH ROW
EXECUTE FUNCTION core.prevent_ledger_mutation();

-- -----------------------------------------------------------------------------
-- Comments documenting authoritative vs cached balances
-- -----------------------------------------------------------------------------
COMMENT ON COLUMN core.users.wallet_balance IS
    'Read-optimized cached wallet balance. Do not treat as the financial source of truth.';

COMMENT ON COLUMN core.drivers.current_wallet_balance IS
    'Read-optimized cached driver balance. Authoritative value derives from the ledger.';

COMMENT ON COLUMN core.driver_wallets.balance IS
    'Cached materialized wallet balance for fast reads; reconcile against double-entry ledger.';

COMMENT ON TABLE core.ledger_transactions IS
    'Immutable journal headers. Duplicate monetary events are blocked by idempotency_key.';

COMMENT ON TABLE core.ledger_entries IS
    'Immutable debit/credit journal lines. Deferred trigger requires total debits = total credits.';

COMMIT;
