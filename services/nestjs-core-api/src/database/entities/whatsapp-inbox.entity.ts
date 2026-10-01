import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type WhatsAppInboxStatus = 'pending' | 'processing' | 'completed' | 'failed';

@Entity({ schema: 'core', name: 'whatsapp_inbox' })
export class WhatsAppInboxEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'message_id', type: 'varchar', length: 255, unique: true })
  messageId!: string;

  @Column({ name: 'sender_phone', type: 'varchar', length: 32 })
  senderPhone!: string;

  @Column({ name: 'message_type', type: 'varchar', length: 32 })
  messageType!: string;

  @Column({ name: 'message_text', type: 'text', nullable: true })
  messageText!: string | null;

  @Column({ name: 'location_lat', type: 'double precision', nullable: true })
  locationLat!: number | null;

  @Column({ name: 'location_lng', type: 'double precision', nullable: true })
  locationLng!: number | null;

  @Column({ name: 'location_name', type: 'text', nullable: true })
  locationName!: string | null;

  @Column({ name: 'location_address', type: 'text', nullable: true })
  locationAddress!: string | null;

  @Column({ name: 'raw_payload', type: 'jsonb' })
  rawPayload!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: WhatsAppInboxStatus;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz' })
  nextAttemptAt!: Date;

  @Column({ name: 'locked_at', type: 'timestamptz', nullable: true })
  lockedAt!: Date | null;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
