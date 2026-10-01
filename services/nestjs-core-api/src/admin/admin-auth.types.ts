export type AdminRole =
  | 'super_admin'
  | 'operations_admin'
  | 'finance_admin'
  | 'security_admin'
  | 'support_admin';

export interface AdminJwtPrincipal {
  sub: string;
  role: AdminRole;
  permissions: string[];
  sid: string;
  jti: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
}

export interface AdminSessionRecord {
  sub: string;
  role: AdminRole;
  permissions: string[];
  jti: string;
  issued_at: string;
}

export interface AdminAuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  path?: string;
  originalUrl?: string;
  admin?: AdminJwtPrincipal;
}
