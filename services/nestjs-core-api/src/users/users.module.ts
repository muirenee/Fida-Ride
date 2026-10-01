import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DriverEntity } from '../database/entities/driver.entity';
import { UserEntity } from '../database/entities/user.entity';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity, DriverEntity])],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
