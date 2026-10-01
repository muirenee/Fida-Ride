import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ schema: 'core', name: 'users' })
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'first_name', type: 'varchar', length: 100 })
  firstName!: string;

  @Column({ name: 'last_name', type: 'varchar', length: 100 })
  lastName!: string;

  @Column({ type: 'varchar', length: 320, nullable: true })
  email!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  @Column({ name: 'wallet_balance', type: 'numeric', precision: 19, scale: 4, default: 0 })
  walletBalance!: string;

  @Column({ name: 'wallet_currency', type: 'char', length: 3, default: 'RWF' })
  walletCurrency!: string;

  @Column({ type: 'numeric', precision: 3, scale: 2, default: 5 })
  rating!: string;

  @Column({ type: 'varchar', length: 24, default: 'active' })
  status!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
