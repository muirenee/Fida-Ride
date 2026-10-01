import 'dart:convert';

String canonicalJson(Object? value) => jsonEncode(_canonicalize(value));

Object? _canonicalize(Object? value) {
  if (value == null || value is String || value is bool || value is num) {
    return value;
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
