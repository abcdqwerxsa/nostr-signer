/// Bunker 设备 API 客户端。
///
/// 鉴权模型：per-bunker device token（Bearer），
/// 端点见 bunker Worker：/api/v1/:pubkey/{pending,decide,status}
library;

import 'dart:convert';

import 'package:http/http.dart' as http;

class ApiException implements Exception {
  ApiException(this.message, {this.statusCode});
  final String message;
  final int? statusCode;

  @override
  String toString() => '[$statusCode] $message';
}

class PendingRequest {
  PendingRequest({
    required this.rpcId,
    required this.client,
    required this.clientNpub,
    required this.method,
    required this.summary,
    required this.createdAt,
    required this.expiresAt,
  });

  final String rpcId;
  final String client;
  final String clientNpub;
  final String method;
  final Map<String, Object?> summary;
  final int createdAt;
  final int expiresAt;

  bool get isExpired => DateTime.now().millisecondsSinceEpoch > expiresAt;

  int get remainingSeconds =>
      ((expiresAt - DateTime.now().millisecondsSinceEpoch) / 1000).round();

  /// 人话描述：签什么 / 对谁加解密
  String get headline {
    switch (method) {
      case 'sign_event':
        final kind = summary['kind'];
        return '签名事件 · kind $kind';
      case 'nip44_encrypt' || 'nip04_encrypt':
        return '加密消息 → ${_shortNpub(summary['peer'] as String?)}';
      case 'nip44_decrypt' || 'nip04_decrypt':
        return '解密消息 ← ${_shortNpub(summary['peer'] as String?)}';
      default:
        return method;
    }
  }

  /// 需要人工审视的内容预览
  String? get bodyPreview {
    if (method == 'sign_event') return summary['content'] as String?;
    if (method.startsWith('nip44') || method.startsWith('nip04')) {
      return summary['text'] as String?;
    }
    return null;
  }

  static String _shortNpub(String? npub) =>
      npub == null ? '?' : '${npub.substring(0, npub.length < 12 ? npub.length : 12)}…';

  factory PendingRequest.fromJson(Map<String, Object?> j) => PendingRequest(
        rpcId: j['rpcId'] as String,
        client: j['client'] as String,
        clientNpub: j['clientNpub'] as String,
        method: j['method'] as String,
        summary: (j['summary'] as Map<String, Object?>?) ?? {},
        createdAt: j['createdAt'] as int,
        expiresAt: j['expiresAt'] as int,
      );
}

class BunkerStatus {
  BunkerStatus({
    required this.pubkeyNpub,
    required this.relays,
    required this.pendingCount,
    required this.sessions,
  });

  final String pubkeyNpub;
  final List<({String url, String state})> relays;
  final int pendingCount;
  final int sessions;

  int get linkedRelays => relays.where((r) => r.state == 'open').length;

  factory BunkerStatus.fromJson(Map<String, Object?> j) => BunkerStatus(
        pubkeyNpub: j['pubkeyNpub'] as String? ?? '',
        relays: ((j['relays'] as List?) ?? [])
            .map((r) => (url: (r as Map)['url'] as String, state: r['state'] as String))
            .toList(),
        pendingCount: j['pendingCount'] as int? ?? 0,
        sessions: ((j['sessions'] as List?) ?? []).length,
      );
}

class BunkerApi {
  BunkerApi({required this.apiBase, required this.pubkey, required this.deviceToken});

  final String apiBase; // 例如 https://signpost.example.com
  final String pubkey; // bunker pubkey hex
  final String deviceToken;

  Map<String, String> get _headers => {
        'Authorization': 'Bearer $deviceToken',
        'Content-Type': 'application/json',
      };

  Uri _uri(String path, [Map<String, String>? q]) => Uri.parse('$apiBase/api/v1/$pubkey$path').replace(
        queryParameters: q?.isEmpty == true ? null : q,
      );

  Future<Map<String, Object?>> _decode(http.Response res) async {
    final Map<String, Object?> body;
    try {
      body = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, Object?>;
    } catch (_) {
      throw ApiException('响应不是 JSON', statusCode: res.statusCode);
    }
    if (res.statusCode >= 400) {
      throw ApiException(body['error'] as String? ?? 'HTTP ${res.statusCode}',
          statusCode: res.statusCode);
    }
    return body;
  }

  Future<http.Response> _safeGet(String path) async {
    try {
      return await http.get(_uri(path), headers: _headers).timeout(const Duration(seconds: 10));
    } on http.ClientException catch (e) {
      if (e.message.contains('Failed host lookup') && !apiBase.contains('workers.dev')) {
        final fallbackUri = Uri.parse('https://nostr-signer-bunker.jeanpaul20020519.workers.dev/api/v1/$pubkey$path');
        return await http.get(fallbackUri, headers: _headers).timeout(const Duration(seconds: 10));
      }
      rethrow;
    }
  }

  Future<http.Response> _safePost(String path, Object? body) async {
    try {
      return await http.post(_uri(path), headers: _headers, body: jsonEncode(body)).timeout(const Duration(seconds: 15));
    } on http.ClientException catch (e) {
      if (e.message.contains('Failed host lookup') && !apiBase.contains('workers.dev')) {
        final fallbackUri = Uri.parse('https://nostr-signer-bunker.jeanpaul20020519.workers.dev/api/v1/$pubkey$path');
        return await http.post(fallbackUri, headers: _headers, body: jsonEncode(body)).timeout(const Duration(seconds: 15));
      }
      rethrow;
    }
  }

  Future<List<PendingRequest>> pending() async {
    final res = await _safeGet('/pending');
    final body = await _decode(res);
    return ((body['requests'] as List?) ?? [])
        .map((r) => PendingRequest.fromJson(r as Map<String, Object?>))
        .toList();
  }

  /// 决议：allow=true 批准并触发签名，false 拒绝。
  Future<String> decide(String rpcId, bool allow) async {
    final res = await _safePost('/decide', {'rpcId': rpcId, 'allow': allow});
    final body = await _decode(res);
    return body['status'] as String? ?? 'done';
  }

  Future<BunkerStatus> status() async {
    final res = await _safeGet('/status');
    return BunkerStatus.fromJson(await _decode(res));
  }
}
