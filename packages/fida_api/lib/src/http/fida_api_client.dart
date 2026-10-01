import 'package:dio/dio.dart';

typedef AccessTokenProvider = Future<String?> Function();

final class FidaApiException implements Exception {
  const FidaApiException({
    required this.message,
    this.statusCode,
    this.cause,
  });

  final String message;
  final int? statusCode;
  final Object? cause;

  @override
  String toString() => 'FidaApiException(statusCode: $statusCode, message: $message)';
}

final class FidaApiClient {
  FidaApiClient({
    required String baseUrl,
    AccessTokenProvider? accessTokenProvider,
    Duration connectTimeout = const Duration(seconds: 10),
    Duration receiveTimeout = const Duration(seconds: 20),
  }) : _dio = Dio(
          BaseOptions(
            baseUrl: baseUrl,
            connectTimeout: connectTimeout,
            receiveTimeout: receiveTimeout,
            sendTimeout: connectTimeout,
            responseType: ResponseType.json,
            headers: const <String, Object>{
              'accept': 'application/json',
              'content-type': 'application/json',
            },
          ),
        ) {
    if (accessTokenProvider != null) {
      _dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (
            RequestOptions options,
            RequestInterceptorHandler handler,
          ) async {
            final String? token = await accessTokenProvider();
            if (token != null && token.isNotEmpty) {
              options.headers['authorization'] = 'Bearer $token';
            }
            handler.next(options);
          },
        ),
      );
    }
  }

  final Dio _dio;

  Future<Map<String, Object?>> getJson(
    String path, {
    Map<String, Object?>? queryParameters,
  }) async {
    try {
      final Response<Object?> response = await _dio.get<Object?>(
        path,
        queryParameters: queryParameters,
      );
      return _asJsonObject(response.data);
    } on DioException catch (error) {
      throw _mapDioError(error);
    }
  }

  Future<Map<String, Object?>> postJson(
    String path, {
    Map<String, Object?>? body,
  }) async {
    try {
      final Response<Object?> response = await _dio.post<Object?>(
        path,
        data: body,
      );
      return _asJsonObject(response.data);
    } on DioException catch (error) {
      throw _mapDioError(error);
    }
  }

  Map<String, Object?> _asJsonObject(Object? value) {
    if (value is! Map<Object?, Object?>) {
      throw const FidaApiException(
        message: 'Server returned a non-object JSON response.',
      );
    }

    return value.map<String, Object?>(
      (Object? key, Object? item) => MapEntry<String, Object?>(
        key.toString(),
        item,
      ),
    );
  }

  FidaApiException _mapDioError(DioException error) {
    final Object? data = error.response?.data;
    String message = error.message ?? 'Network request failed.';

    if (data is Map<Object?, Object?>) {
      final Object? serverMessage = data['message'];
      if (serverMessage is String && serverMessage.isNotEmpty) {
        message = serverMessage;
      }
    }

    return FidaApiException(
      message: message,
      statusCode: error.response?.statusCode,
      cause: error,
    );
  }
}
