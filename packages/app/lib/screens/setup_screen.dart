/// 配对屏：录入 API BASE / PUBKEY / DEVICE TOKEN，
/// 或直接粘贴三段式配对串。
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api.dart';
import '../store.dart';
import '../theme.dart';
import '../widgets/panel.dart';

class SetupScreen extends StatefulWidget {
  const SetupScreen({super.key, required this.onPaired});

  final void Function(BunkerApi api) onPaired;

  @override
  State<SetupScreen> createState() => _SetupScreenState();
}

class _SetupScreenState extends State<SetupScreen> {
  final _pairing = TextEditingController();
  final _api = TextEditingController();
  final _pubkey = TextEditingController();
  final _token = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _pairing.addListener(_onPairingChanged);
  }

  void _onPairingChanged() {
    final raw = _pairing.text.trim();
    if (raw.isEmpty) return;
    final parsed = parsePairing(raw);
    if (parsed != null) {
      _api.text = parsed.apiBase;
      _pubkey.text = parsed.pubkey;
      _token.text = parsed.deviceToken;
    }
  }

  @override
  void dispose() {
    _pairing.removeListener(_onPairingChanged);
    _pairing.dispose();
    _api.dispose();
    _pubkey.dispose();
    _token.dispose();
    super.dispose();
  }

  Future<void> _link() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final pairingText = _pairing.text.trim();
      final pasted = parsePairing(pairingText);
      
      final String apiBase = (pasted?.apiBase ?? _api.text.trim()).replaceAll(RegExp(r'/+$'), '');
      final String pubkey = pasted?.pubkey ?? _pubkey.text.trim();
      final String deviceToken = pasted?.deviceToken ?? _token.text.trim();

      if (apiBase.isEmpty || !Uri.parse(apiBase).hasScheme) {
        throw const FormatException('API BASE 域名格式不正确 (需包含 https://)');
      }
      if (pubkey.length != 64) {
        throw const FormatException('PUBKEY 需为 64 位 hex 私钥派生公钥');
      }
      if (deviceToken.length < 8) {
        throw const FormatException('DEVICE TOKEN 无效或为空');
      }

      final api = BunkerApi(
        apiBase: apiBase,
        pubkey: pubkey,
        deviceToken: deviceToken,
      );

      // 连通性验证：能拉到 pending 即视为配对成功（401 会抛 ApiException）
      await api.pending();
      await PairingStore().save(api);
      widget.onPaired(api);
    } on ApiException catch (e) {
      setState(() => _error = 'bunker 拒绝：${e.message}');
    } on FormatException catch (e) {
      setState(() => _error = e.message);
    } catch (e) {
      setState(() => _error = '无法连接：$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: GridBackground(
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(28),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      children: [
                        const _SignpostMark(),
                        const SizedBox(width: 14),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            RichText(
                              text: const TextSpan(
                                style: TextStyle(fontFamily: mono, fontSize: 18, letterSpacing: 5, color: Sp.text, fontWeight: FontWeight.w600),
                                children: [
                                  TextSpan(text: 'SIGN'),
                                  TextSpan(text: 'POST', style: TextStyle(color: Sp.amber)),
                                ],
                              ),
                            ),
                            const SizedBox(height: 3),
                            eyebrow('BUNKER APPROVAL TERMINAL', color: Sp.textFaint),
                          ],
                        ),
                      ],
                    ),
                    const SizedBox(height: 34),
                    BracketPanel(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          eyebrow('PAIRING / 配对'),
                          const SizedBox(height: 6),
                          Text(
                            '在控制台 DEVICE PAIRING 面板复制三段式配对串粘贴到此处，或分别填写以下三项。',
                            style: TextStyle(fontFamily: mono, fontSize: 11, color: Sp.textDim, height: 1.8),
                          ),
                          const SizedBox(height: 14),
                          _field(_pairing, 'PAIRING STRING', 'api|pubkey|token'),
                          const Divider(height: 26),
                          _field(_api, 'API BASE', 'https://signpost.example.com'),
                          const SizedBox(height: 12),
                          _field(_pubkey, 'BUNKER PUBKEY (HEX)', '64 位 hex'),
                          const SizedBox(height: 12),
                          _field(_token, 'DEVICE TOKEN', '创建时一次性显示', obscure: true),
                          if (_error != null) ...[
                            const SizedBox(height: 14),
                            Text(
                              '✕$_error',
                              style: const TextStyle(fontFamily: mono, fontSize: 11, color: Sp.bad, height: 1.7),
                            ),
                          ],
                          const SizedBox(height: 18),
                          SizedBox(
                            height: 46,
                            child: ElevatedButton(
                              onPressed: _busy ? null : _link,
                              style: ElevatedButton.styleFrom(
                                backgroundColor: Sp.amber,
                                foregroundColor: Sp.bg,
                                shape: const RoundedRectangleBorder(side: BorderSide(color: Sp.amber)),
                                elevation: 0,
                              ),
                              child: _busy
                                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Sp.bg))
                                  : const Text('LINK / 接入', style: TextStyle(fontFamily: mono, fontSize: 12, letterSpacing: 3, fontWeight: FontWeight.w700)),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 24),
                    Center(
                      child: Text(
                        'KEYS SEALED · AES-GCM/HKDF · NIP-46',
                        style: TextStyle(fontFamily: mono, fontSize: 9, letterSpacing: 2, color: Sp.textFaint),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _field(TextEditingController c, String label, String hint, {bool obscure = false}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        eyebrow(label, color: Sp.textDim),
        const SizedBox(height: 6),
        TextField(
          controller: c,
          obscureText: obscure,
          style: const TextStyle(fontFamily: mono, fontSize: 12, color: Sp.amber),
          decoration: InputDecoration(
            hintText: hint,
            hintStyle: const TextStyle(fontFamily: mono, fontSize: 11, color: Sp.textFaint),
            isDense: true,
            filled: true,
            fillColor: Sp.bg,
            border: OutlineInputBorder(borderSide: const BorderSide(color: Sp.line2), borderRadius: BorderRadius.zero),
            enabledBorder: OutlineInputBorder(borderSide: const BorderSide(color: Sp.line2), borderRadius: BorderRadius.zero),
            focusedBorder: const OutlineInputBorder(borderSide: BorderSide(color: Sp.amber)),
            contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
          ),
          inputFormatters: [LengthLimitingTextInputFormatter(200)],
        ),
      ],
    );
  }
}

class _SignpostMark extends StatelessWidget {
  const _SignpostMark();

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 40,
      height: 40,
      child: CustomPaint(painter: _MarkPainter()),
    );
  }
}

class _MarkPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = Sp.amber
      ..strokeWidth = 2.2
      ..style = PaintingStyle.stroke;
    canvas.drawRect(Offset.zero & size, paint);
    final path = Path()
      ..moveTo(size.width * 0.26, size.height * 0.76)
      ..lineTo(size.width * 0.26, size.height * 0.24)
      ..lineTo(size.width * 0.5, size.height * 0.48)
      ..lineTo(size.width * 0.74, size.height * 0.24)
      ..lineTo(size.width * 0.74, size.height * 0.76);
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
