import 'dart:convert';

String canonicalJson(Object? value) => jsonEncode(_canonicalize(value));

Object? _canonicalize(Object? value) {
  if (value == null || value is String || value is bool) {
    return value;
  }
  if (value is num) {
    return <String, String>{r'$fida_number': _canonicalNumber(value)};
  }
  if (value is List<Object?>) {
    return value.map<Object?>(_canonicalize).toList(growable: false);
  }
  if (value is Map<Object?, Object?>) {
    final List<String> keys =
        value.keys.map<String>((Object? key) => key.toString()).toList()
          ..sort();
    return <String, Object?>{
      for (final String key in keys) key: _canonicalize(value[key]),
    };
  }
  throw ArgumentError.value(
    value,
    'value',
    'Unsupported canonical JSON value.',
  );
}

String _canonicalNumber(num value) {
  final double normalized = value.toDouble();
  if (!normalized.isFinite) {
    throw ArgumentError.value(
      value,
      'value',
      'Canonical JSON numbers must be finite.',
    );
  }
  if (normalized == 0) return '0';

  const double maxSafeInteger = 9007199254740991;
  if (normalized == normalized.truncateToDouble()) {
    if (normalized.abs() > maxSafeInteger) {
      throw ArgumentError.value(
        value,
        'value',
        'Canonical integer exceeds the JavaScript safe integer range.',
      );
    }
    return normalized.toInt().toString();
  }

  if (normalized.abs() >= 1000000000000000) {
    throw ArgumentError.value(
      value,
      'value',
      'Canonical fractional number magnitude is too large.',
    );
  }

  final String fixed = normalized.toStringAsFixed(12);
  return fixed
      .replaceFirst(RegExp(r'0+$'), '')
      .replaceFirst(RegExp(r'\.$'), '');
}
