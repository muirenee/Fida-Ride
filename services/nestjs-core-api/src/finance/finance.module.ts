import { Module } from '@nestjs/common';
import { DriverFinancialGuard } from './driver-financial.guard';
import { DriverFinancialService } from './driver-financial.service';
import { WalletSettlementService } from './wallet-settlement.service';
import { WalletSettlementWorker } from './wallet-settlement.worker';

@Module({
  providers: [
    DriverFinancialService,
    DriverFinancialGuard,
    WalletSettlementService,
    WalletSettlementWorker,
  ],
  exports: [DriverFinancialService, DriverFinancialGuard, WalletSettlementService],
})
export class FinanceModule {}
