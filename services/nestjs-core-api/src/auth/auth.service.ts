import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { RedisService } from '../redis/redis.service';
import { UsersService } from '../users/users.service';
import { RegisterDriverDto, RegisterRiderDto } from './dto/register.dto';

interface OtpRecord {
  phone: string;
  digest: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async registerRider(dto: RegisterRiderDto) {
    const user = await this.users.createRider({
      firstName: dto.first_name,
      lastName: dto.last_name,
      email: dto.email,
      phone: dto.phone,
    });

    return {
      id: user.id,
      first_name: user.firstName,
      last_name: user.lastName,
      phone: user.phone,
      email: user.email,
      status: user.status,
    };
  }

  async registerDriver(dto: RegisterDriverDto) {
    const { user, driver } = await this.users.createDriver({
      firstName: dto.first_name,
      lastName: dto.last_name,
      email: dto.email,
      phone: dto.phone,
      vehicleType: dto.vehicle_type,
      licensePlate: dto.license_plate,
    });

    return {
      user_id: user.id,
      driver_id: driver.id,
      phone: user.phone,
      vehicle_type: driver.vehicleType,
      license_plate: driver.licensePlate,
      verification_status: driver.verificationStatus,
    };
  }

  async requestPhoneLogin(phone: string) {
    const user = await this.users.findByPhone(phone);
    if (!user || user.status !== 'active') {
      return { accepted: true };
    }

    const challengeId = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const ttl = this.config.getOrThrow<number>('OTP_TTL_SECONDS');
    const digest = this.otpDigest(challengeId, phone, code);

    await Promise.all([
      this.redis.setEx(`auth:otp:${challengeId}`, ttl, JSON.stringify({ phone, digest } satisfies OtpRecord)),
      this.redis.setEx(`auth:otp:attempts:${challengeId}`, ttl, '0'),
    ]);

    const devEcho = this.config.getOrThrow<boolean>('OTP_DEV_ECHO');
    if (!devEcho) await this.deliverOtp(phone, code);

    return {
      accepted: true,
      challenge_id: challengeId,
      expires_in_seconds: ttl,
      ...(devEcho ? { dev_code: code } : {}),
    };
  }

  async verifyPhoneLogin(challengeId: string, code: string) {
    const recordKey = `auth:otp:${challengeId}`;
    const attemptsKey = `auth:otp:attempts:${challengeId}`;
    const maxAttempts = this.config.getOrThrow<number>('OTP_MAX_ATTEMPTS');

    const attempts = await this.redis.incr(attemptsKey);
    if (attempts > maxAttempts) {
      await this.redis.del(recordKey, attemptsKey);
      throw new UnauthorizedException('Verification challenge expired');
    }

    const raw = await this.redis.get(recordKey);
    if (!raw) throw new UnauthorizedException('Verification challenge expired');

    let record: OtpRecord;
    try {
      record = JSON.parse(raw) as OtpRecord;
    } catch {
      await this.redis.del(recordKey, attemptsKey);
      throw new UnauthorizedException('Verification challenge invalid');
    }

    const supplied = Buffer.from(this.otpDigest(challengeId, record.phone, code), 'hex');
    const expected = Buffer.from(record.digest, 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new UnauthorizedException('Invalid verification code');
    }

    await this.redis.del(recordKey, attemptsKey);

    const user = await this.users.findByPhone(record.phone);
    if (!user || user.status !== 'active') throw new UnauthorizedException('Account unavailable');

    const driver = await this.users.findDriverByUserId(user.id);
    const expiresIn = this.config.getOrThrow<number>('JWT_ACCESS_TTL_SECONDS');

    // Driver JWTs use the driver UUID as the subject so the same token can
    // authenticate the Go telemetry socket. user_id preserves the account UUID.
    const accessToken = await this.jwt.signAsync(
      {
        sub: driver?.id ?? user.id,
        user_id: user.id,
        role: driver ? 'driver' : 'rider',
        driver_id: driver?.id,
        phone: user.phone,
      },
      { expiresIn, algorithm: 'HS256' },
    );

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in_seconds: expiresIn,
      user_id: user.id,
      driver_id: driver?.id ?? null,
      role: driver ? 'driver' : 'rider',
    };
  }

  private otpDigest(challengeId: string, phone: string, code: string): string {
    return createHmac('sha256', this.config.getOrThrow<string>('OTP_HMAC_SECRET'))
      .update(`${challengeId}:${phone}:${code}`)
      .digest('hex');
  }

  private async deliverOtp(phone: string, code: string): Promise<void> {
    const url = this.config.get<string>('OTP_DELIVERY_URL');
    if (!url) {
      throw new ServiceUnavailableException('OTP delivery provider is not configured');
    }

    const token = this.config.get<string>('OTP_DELIVERY_TOKEN');
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ phone, code, purpose: 'fida_ride_login' }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new ServiceUnavailableException('OTP delivery provider rejected the request');
    }
  }
}
