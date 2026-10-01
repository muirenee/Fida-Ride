import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:uuid/uuid.dart';

final class InstallationIdentityService {
  InstallationIdentityService({FlutterSecureStorage? storage, Uuid? uuid})
    : _storage = storage ?? const FlutterSecureStorage(),
      _uuid = uuid ?? const Uuid();

  static const String _storageKey = 'fida.installation.uuid.v1';

  final FlutterSecureStorage _storage;
  final Uuid _uuid;

  String? _cached;

  Future<String> getOrCreate() async {
    final String? cached = _cached;
    if (cached != null && cached.isNotEmpty) return cached;

    final String? stored = await _storage.read(
      key: _storageKey,
      aOptions: const AndroidOptions(),
      iOptions: const IOSOptions(
        accessibility: KeychainAccessibility.first_unlock_this_device,
      ),
    );

    if (stored != null && Uuid.isValidUUID(fromString: stored)) {
      _cached = stored;
      return stored;
    }

    final String installationId = _uuid.v4();
    await _storage.write(
      key: _storageKey,
      value: installationId,
      aOptions: const AndroidOptions(),
      iOptions: const IOSOptions(
        accessibility: KeychainAccessibility.first_unlock_this_device,
      ),
    );
    _cached = installationId;
    return installationId;
  }
}
