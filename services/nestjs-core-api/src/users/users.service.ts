import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { DriverEntity } from '../database/entities/driver.entity';
import { UserEntity } from '../database/entities/user.entity';

export interface CreateUserInput {
  firstName: string;
  lastName: string;
  email?: string;
  phone: string;
}

export interface CreateDriverInput extends CreateUserInput {
  vehicleType: string;
  licensePlate: string;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(DriverEntity)
    private readonly drivers: Repository<DriverEntity>,
    private readonly dataSource: DataSource,
  ) {}

  findByPhone(phone: string): Promise<UserEntity | null> {
    return this.users.findOne({ where: { phone } });
  }

  async requireById(id: string): Promise<UserEntity> {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Rider not found');
    return user;
  }

  findDriverByUserId(userId: string): Promise<DriverEntity | null> {
    return this.drivers.findOne({ where: { userId } });
  }

  async createRider(input: CreateUserInput): Promise<UserEntity> {
    try {
      const user = this.users.create({
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        email: input.email?.trim().toLowerCase() ?? null,
        phone: input.phone,
        status: 'active',
      });
      return await this.users.save(user);
    } catch (error) {
      this.rethrowConflict(error);
    }
  }

  async createDriver(input: CreateDriverInput): Promise<{ user: UserEntity; driver: DriverEntity }> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const userRepo = manager.getRepository(UserEntity);
        const driverRepo = manager.getRepository(DriverEntity);

        const user = await userRepo.save(
          userRepo.create({
            firstName: input.firstName.trim(),
            lastName: input.lastName.trim(),
            email: input.email?.trim().toLowerCase() ?? null,
            phone: input.phone,
            status: 'active',
          }),
        );

        const driver = await driverRepo.save(
          driverRepo.create({
            userId: user.id,
            vehicleType: input.vehicleType,
            licensePlate: input.licensePlate.trim().toUpperCase(),
            verificationStatus: 'pending',
            isOnline: false,
            isAvailable: false,
          }),
        );

        return { user, driver };
      });
    } catch (error) {
      this.rethrowConflict(error);
    }
  }

  private rethrowConflict(error: unknown): never {
    if (error instanceof QueryFailedError) {
      const code = (error.driverError as { code?: string } | undefined)?.code;
      if (code === '23505') {
        throw new ConflictException('Phone, email, or license plate is already registered');
      }
    }
    throw error;
  }
}
