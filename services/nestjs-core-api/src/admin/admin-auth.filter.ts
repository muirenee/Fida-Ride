import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  ForbiddenException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';

interface MinimalHttpResponse {
  status(code: number): MinimalHttpResponse;
  json(body: Record<string, unknown>): void;
}

@Catch(UnauthorizedException, ForbiddenException)
export class AdminAuthExceptionFilter implements ExceptionFilter {
  catch(exception: UnauthorizedException | ForbiddenException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalHttpResponse>();
    const forbidden = exception instanceof ForbiddenException;
    const statusCode = forbidden ? HttpStatus.FORBIDDEN : HttpStatus.UNAUTHORIZED;

    response.status(statusCode).json({
      statusCode,
      error: forbidden ? 'Forbidden' : 'Unauthorized',
      message: forbidden ? 'Administrative permission denied' : 'Administrative authentication required',
    });
  }
}
