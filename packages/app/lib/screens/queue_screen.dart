/// 审批队列屏：轮询 pending，逐卡展示，批准/拒绝。
/// 这是整个 App 的核心操作面 —— 大按钮、倒计时条、内容预览必须一眼可读。
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api.dart';
import '../theme.dart';
import '../widgets/panel.dart';

class QueueScreen extends StatefulWidget {
  const QueueScreen({super.key, required this.api, required this.onUnpair});

  final BunkerApi api;
  final VoidCallback onUnpair;

  @override
  State<QueueScreen> createState() => _QueueScreenState();
}

class _QueueScreenState extends State<QueueScreen> {
  List<PendingRequest> _requests = [];
  String? _error;
  bool _loading = true;
  Timer? _timer;
  Timer? _ticker;
  final _deciding = <String>{};

  @override
  void initState() {
    super.initState();
    _refresh();
    _timer = Timer.periodic(const Duration(seconds: 3), (_) => _refresh());
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (_requests.any((r) => r.remainingSeconds <= 0)) setState(() {});
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _ticker?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    try {
      final reqs = await widget.api.pending();
      if (!mounted) return;
      setState(() {
        _requests = reqs;
        _error = null;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    }
  }

  Future<void> _decide(PendingRequest r, bool allow) async {
    setState(() => _deciding.add(r.rpcId));
    final messenger = ScaffoldMessenger.of(context);
    try {
      final status = await widget.api.decide(r.rpcId, allow);
      messenger.showSnackBar(SnackBar(
        content: Text(allow ? '已批准 · $status' : '已拒绝 · $status'),
      ));
    } on ApiException catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('失败：${e.message}')));
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('失败：$e')));
    } finally {
      if (mounted) {
        setState(() => _deciding.remove(r.rpcId));
        _refresh();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final live = _requests.where((r) => !r.isExpired).toList();
    return Scaffold(
      body: GridBackground(
        child: SafeArea(
          child: RefreshIndicator(
            color: Ink.amber,
            backgroundColor: Ink.bg2,
            onRefresh: _refresh,
            child: _loading
                ? const Center(child: CircularProgressIndicator(color: Ink.amber))
                : ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(20, 18, 20, 32),
                    children: [
                      _header(live.length),
                      const SizedBox(height: 18),
                      if (_error != null)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 16),
                          child: Text(
                            'LINK ERROR / $_error',
                            style: const TextStyle(fontFamily: mono, fontSize: 11, color: Ink.bad, height: 1.7),
                          ),
                        ),
                      if (live.isEmpty) _emptyState(),
                      for (final r in live) ...[
                        _ApprovalCard(
                          request: r,
                          busy: _deciding.contains(r.rpcId),
                          onAllow: () => _decide(r, true),
                          onDeny: () => _decide(r, false),
                        ),
                        const SizedBox(height: 14),
                      ],
                    ],
                  ),
          ),
        ),
      ),
    );
  }

  Widget _header(int count) {
    return Row(
      children: [
        const _SmallMark(),
        const SizedBox(width: 12),
        RichText(
          text: TextSpan(
            style: const TextStyle(fontFamily: mono, fontSize: 15, letterSpacing: 4, color: Ink.text, fontWeight: FontWeight.w600),
            children: const [
              TextSpan(text: 'SIGN'),
              TextSpan(text: 'POST', style: TextStyle(color: Ink.amber)),
            ],
          ),
        ),
        const SizedBox(width: 12),
        count > 0 ? pill('$count PENDING', color: Ink.amber) : pill('ALL CLEAR', color: Ink.ok),
        const Spacer(),
        IconButton(
          visualDensity: VisualDensity.compact,
          onPressed: () => showDialog(
            context: context,
            builder: (_) => AlertDialog(
              backgroundColor: Ink.bg2,
              shape: RoundedRectangleBorder(side: BorderSide(color: Ink.line2)),
              title: const Text('解除配对？', style: TextStyle(fontFamily: mono, fontSize: 14)),
              content: const Text('清除本机保存的 device token。', style: TextStyle(fontFamily: mono, fontSize: 12, color: Ink.textDim)),
              actions: [
                TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
                TextButton(onPressed: () => widget.onUnpair(), child: const Text('解除', style: TextStyle(color: Ink.bad))),
              ],
            ),
          ),
          icon: const Icon(Icons.link_off, size: 18, color: Ink.textDim),
        ),
      ],
    );
  }

  Widget _emptyState() {
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 320),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Beacon(),
          const SizedBox(height: 18),
          Text(
            '哨位无待审批请求',
            style: TextStyle(fontFamily: mono, fontSize: 12, letterSpacing: 2, color: Ink.textDim),
          ),
          const SizedBox(height: 8),
          Text(
            'SIGNING REQUESTS WILL APPEAR HERE',
            style: TextStyle(fontFamily: mono, fontSize: 9, letterSpacing: 2.4, color: Ink.textFaint),
          ),
        ],
      ),
    );
  }
}

class _ApprovalCard extends StatefulWidget {
  const _ApprovalCard({
    required this.request,
    required this.busy,
    required this.onAllow,
    required this.onDeny,
  });

  final PendingRequest request;
  final bool busy;
  final VoidCallback onAllow;
  final VoidCallback onDeny;

  @override
  State<_ApprovalCard> createState() => _ApprovalCardState();
}

class _ApprovalCardState extends State<_ApprovalCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final request = widget.request;
    final body = request.bodyPreview;
    return BracketPanel(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Text(
                request.method,
                style: const TextStyle(fontFamily: mono, fontSize: 13, letterSpacing: 1.2, color: Ink.amber, fontWeight: FontWeight.w700),
              ),
              const SizedBox(width: 10),
              if (request.summary['kind'] != null) pill('KIND ${request.summary['kind']}'),
              const Spacer(),
              const Beacon(color: Ink.amber),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            request.headline,
            style: const TextStyle(fontFamily: mono, fontSize: 12, color: Ink.text, height: 1.6),
          ),
          const SizedBox(height: 4),
          Text(
            'FROM ${request.clientNpub.substring(0, request.clientNpub.length.clamp(0, 20))}…',
            style: const TextStyle(fontFamily: mono, fontSize: 10, color: Ink.textFaint, letterSpacing: 1),
          ),
          if (body != null && body.isNotEmpty) ...[
            const SizedBox(height: 12),
            Container(
              width: double.infinity,
              constraints: const BoxConstraints(maxHeight: 140),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: Ink.bg, border: Border.all(color: Ink.line)),
              child: SingleChildScrollView(
                child: Text(
                  body,
                  style: const TextStyle(fontFamily: mono, fontSize: 11, color: Ink.textDim, height: 1.6),
                ),
              ),
            ),
          ],
          // 详情展开：完整请求摘要（tags 等）
          GestureDetector(
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Text(
                _expanded ? '▾ 收起详情' : '▸ 请求详情',
                style: const TextStyle(fontFamily: mono, fontSize: 10, letterSpacing: 1.4, color: Ink.textDim),
              ),
            ),
          ),
          if (_expanded)
            Container(
              width: double.infinity,
              margin: const EdgeInsets.only(top: 8),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: Ink.bg, border: Border.all(color: Ink.line2)),
              child: Text(
                const JsonEncoder.withIndent('  ').convert(request.summary),
                style: const TextStyle(fontFamily: mono, fontSize: 10, color: Ink.textDim, height: 1.7),
              ),
            ),
          const SizedBox(height: 14),
          CountdownBar(
            remaining: request.remainingSeconds < 0 ? 0 : request.remainingSeconds,
            total: 120,
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: SizedBox(
                  height: 44,
                  child: OutlinedButton(
                    onPressed: busy ? null : onDeny,
                    style: OutlinedButton.styleFrom(
                      side: const BorderSide(color: Ink.bad),
                      foregroundColor: Ink.bad,
                      shape: const RoundedRectangleBorder(),
                      elevation: 0,
                    ),
                    child: const Text('DENY 拒绝', style: TextStyle(fontFamily: mono, fontSize: 11, letterSpacing: 2)),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: SizedBox(
                  height: 44,
                  child: OutlinedButton(
                    onPressed: busy ? null : onAllow,
                    style: OutlinedButton.styleFrom(
                      side: const BorderSide(color: Ink.amber),
                      backgroundColor: Ink.amber,
                      foregroundColor: Ink.bg,
                      shape: const RoundedRectangleBorder(),
                      elevation: 0,
                    ),
                    child: busy
                        ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: Ink.bg))
                        : const Text('APPROVE 批准', style: TextStyle(fontFamily: mono, fontSize: 11, letterSpacing: 2, fontWeight: FontWeight.w700)),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _SmallMark extends StatelessWidget {
  const _SmallMark();

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 22,
      height: 22,
      child: CustomPaint(
        painter: _SmallMarkPainter(),
      ),
    );
  }
}

class _SmallMarkPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = Ink.amber
      ..strokeWidth = 1.8
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
