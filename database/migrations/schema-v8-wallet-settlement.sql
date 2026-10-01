-- Fida-Ride financial settlement schema v8
-- Extends the canonical double-entry ledger introduced in schema-v1.
-- PostgreSQL 15+

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path TO core, public;

-- -----------------------------------------------------------------------------
-- Classify wallet-facing journal lines. The canonical source of truth remains
-- ledger_transactions + ledger_entries; wallet_ledgers is an immutable signed
-- projection for wallet operations/reporting.
-- -----------------------------------------------------------------------------
ALTER TABLE core.ledger_entries
    ADD COLUMN IF NOT EXISTS wallet_transaction_type VARCHAR(32);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_ledger_entries_wallet_transaction_type'
          AND conrelid = 'core.ledger_entries'::regclass
    ) THEN
        ALTER TABLE core.ledger_entries
            ADD CONSTRAINT chk_ledger_entries_wallet_transaction_type
            CHECK (
                wallet_transaction_type IS NULL
                OR wallet_transaction_type IN (
                    'ride_fare',
                    'platform_commission',
                    'cancellation_fee',
                    'driver_payout',
                    'user_topup'
                )
            );
    END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- Rider wallets. Balance is a cache only; posted journal entries are authoritative.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.rider_wallets (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rider_id            UUID NOT NULL,
    ledger_account_id   UUID NOT NULL UNIQUE,
    currency            CHAR(3) NOT NULL,
    balance             NUMERIC(19,4) NOT NULL DEFAULT 0,
    reserved_balance    NUMERIC(19,4) NOT NULL DEFAULT 0,
    version             BIGINT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_rider_wallets_rider
        FOREIGN KEY (rider_id)
        REFERENCES core.users(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_rider_wallets_ledger_account
        FOREIGN KEY (ledger_account_id)
        REFERENCES core.ledger_accounts(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_rider_wallets_currency
        CHECK (currency ~ '^[A-Z]{3}$'),

    CONSTRAINT chk_rider_wallets_reserved_nonnegative
        CHECK (reserved_balance >= 0),

    CONSTRAINT uq_rider_wallet_currency
        UNIQUE (rider_id, currency)
);

CREATE INDEX IF NOT EXISTS idx_rider_wallets_rider
    ON core.rider_wallets (rider_id);

CREATE OR REPLACE FUNCTION core.assert_rider_wallet_account()
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

    IF v_owner_type <> 'rider'
       OR v_owner_id IS DISTINCT FROM NEW.rider_id
       OR v_currency <> NEW.currency THEN
        RAISE EXCEPTION
            'Rider wallet/account mismatch for rider %, account %',
            NEW.rider_id,
            NEW.ledger_account_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rider_wallet_account ON core.rider_wallets;
CREATE TRIGGER trg_rider_wallet_account
BEFORE INSERT OR UPDATE OF rider_id, ledger_account_id, currency
ON core.rider_wallets
FOR EACH ROW
EXECUTE FUNCTION core.assert_rider_wallet_account();

DROP TRIGGER IF EXISTS trg_rider_wallets_set_updated_at ON core.rider_wallets;
CREATE TRIGGER trg_rider_wallets_set_updated_at
BEFORE UPDATE ON core.rider_wallets
FOR EACH ROW
EXECUTE FUNCTION core.set_updated_at();

-- -----------------------------------------------------------------------------
-- Immutable signed wallet projection requested by the wallet API/domain.
-- debit = negative amount, credit = positive amount. Every transaction_id must
-- sum to exactly zero; the canonical journal posting function populates it.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.wallet_ledgers (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id      UUID NOT NULL,
    source_entry_id     UUID NOT NULL UNIQUE,
    account_type        VARCHAR(24) NOT NULL,
    account_id          UUID,
    amount              NUMERIC(19,4) NOT NULL,
    currency            CHAR(3) NOT NULL,
    transaction_type    VARCHAR(32) NOT NULL,
    reference_id        UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_wallet_ledgers_transaction
        FOREIGN KEY (transaction_id)
        REFERENCES core.ledger_transactions(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_wallet_ledgers_source_entry
        FOREIGN KEY (source_entry_id)
        REFERENCES core.ledger_entries(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_wallet_ledgers_account_type
        CHECK (account_type IN ('rider', 'driver', 'platform_corp')),

    CONSTRAINT chk_wallet_ledgers_account_identity
        CHECK (
            (account_type IN ('rider', 'driver') AND account_id IS NOT NULL)
            OR
            (account_type = 'platform_corp')
        ),

    CONSTRAINT chk_wallet_ledgers_amount_nonzero
        CHECK (amount <> 0),

    CONSTRAINT chk_wallet_ledgers_currency
        CHECK (currency ~ '^[A-Z]{3}$'),

    CONSTRAINT chk_wallet_ledgers_transaction_type
        CHECK (transaction_type IN (
            'ride_fare',
            'platform_commission',
            'cancellation_fee',
            'driver_payout',
            'user_topup'
        ))
);

CREATE INDEX IF NOT EXISTS idx_wallet_ledgers_transaction
    ON core.wallet_ledgers (transaction_id);

CREATE INDEX IF NOT EXISTS idx_wallet_ledgers_account_created
    ON core.wallet_ledgers (account_type, account_id, currency, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_ledgers_reference
    ON core.wallet_ledgers (reference_id)
    WHERE reference_id IS NOT NULL;

CREATE OR REPLACE FUNCTION core.validate_wallet_ledger_row()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_entry_transaction UUID;
    v_entry_amount      NUMERIC(19,4);
    v_entry_side        VARCHAR(6);
    v_wallet_type       VARCHAR(32);
    v_owner_type        VARCHAR(24);
    v_owner_id          UUID;
    v_currency          CHAR(3);
    v_tx_currency       CHAR(3);
    v_reference_id      UUID;
    v_tx_status         VARCHAR(16);
    v_expected_account_type VARCHAR(24);
    v_expected_amount   NUMERIC(19,4);
BEGIN
    SELECT
        e.transaction_id,
        e.amount,
        e.entry_side,
        e.wallet_transaction_type,
        a.owner_type,
        a.owner_id,
        a.currency,
        t.currency,
        t.reference_id,
        t.status
      INTO
        v_entry_transaction,
        v_entry_amount,
        v_entry_side,
        v_wallet_type,
        v_owner_type,
        v_owner_id,
        v_currency,
        v_tx_currency,
        v_reference_id,
        v_tx_status
      FROM core.ledger_entries e
      JOIN core.ledger_accounts a
        ON a.id = e.ledger_account_id
      JOIN core.ledger_transactions t
        ON t.id = e.transaction_id
     WHERE e.id = NEW.source_entry_id;

    IF v_entry_transaction IS NULL THEN
        RAISE EXCEPTION 'Wallet ledger source entry % does not exist', NEW.source_entry_id;
    END IF;

    IF v_tx_status <> 'posted' THEN
        RAISE EXCEPTION 'Wallet projection requires a posted journal transaction';
    END IF;

    IF v_entry_transaction <> NEW.transaction_id THEN
        RAISE EXCEPTION 'Wallet projection transaction/source-entry mismatch';
    END IF;

    IF v_wallet_type IS NULL OR v_wallet_type <> NEW.transaction_type THEN
        RAISE EXCEPTION 'Wallet transaction type does not match source journal line';
    END IF;

    v_expected_account_type := CASE v_owner_type
        WHEN 'rider' THEN 'rider'
        WHEN 'driver' THEN 'driver'
        WHEN 'platform' THEN 'platform_corp'
        WHEN 'corporate' THEN 'platform_corp'
        ELSE NULL
    END;

    IF v_expected_account_type IS NULL
       OR v_expected_account_type <> NEW.account_type
       OR v_owner_id IS DISTINCT FROM NEW.account_id THEN
        RAISE EXCEPTION 'Wallet account identity does not match source ledger account';
    END IF;

    IF v_currency <> NEW.currency OR v_tx_currency <> NEW.currency THEN
        RAISE EXCEPTION 'Wallet projection currency mismatch';
    END IF;

    IF v_reference_id IS DISTINCT FROM NEW.reference_id THEN
        RAISE EXCEPTION 'Wallet projection reference mismatch';
    END IF;

    v_expected_amount := CASE v_entry_side
        WHEN 'credit' THEN v_entry_amount
        ELSE -v_entry_amount
    END;

    IF v_expected_amount <> NEW.amount THEN
        RAISE EXCEPTION 'Wallet projection signed amount mismatch';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_wallet_ledger_row ON core.wallet_ledgers;
CREATE TRIGGER trg_validate_wallet_ledger_row
BEFORE INSERT ON core.wallet_ledgers
FOR EACH ROW
EXECUTE FUNCTION core.validate_wallet_ledger_row();

CREATE OR REPLACE FUNCTION core.validate_wallet_ledger_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_total NUMERIC(19,4);
    v_count BIGINT;
BEGIN
    SELECT COALESCE(SUM(amount), 0), COUNT(*)
      INTO v_total, v_count
      FROM core.wallet_ledgers
     WHERE transaction_id = NEW.transaction_id;

    IF v_count < 2 OR v_total <> 0 THEN
        RAISE EXCEPTION
            'Wallet ledger transaction % is unbalanced: lines %, net %',
            NEW.transaction_id,
            v_count,
            v_total;
    END IF;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_wallet_ledgers_balanced ON core.wallet_ledgers;
CREATE CONSTRAINT TRIGGER trg_wallet_ledgers_balanced
AFTER INSERT ON core.wallet_ledgers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION core.validate_wallet_ledger_balance();

CREATE OR REPLACE FUNCTION core.prevent_wallet_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'wallet_ledgers is immutable; use a compensating journal transaction';
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_wallet_ledger_mutation ON core.wallet_ledgers;
CREATE TRIGGER trg_prevent_wallet_ledger_mutation
BEFORE UPDATE OR DELETE ON core.wallet_ledgers
FOR EACH ROW
EXECUTE FUNCTION core.prevent_wallet_ledger_mutation();

-- -----------------------------------------------------------------------------
-- Canonical wallet balance helper. Wallet liabilities use credits as positive
-- customer/driver value and debits as negative value.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.wallet_account_balance(p_ledger_account_id UUID)
RETURNS NUMERIC(19,4)
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(
        SUM(
            CASE e.entry_side
                WHEN 'credit' THEN e.amount
                ELSE -e.amount
            END
        ),
        0::NUMERIC
    )::NUMERIC(19,4)
    FROM core.ledger_entries e
    JOIN core.ledger_transactions t
      ON t.id = e.transaction_id
    WHERE e.ledger_account_id = p_ledger_account_id
      AND t.status = 'posted';
$$;

-- -----------------------------------------------------------------------------
-- Replace the posting function so posting atomically validates the double-entry
-- journal and materializes its signed wallet projection.
-- -----------------------------------------------------------------------------
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

    INSERT INTO core.wallet_ledgers (
        transaction_id,
        source_entry_id,
        account_type,
        account_id,
        amount,
        currency,
        transaction_type,
        reference_id
    )
    SELECT
        e.transaction_id,
        e.id,
        CASE a.owner_type
            WHEN 'rider' THEN 'rider'
            WHEN 'driver' THEN 'driver'
            WHEN 'platform' THEN 'platform_corp'
            WHEN 'corporate' THEN 'platform_corp'
        END,
        a.owner_id,
        CASE e.entry_side
            WHEN 'credit' THEN e.amount
            ELSE -e.amount
        END,
        t.currency,
        e.wallet_transaction_type,
        t.reference_id
    FROM core.ledger_entries e
    JOIN core.ledger_accounts a
      ON a.id = e.ledger_account_id
    JOIN core.ledger_transactions t
      ON t.id = e.transaction_id
    WHERE e.transaction_id = p_transaction_id
      AND e.wallet_transaction_type IS NOT NULL
      AND a.owner_type IN ('rider', 'driver', 'platform', 'corporate')
    ON CONFLICT (source_entry_id) DO NOTHING;
END;
$$;

-- -----------------------------------------------------------------------------
-- Settlement linkage on trips.
-- -----------------------------------------------------------------------------
ALTER TABLE core.trips
    ADD COLUMN IF NOT EXISTS settlement_transaction_id UUID,
    ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_trips_settlement_transaction'
          AND conrelid = 'core.trips'::regclass
    ) THEN
        ALTER TABLE core.trips
            ADD CONSTRAINT fk_trips_settlement_transaction
            FOREIGN KEY (settlement_transaction_id)
            REFERENCES core.ledger_transactions(id)
            ON UPDATE CASCADE
            ON DELETE RESTRICT;
    END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_trips_settlement_transaction
    ON core.trips (settlement_transaction_id)
    WHERE settlement_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trips_completed_unsettled
    ON core.trips (completed_at, id)
    WHERE status = 'completed'
      AND settlement_transaction_id IS NULL;

COMMENT ON TABLE core.wallet_ledgers IS
    'Immutable signed wallet projection of canonical posted double-entry journal lines. Net amount per transaction_id is constrained to zero.';

COMMENT ON COLUMN core.wallet_ledgers.amount IS
    'Signed wallet movement: debit is negative, credit is positive. Canonical source remains ledger_entries.';

COMMENT ON TABLE core.rider_wallets IS
    'Read-optimized rider wallet cache. Authoritative balance derives from posted ledger entries.';

COMMIT;
