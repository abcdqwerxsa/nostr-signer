/// SIGNPOST · Nostr bunker 审批终端
///
/// 与自托管 bunker Worker（packages/bunker）配对使用：
/// 轮询待审批的 NIP-46 请求，一键批准或拒绝。
library;

import 'package:flutter/material.dart';

import 'api.dart';
import 'screens/queue_screen.dart';
import 'screens/setup_screen.dart';
import 'store.dart';
import 'theme.dart';

void main() {
  runApp(const SignpostApp());
}

class SignpostApp extends StatelessWidget {
  const SignpostApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'SIGNPOST',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      home: const _Gate(),
    );
  }
}

class _Gate extends StatefulWidget {
  const _Gate();

  @override
  State<_Gate> createState() => _GateState();
}

class _GateState extends State<_Gate> {
  BunkerApi? _api;
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    final api = await PairingStore().load();
    if (!mounted) return;
    setState(() {
      _api = api;
      _loaded = true;
    });
  }

  Future<void> _unpair() async {
    await PairingStore().clear();
    if (!mounted) return;
    setState(() => _api = null);
  }

  @override
  Widget build(BuildContext context) {
    if (!_loaded) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator(color: Sp.amber)),
      );
    }
    final api = _api;
    if (api == null) {
      return SetupScreen(
        onPaired: (a) => setState(() => _api = a),
      );
    }
    return QueueScreen(api: api, onUnpair: _unpair);
  }
}
