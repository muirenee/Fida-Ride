-- Fida-Ride device attestation registry v7
-- Apple App Attest public keys are durable security state. Android Play Integrity
-- verdicts are verified per protected action and do not require a durable device key.

BEGIN;

SET LOCAL search_path TO core, public;

CREATE TABLE IF NOT EXISTS core.device_attestations (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    installation_id     UUID NOT NULL,
    platform            VARCHAR(16) NOT NULL,
    user_id             UUID,
    key_id              VARCHAR(512),
    public_key          TEXT,
    bundle_id           VARCHAR(255),
    sign_count          BIGINT NOT NULL DEFAULT 0,
    status              VARCHAR(16) NOT NULL DEFAULT 'active',
    last_verified_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_device_attestations_user
        FOREIGN KEY (user_id)
        REFERENCES core.users(id)
        ON UPDATE CASCADE
        ON DELETE SET NULL,

    CONSTRAINT chk_device_attestations_platform
        CHECK (platform IN ('android', 'ios')),

    CONSTRAINT chk_device_attestations_status
        CHECK (status IN ('active', 'revoked')),

    CONSTRAINT chk_device_attestations_sign_count
        CHECK (sign_count >= 0),

    CONSTRAINT chk_ios_attestation_material
        CHECK (
            platform <> 'ios'
            OR (
                key_id IS NOT NULL
                AND public_key IS NOT NULL
                AND bundle_id IS NOT NULL
            )
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_device_attestations_installation_platform
    ON core.device_attestations (installation_id, platform);

CREATE UNIQUE INDEX IF NOT EXISTS uq_device_attestations_ios_key
    ON core.device_attestations (key_id)
    WHERE key_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_device_attestations_user
    ON core.device_attestations (user_id)
    WHERE user_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_device_attestations_set_updated_at
    ON core.device_attestations;

CREATE TRIGGER trg_device_attestations_set_updated_at
BEFORE UPDATE ON core.device_attestations
FOR EACH ROW
EXECUTE FUNCTION core.set_updated_at();

COMMIT;
