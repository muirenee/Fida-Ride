import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { WalletSettlementService } from './wallet-settlement.service';

interface ClaimedSettlement {
  id: string;
  trip_id: string;
  attempts: number;
}

@Injectable()
export class WalletSettlementWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WalletSettlementWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly db: DataSource,
    private readonly settlement: WalletSettlementService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.schedule(0);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs?: number): void {
    if (this.stopped) return;
    const delay = delayMs ?? this.config.get<number>('WALLET_SETTLEMENT_POLL_MS', 500);
    this.timer = setTimeout(() => {
      void this.tick();
    }, delay);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) {
      this.schedule();
      return;
    }

    this.running = true;
    try {
      const batchSize = this.config.get<number>('WALLET_SETTLEMENT_BATCH_SIZE', 10);
      for (let index = 0; index < batchSize; index += 1) {
        const claimed = await this.claimNext();
        if (!claimed) break;
        await this.process(claimed);
      }
    } catch (error) {
      this.logger.error(
        'Wallet settlement worker tick failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  private async claimNext(): Promise<ClaimedSettlement | null> {
    const leaseSeconds = this.config.get<number>('WALLET_SETTLEMENT_LEASE_SECONDS', 120);
    const maxAttempts = this.config.get<number>('WALLET_SETTLEMENT_MAX_ATTEMPTS', 20);

    return this.db.transaction('READ COMMITTED', async (manager) => {
      const rows = (await manager.query(
        `
          SELECT id, trip_id, attempts
          FROM core.wallet_settlement_outbox
          WHERE attempts < $1
            AND (
              (status = 'pending' AND next_attempt_at <= NOW())
              OR
              (status = 'processing'
               AND locked_at < NOW() - ($2 * INTERVAL '1 second'))
            )
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `,
        [maxAttempts, leaseSeconds],
      )) as ClaimedSettlement[];

      const row = rows[0];
      if (!row) return null;

      const updated = (await manager.query(
        `
          UPDATE core.wallet_settlement_outbox
          SET status = 'processing',
              attempts = attempts + 1,
              locked_at = NOW(),
              last_error = NULL,
              updated_at = NOW()
          WHERE id = $1
          RETURNING id, trip_id, attempts
        `,
        [row.id],
      )) as ClaimedSettlement[];

      return updated[0] ?? null;
    });
  }

  private async process(claimed: ClaimedSettlement): Promise<void> {
    try {
      await this.settlement.settleCompletedTrip(claimed.trip_id);
      await this.db.query(
        `
          UPDATE core.wallet_settlement_outbox
          SET status = 'completed',
              completed_at = NOW(),
              locked_at = NULL,
              last_error = NULL,
              updated_at = NOW()
          WHERE id = $1
        `,
        [claimed.id],
      );
    } catch (error) {
      const maxAttempts = this.config.get<number>('WALLET_SETTLEMENT_MAX_ATTEMPTS', 20);
      const exhausted = claimed.attempts >= maxAttempts;
      const backoffSeconds = Math.min(300, Math.max(5, 2 ** Math.min(claimed.attempts, 8)));
      const message =
        error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000);

      await this.db.query(
        `
          UPDATE core.wallet_settlement_outbox
          SET status = $2,
              next_attempt_at = NOW() + ($3 * INTERVAL '1 second'),
              locked_at = NULL,
              last_error = $4,
              updated_at = NOW()
          WHERE id = $1
        `,
        [claimed.id, exhausted ? 'failed' : 'pending', backoffSeconds, message],
      );

      this.logger.warn(
        `Settlement failed for trip ${claimed.trip_id}; attempt ${claimed.attempts}: ${message}`,
      );
    }
  }
}
