import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import { DataSource, EntityManager } from 'typeorm';
import { DriverFinancialService } from './driver-financial.service';

interface TripSettlementRow {
  id: string;
  rider_id: string;
  driver_id: string;
  driver_user_id: string;
  status: string;
  fare_amount: string;
  currency: string;
  payment_method: 'cash' | 'card' | 'wallet';
  settlement_transaction_id: string | null;
}

interface WalletRow {
  id: string;
  ledger_account_id: string;
}

interface LedgerTransactionRow {
  id: string;
  status: string;
}

export interface TripSettlementResult {
  tripId: string;
  transactionId: string;
  paymentMethod: 'cash' | 'card' | 'wallet';
  grossFare: string;
  commission: string;
  driverNet: string;
  currency: string;
  alreadySettled: boolean;
}

@Injectable()
export class WalletSettlementService {
  constructor(
    private readonly db: DataSource,
    private readonly config: ConfigService,
    private readonly driverFinancial: DriverFinancialService,
  ) {}

  async settleCompletedTrip(tripId: string): Promise<TripSettlementResult> {
    let driverId = '';

    const result = await this.db.transaction('SERIALIZABLE', async (manager) => {
      await manager.query(`SET LOCAL lock_timeout = '3s'`);
      await manager.query(`SET LOCAL statement_timeout = '10s'`);

      const trips = (await manager.query(
        `
          SELECT
            t.id,
            t.rider_id,
            t.driver_id,
            d.user_id AS driver_user_id,
            t.status,
            t.fare_amount::text,
            t.currency,
            t.payment_method,
            t.settlement_transaction_id
          FROM core.trips t
          JOIN core.drivers d
            ON d.id = t.driver_id
          WHERE t.id = $1
          FOR UPDATE OF t, d
        `,
        [tripId],
      )) as TripSettlementRow[];

      const trip = trips[0];
      if (!trip) throw new NotFoundException('Trip not found or driver is not assigned');
      if (trip.status !== 'completed') {
        throw new ConflictException('Only completed trips can be financially settled');
      }
      if (!trip.driver_id || !trip.fare_amount) {
        throw new ConflictException('Completed trip is missing driver or fare data');
      }

      driverId = trip.driver_id;

      if (trip.settlement_transaction_id) {
        const existing = await this.requirePostedTransaction(
          manager,
          trip.settlement_transaction_id,
        );
        return this.resultFromExisting(trip, existing.id);
      }

      const gross = new Decimal(trip.fare_amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      if (!gross.isFinite() || gross.lte(0)) {
        throw new ConflictException('Completed trip fare must be greater than zero');
      }

      const commissionRate = this.commissionRate();
      const commission = gross.mul(commissionRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const driverNet = gross.minus(commission).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

      if (commission.lte(0) || driverNet.lte(0)) {
        throw new ConflictException('Settlement commission configuration is invalid');
      }

      const idempotencyKey = `trip:settlement:${trip.id}:v1`;
      const priorRows = (await manager.query(
        `
          SELECT id, status
          FROM core.ledger_transactions
          WHERE idempotency_key = $1
          FOR UPDATE
        `,
        [idempotencyKey],
      )) as LedgerTransactionRow[];

      if (priorRows[0]) {
        if (priorRows[0].status !== 'posted') {
          throw new ConflictException('A pending settlement journal already exists for this trip');
        }
        await manager.query(
          `
            UPDATE core.trips
            SET settlement_transaction_id = $2,
                settled_at = COALESCE(settled_at, NOW()),
                updated_at = NOW()
            WHERE id = $1
          `,
          [trip.id, priorRows[0].id],
        );
        return this.resultFromAmounts(
          trip,
          priorRows[0].id,
          gross,
          commission,
          driverNet,
          true,
        );
      }

      const driverWallet = await this.ensureDriverWallet(
        manager,
        trip.driver_id,
        trip.currency,
      );
      const platformAccountId = await this.ensureLedgerAccount(
        manager,
        'platform',
        null,
        'commission_revenue',
        'revenue',
        trip.currency,
      );

      let riderWallet: WalletRow | null = null;
      if (trip.payment_method !== 'cash') {
        riderWallet = await this.ensureRiderWallet(manager, trip.rider_id, trip.currency);
        const riderBalance = await this.walletBalance(manager, riderWallet.ledger_account_id);
        if (riderBalance.lt(gross)) {
          throw new HttpException(
            {
              statusCode: HttpStatus.PAYMENT_REQUIRED,
              code: 'RIDER_WALLET_INSUFFICIENT_FUNDS',
              message: 'Rider wallet has insufficient funds for trip settlement.',
              balance: riderBalance.toFixed(2),
              required: gross.toFixed(2),
              currency: trip.currency,
            },
            HttpStatus.PAYMENT_REQUIRED,
          );
        }
      }

      const txRows = (await manager.query(
        `
          INSERT INTO core.ledger_transactions (
            transaction_type,
            reference_type,
            reference_id,
            idempotency_key,
            currency,
            status,
            description,
            metadata
          )
          VALUES (
            $1,
            'trip',
            $2,
            $3,
            $4,
            'pending',
            $5,
            $6::jsonb
          )
          RETURNING id, status
        `,
        [
          trip.payment_method === 'cash' ? 'cash_settlement' : 'fare',
          trip.id,
          idempotencyKey,
          trip.currency,
          `Trip ${trip.id} settlement`,
          JSON.stringify({
            payment_method: trip.payment_method,
            gross_fare: gross.toFixed(2),
            commission_rate: commissionRate.toFixed(4),
            commission: commission.toFixed(2),
            driver_net: driverNet.toFixed(2),
          }),
        ],
      )) as LedgerTransactionRow[];

      const transactionId = txRows[0]?.id;
      if (!transactionId) throw new Error('Failed to create settlement journal');

      if (trip.payment_method === 'cash') {
        await this.insertLedgerEntry(
          manager,
          transactionId,
          driverWallet.ledger_account_id,
          'debit',
          commission,
          'platform_commission',
        );
        await this.insertLedgerEntry(
          manager,
          transactionId,
          platformAccountId,
          'credit',
          commission,
          'platform_commission',
        );
      } else {
        if (!riderWallet) throw new Error('Rider wallet was not initialized');
        await this.insertLedgerEntry(
          manager,
          transactionId,
          riderWallet.ledger_account_id,
          'debit',
          gross,
          'ride_fare',
        );
        await this.insertLedgerEntry(
          manager,
          transactionId,
          driverWallet.ledger_account_id,
          'credit',
          driverNet,
          'ride_fare',
        );
        await this.insertLedgerEntry(
          manager,
          transactionId,
          platformAccountId,
          'credit',
          commission,
          'platform_commission',
        );
      }

      await manager.query('SELECT core.post_ledger_transaction($1)', [transactionId]);

      if (riderWallet) {
        const riderBalance = await this.walletBalance(manager, riderWallet.ledger_account_id);
        await manager.query(
          `
            UPDATE core.rider_wallets
            SET balance = $2::numeric,
                version = version + 1,
                updated_at = NOW()
            WHERE id = $1
          `,
          [riderWallet.id, riderBalance.toFixed(4)],
        );
        await manager.query(
          `
            UPDATE core.users
            SET wallet_balance = $2::numeric,
                updated_at = NOW()
            WHERE id = $1
          `,
          [trip.rider_id, riderBalance.toFixed(4)],
        );
      }

      const driverBalance = await this.walletBalance(manager, driverWallet.ledger_account_id);
      await manager.query(
        `
          UPDATE core.driver_wallets
          SET balance = $2::numeric,
              version = version + 1,
              updated_at = NOW()
          WHERE id = $1
        `,
        [driverWallet.id, driverBalance.toFixed(4)],
      );
      await manager.query(
        `
          UPDATE core.drivers
          SET current_wallet_balance = $2::numeric,
              updated_at = NOW()
          WHERE id = $1
        `,
        [trip.driver_id, driverBalance.toFixed(4)],
      );

      await manager.query(
        `
          UPDATE core.trips
          SET settlement_transaction_id = $2,
              settled_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
        `,
        [trip.id, transactionId],
      );

      return this.resultFromAmounts(
        trip,
        transactionId,
        gross,
        commission,
        driverNet,
        false,
      );
    });

    if (driverId) {
      await this.driverFinancial.refreshRealtimeEligibility(driverId);
    }

    return result;
  }

  private commissionRate(): Decimal {
    const rate = new Decimal(this.config.get<string>('PLATFORM_COMMISSION_RATE', '0.15'));
    if (!rate.isFinite() || rate.lte(0) || rate.gte(1)) {
      throw new ConflictException('PLATFORM_COMMISSION_RATE must be greater than 0 and less than 1');
    }
    return rate;
  }

  private async requirePostedTransaction(
    manager: EntityManager,
    transactionId: string,
  ): Promise<LedgerTransactionRow> {
    const rows = (await manager.query(
      'SELECT id, status FROM core.ledger_transactions WHERE id = $1 FOR UPDATE',
      [transactionId],
    )) as LedgerTransactionRow[];
    const row = rows[0];
    if (!row || row.status !== 'posted') {
      throw new ConflictException('Trip references an invalid settlement transaction');
    }
    return row;
  }

  private async ensureDriverWallet(
    manager: EntityManager,
    driverId: string,
    currency: string,
  ): Promise<WalletRow> {
    const accountId = await this.ensureLedgerAccount(
      manager,
      'driver',
      driverId,
      'wallet',
      'liability',
      currency,
    );

    await manager.query(
      `
        INSERT INTO core.driver_wallets (driver_id, ledger_account_id, currency)
        VALUES ($1, $2, $3)
        ON CONFLICT (driver_id, currency) DO NOTHING
      `,
      [driverId, accountId, currency],
    );

    const rows = (await manager.query(
      `
        SELECT id, ledger_account_id
        FROM core.driver_wallets
        WHERE driver_id = $1 AND currency = $2
        FOR UPDATE
      `,
      [driverId, currency],
    )) as WalletRow[];
    if (!rows[0]) throw new Error('Failed to initialize driver wallet');
    return rows[0];
  }

  private async ensureRiderWallet(
    manager: EntityManager,
    riderId: string,
    currency: string,
  ): Promise<WalletRow> {
    const accountId = await this.ensureLedgerAccount(
      manager,
      'rider',
      riderId,
      'wallet',
      'liability',
      currency,
    );

    await manager.query(
      `
        INSERT INTO core.rider_wallets (rider_id, ledger_account_id, currency)
        VALUES ($1, $2, $3)
        ON CONFLICT (rider_id, currency) DO NOTHING
      `,
      [riderId, accountId, currency],
    );

    const rows = (await manager.query(
      `
        SELECT id, ledger_account_id
        FROM core.rider_wallets
        WHERE rider_id = $1 AND currency = $2
        FOR UPDATE
      `,
      [riderId, currency],
    )) as WalletRow[];
    if (!rows[0]) throw new Error('Failed to initialize rider wallet');
    return rows[0];
  }

  private async ensureLedgerAccount(
    manager: EntityManager,
    ownerType: 'rider' | 'driver' | 'platform',
    ownerId: string | null,
    accountCode: string,
    accountType: 'liability' | 'revenue',
    currency: string,
  ): Promise<string> {
    await manager.query(
      `
        INSERT INTO core.ledger_accounts (
          owner_type,
          owner_id,
          account_code,
          account_type,
          currency,
          status
        )
        VALUES ($1, $2, $3, $4, $5, 'active')
        ON CONFLICT DO NOTHING
      `,
      [ownerType, ownerId, accountCode, accountType, currency],
    );

    const rows = (await manager.query(
      `
        SELECT id
        FROM core.ledger_accounts
        WHERE owner_type = $1
          AND owner_id IS NOT DISTINCT FROM $2::uuid
          AND account_code = $3
          AND currency = $4
        FOR UPDATE
      `,
      [ownerType, ownerId, accountCode, currency],
    )) as Array<{ id: string }>;

    const id = rows[0]?.id;
    if (!id) throw new Error(`Failed to initialize ${ownerType} ledger account`);
    return id;
  }

  private async insertLedgerEntry(
    manager: EntityManager,
    transactionId: string,
    ledgerAccountId: string,
    side: 'debit' | 'credit',
    amount: Decimal,
    walletTransactionType:
      | 'ride_fare'
      | 'platform_commission'
      | 'cancellation_fee'
      | 'driver_payout'
      | 'user_topup',
  ): Promise<void> {
    if (amount.lte(0)) throw new ConflictException('Ledger entry amount must be positive');
    await manager.query(
      `
        INSERT INTO core.ledger_entries (
          transaction_id,
          ledger_account_id,
          entry_side,
          amount,
          wallet_transaction_type
        )
        VALUES ($1, $2, $3, $4::numeric, $5)
      `,
      [transactionId, ledgerAccountId, side, amount.toFixed(2), walletTransactionType],
    );
  }

  private async walletBalance(
    manager: EntityManager,
    ledgerAccountId: string,
  ): Promise<Decimal> {
    const rows = (await manager.query(
      'SELECT core.wallet_account_balance($1)::text AS balance',
      [ledgerAccountId],
    )) as Array<{ balance: string }>;
    return new Decimal(rows[0]?.balance ?? '0');
  }

  private resultFromExisting(
    trip: TripSettlementRow,
    transactionId: string,
  ): TripSettlementResult {
    const gross = new Decimal(trip.fare_amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const commissionRate = this.commissionRate();
    const commission = gross.mul(commissionRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const driverNet = gross.minus(commission).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    return this.resultFromAmounts(
      trip,
      transactionId,
      gross,
      commission,
      driverNet,
      true,
    );
  }

  private resultFromAmounts(
    trip: TripSettlementRow,
    transactionId: string,
    gross: Decimal,
    commission: Decimal,
    driverNet: Decimal,
    alreadySettled: boolean,
  ): TripSettlementResult {
    return {
      tripId: trip.id,
      transactionId,
      paymentMethod: trip.payment_method,
      grossFare: gross.toFixed(2),
      commission: commission.toFixed(2),
      driverNet: driverNet.toFixed(2),
      currency: trip.currency,
      alreadySettled,
    };
  }
}
