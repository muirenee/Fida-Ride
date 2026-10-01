import { HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import { DataSource } from 'typeorm';
import { RedisService } from '../redis/redis.service';

interface DriverBalanceRow {
  driver_id: string;
  user_id: string;
  currency: string;
  balance: string;
}

export interface DriverFinancialSnapshot {
  driverId: string;
  userId: string;
  currency: string;
  balance: string;
  creditLimit: string;
  minimumAllowedBalance: string;
  blocked: boolean;
  amountDue: string;
}

@Injectable()
export class DriverFinancialService {
  constructor(
    private readonly db: DataSource,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async assertCanGoOnline(driverId: string): Promise<DriverFinancialSnapshot> {
    const snapshot = await this.getSnapshot(driverId);
    await this.syncRealtimeEligibility(snapshot, false);

    if (snapshot.blocked) {
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          code: 'DRIVER_WALLET_CREDIT_LIMIT_EXCEEDED',
          message:
            'Your driver wallet is below the allowed negative credit limit. Settle the outstanding platform balance before going online.',
          driver_id: snapshot.driverId,
          balance: snapshot.balance,
          currency: snapshot.currency,
          negative_credit_limit: snapshot.creditLimit,
          minimum_allowed_balance: snapshot.minimumAllowedBalance,
          amount_due: snapshot.amountDue,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    return snapshot;
  }

  async refreshRealtimeEligibility(driverId: string): Promise<DriverFinancialSnapshot> {
    const snapshot = await this.getSnapshot(driverId);
    await this.syncRealtimeEligibility(snapshot, true);
    return snapshot;
  }

  private async getSnapshot(driverId: string): Promise<DriverFinancialSnapshot> {
    const rows = (await this.db.query(
      `
        SELECT
          d.id AS driver_id,
          d.user_id,
          d.wallet_currency AS currency,
          COALESCE(
            core.wallet_account_balance(w.ledger_account_id),
            0::NUMERIC
          )::text AS balance
        FROM core.drivers d
        LEFT JOIN core.driver_wallets w
          ON w.driver_id = d.id
         AND w.currency = d.wallet_currency
        WHERE d.id = $1
        LIMIT 1
      `,
      [driverId],
    )) as DriverBalanceRow[];

    const row = rows[0];
    if (!row) throw new NotFoundException('Driver not found');

    const balance = new Decimal(row.balance);
    const creditLimit = new Decimal(
      this.config.get<string>('DRIVER_NEGATIVE_CREDIT_LIMIT', '15000'),
    );
    const minimumAllowed = creditLimit.negated();
    const blocked = balance.lt(minimumAllowed);
    const amountDue = blocked ? minimumAllowed.minus(balance) : new Decimal(0);

    return {
      driverId: row.driver_id,
      userId: row.user_id,
      currency: row.currency,
      balance: balance.toFixed(2),
      creditLimit: creditLimit.toFixed(2),
      minimumAllowedBalance: minimumAllowed.toFixed(2),
      blocked,
      amountDue: amountDue.toFixed(2),
    };
  }

  private async syncRealtimeEligibility(
    snapshot: DriverFinancialSnapshot,
    disconnectWhenBlocked: boolean,
  ): Promise<void> {
    const key = this.blockKey(snapshot.driverId);

    if (!snapshot.blocked) {
      await this.redis.del(key);
      return;
    }

    const ttlSeconds = this.config.get<number>('DRIVER_FINANCIAL_BLOCK_TTL_SECONDS', 86400);
    await this.redis.setEx(
      key,
      ttlSeconds,
      JSON.stringify({
        code: 'DRIVER_WALLET_CREDIT_LIMIT_EXCEEDED',
        balance: snapshot.balance,
        currency: snapshot.currency,
        minimum_allowed_balance: snapshot.minimumAllowedBalance,
        amount_due: snapshot.amountDue,
        checked_at: new Date().toISOString(),
      }),
    );

    if (!disconnectWhenBlocked) return;

    await this.redis.publish(
      'security:disconnect',
      JSON.stringify({
        event: 'security_disconnect',
        user_id: '',
        driver_id: snapshot.driverId,
        action: 'financial_hold',
        reason: 'driver_wallet_credit_limit_exceeded',
        issued_at: new Date().toISOString(),
      }),
    );
  }

  private blockKey(driverId: string): string {
    return `finance:driver-online-block:${driverId}`;
  }
}
