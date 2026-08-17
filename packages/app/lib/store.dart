/// 配对信息持久化。device token 属于敏感凭据，
/// 生产可换 flutter_secure_storage；当前以 shared_preferences 起步。
library;

import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';

class PairingStore {
  static const _key = 'signpost_pairing';

  Future<BunkerApi?> load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_key);
    if (raw == null) return null;
    try {
      final j = jsonDecode(raw) as Map<String, dynamic>;
      return BunkerApi(
        apiBase: j['apiBase'] as String,
        pubkey: j['pubkey'] as String,
        deviceToken: j['deviceToken'] as String,
      );
    } catch (_) {
      return null;
    }
  }

  Future<void> save(BunkerApi api) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, jsonEncode({
      'apiBase': api.apiBase,
      'pubkey': api.pubkey,
      'deviceToken': api.deviceToken,
    }));
  }

  Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_key);
  }
}

/// 解析配对串：支持 "apiBase|pubkey|token" 三段式（控制台一键复制的格式），
/// 也支持完整 "bunker://..."? 不 —— 配对串只与本 Worker 通信。
BunkerApi? parsePairing(String raw) {
  final parts = raw
      .trim()
      .split(RegExp(r'[|\s]+'))
      .where((s) => s.isNotEmpty)
      .toList();
  if (parts.length != 3) return null;
  var apiBase = parts[0].replaceAll(RegExp(r'/+$'), '');
  if (!apiBase.startsWith('http://') && !apiBase.startsWith('https://')) {
    apiBase = 'https://$apiBase';
  }
  final pubkey = parts[1];
  final token = parts[2];
  final uri = Uri.tryParse(apiBase);
  final okBase = uri != null && uri.hasScheme && uri.host.isNotEmpty;
  final okPubkey = RegExp(r'^[0-9a-f]{64}$').hasMatch(pubkey);
  if (!okBase || !okPubkey || token.length < 16) return null;
  return BunkerApi(apiBase: apiBase, pubkey: pubkey, deviceToken: token);
}
