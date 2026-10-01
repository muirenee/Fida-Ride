import { Column, Entity, JoinColumn, OneToOne, PrimaryGeneratedColumn } from 'typeorm';
import { UserEntity } from './user.entity';

@Entity({ schema: 'core', name: 'drivers' })
export class DriverEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid', unique: true })
  userId!: string;

  @OneToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user!: UserEntity;

  @Column({ name: 'vehicle_type', type: 'varchar', length: 32 })
  vehicleType!: string;

  @Column({ name: 'license_plate', type: 'varchar', length: 32 })
  licensePlate!: string;

  @Column({ name: 'verification_status', type: 'varchar', length: 24, default: 'pending' })
  verificationStatus!: string;

  @Column({ name: 'current_wallet_balance', type: 'numeric', precision: 19, scale: 4, default: 0 })
  currentWalletBalance!: string;

  @Column({ name: 'wallet_currency', type: 'char', length: 3, default: 'RWF' })
  walletCurrency!: string;

  @Column({ name: 'is_online', type: 'boolean', default: false })
  isOnline!: boolean;

  @Column({ name: 'is_available', type: 'boolean', default: false })
  isAvailable!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
