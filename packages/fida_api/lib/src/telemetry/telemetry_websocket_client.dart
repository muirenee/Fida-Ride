import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:fida_api/src/telemetry/driver_telemetry_packet.dart';
import 'package:web_socket_channel/io.dart';

final class TelemetryWebSocketClient {
  TelemetryWebSocketClient({
    required this.endpoint,
    required this.accessToken,
    this.connectTimeout = const Duration(seconds: 10),
    this.pingInterval = const Duration(seconds: 20),
    this.reconnectDelay = const Duration(seconds: 2),
  });

  final Uri endpoint;
  final String accessToken;
  final Duration connectTimeout;
  final Duration pingInterval;
  final Duration reconnectDelay;

  IOWebSocketChannel? _channel;
  StreamSubscription<Object?>? _subscription;
  Completer<void>? _connecting;
  Timer? _reconnectTimer;
  String? _pendingPayload;
  bool _disposed = false;

  bool get isConnected => _channel != null;

  Future<void> connect() async {
    if (_disposed) {
      throw StateError('TelemetryWebSocketClient has been disposed.');
    }
    if (_channel != null) return;

    final Completer<void>? existing = _connecting;
    if (existing != null) return existing.future;

    final Completer<void> completer = Completer<void>();
    _connecting = completer;

    try {
      final IOWebSocketChannel channel = IOWebSocketChannel.connect(
        endpoint,
        headers: <String, dynamic>{
          HttpHeaders.authorizationHeader: 'Bearer $accessToken',
        },
        pingInterval: pingInterval,
        connectTimeout: connectTimeout,
      );

      await channel.ready;
      if (_disposed) {
        await channel.sink.close();
        completer.complete();
        return;
      }

      _channel = channel;
      _subscription = channel.stream.listen(
        (_) {},
        onError: (Object error, StackTrace stackTrace) {
          _markDisconnected();
        },
        onDone: _markDisconnected,
        cancelOnError: false,
      );

      _flushPending();
      completer.complete();
    } catch (error, stackTrace) {
      if (!completer.isCompleted) {
        completer.completeError(error, stackTrace);
      }
      _scheduleReconnect();
      rethrow;
    } finally {
      if (identical(_connecting, completer)) {
        _connecting = null;
      }
    }
  }

  Future<void> publish(DriverTelemetryPacket packet) async {
    if (_disposed) return;

    // Latest-wins buffering prevents an offline driver from accumulating an
    // unbounded backlog of stale coordinates.
    _pendingPayload = jsonEncode(packet.toJson());

    if (_channel == null) {
      try {
        await connect();
      } catch (_) {
        return;
      }
    }

    _flushPending();
  }

  void _flushPending() {
    final IOWebSocketChannel? channel = _channel;
    final String? payload = _pendingPayload;
    if (channel == null || payload == null) return;

    channel.sink.add(payload);
    _pendingPayload = null;
  }

  void _markDisconnected() {
    final StreamSubscription<Object?>? subscription = _subscription;
    _subscription = null;
    _channel = null;

    if (subscription != null) {
      unawaited(subscription.cancel());
    }

    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_disposed || _reconnectTimer?.isActive == true) return;

    _reconnectTimer = Timer(reconnectDelay, () {
      if (!_disposed && _channel == null) {
        unawaited(connect().catchError((Object _) {}));
      }
    });
  }

  Future<void> dispose() async {
    _disposed = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;

    await _subscription?.cancel();
    _subscription = null;

    await _channel?.sink.close();
    _channel = null;
  }
}
