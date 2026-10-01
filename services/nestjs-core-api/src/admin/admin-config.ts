import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export function adminString(
  config: ConfigService,
  key: string,
  fallback = '',
  minLength = 0,
): string {
  const value = String(config.get<unknown>(key) ?? fallback).trim();
  if (value.length < minLength) {
    throw new ServiceUnavailableException('Administrative authentication unavailable');
  }
  return value;
}

export function adminInteger(
  config: ConfigService,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = config.get<unknown>(key) ?? fallback;
  const value = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ServiceUnavailableException('Administrative authentication unavailable');
  }
  return value;
}

export function adminBoolean(
  config: ConfigService,
  key: string,
  fallback: boolean,
): boolean {
  const raw = config.get<unknown>(key);
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  const value = String(raw).trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ServiceUnavailableException('Administrative authentication unavailable');
}
