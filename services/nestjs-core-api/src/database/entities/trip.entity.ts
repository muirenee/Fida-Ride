import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type GeoPoint = { type: 'Point'; coordinates: [number, number] };
export type GeoLineString = { type: 'LineString'; coordinates: [number, number][] };

@Entity({ schema: 'core', name: 'trips' })
export class TripEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'rider_id', type: 'uuid' })
  riderId!: string;

  @Column({ name: 'driver_id', type: 'uuid', nullable: true })
  driverId!: string | null;

  @Column({ type: 'varchar', length: 24, default: 'created' })
  status!: string;

  @Column({ name: 'vehicle_type', type: 'varchar', length: 32 })
  vehicleType!: string;

  @Column({ name: 'source_channel', type: 'varchar', length: 32, nullable: true })
  sourceChannel!: string | null;

  @Column({ name: 'source_request_id', type: 'varchar', length: 255, nullable: true })
  sourceRequestId!: string | null;

  @Column({ name: 'fare_amount', type: 'numeric', precision: 19, scale: 4, nullable: true })
  fareAmount!: string | null;

  @Column({ type: 'char', length: 3, default: 'RWF' })
  currency!: string;

  @Column({ name: 'surge_multiplier', type: 'numeric', precision: 8, scale: 4, default: 1 })
  surgeMultiplier!: string;

  @Column({ name: 'payment_method', type: 'varchar', length: 16 })
  paymentMethod!: string;

  @Column({ name: 'pickup_location', type: 'geometry', spatialFeatureType: 'Point', srid: 4326 })
  pickupLocation!: GeoPoint;

  @Column({ name: 'dropoff_location', type: 'geometry', spatialFeatureType: 'Point', srid: 4326 })
  dropoffLocation!: GeoPoint;

  @Column({ name: 'ride_path', type: 'geometry', spatialFeatureType: 'LineString', srid: 4326, nullable: true })
  ridePath!: GeoLineString | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'matching_started_at', type: 'timestamptz', nullable: true })
  matchingStartedAt!: Date | null;

  @Column({ name: 'accepted_at', type: 'timestamptz', nullable: true })
  acceptedAt!: Date | null;

  @Column({ name: 'picked_up_at', type: 'timestamptz', nullable: true })
  pickedUpAt!: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
