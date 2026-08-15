/// 面板组件：角标记容器 + 蓝图网格背景 + 信标脉冲。
/// 全部 CustomPainter 手绘，构成 App 的辨识度骨架。
library;

import 'package:flutter/material.dart';

import '../theme.dart';

/// 四角带琥珀角标的容器
class BracketPanel extends StatelessWidget {
  const BracketPanel({super.key, required this.child, this.padding = const EdgeInsets.all(16)});

  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        border: Border.all(color: Ink.line),
        color: Ink.bg2,
      ),
      padding: padding,
      child: Stack(
        children: [
          child,
          const Positioned(top: -5, left: -5, child: _Corner()),
          Positioned(top: -5, right: -5, child: _Corner(flipX: true)),
          Positioned(bottom: -5, left: -5, child: _Corner(flipY: true)),
          Positioned(bottom: -5, right: -5, child: _Corner(flipX: true, flipY: true)),
        ],
      ),
    );
  }
}

class _Corner extends StatelessWidget {
  const _Corner({this.flipX = false, this.flipY = false});

  final bool flipX;
  final bool flipY;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 10,
      height: 10,
      child: CustomPaint(
        painter: _CornerPainter(flipX: flipX, flipY: flipY),
      ),
    );
  }
}

class _CornerPainter extends CustomPainter {
  _CornerPainter({required this.flipX, required this.flipY});

  final bool flipX;
  final bool flipY;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = Ink.amber
      ..strokeWidth = 2
      ..style = PaintingStyle.stroke;
    final path = Path();
    if (!flipX && !flipY) {
      path.moveTo(0, size.height);
      path.lineTo(0, 0);
      path.lineTo(size.width, 0);
    } else if (flipX && !flipY) {
      path.moveTo(0, 0);
      path.lineTo(size.width, 0);
      path.lineTo(size.width, size.height);
    } else if (!flipX && flipY) {
      path.moveTo(size.width, 0);
      path.lineTo(0, 0);
      path.lineTo(0, size.height);
    } else {
      path.moveTo(0, size.height);
      path.lineTo(size.width, size.height);
      path.lineTo(size.width, 0);
    }
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(covariant _CornerPainter oldDelegate) =>
      oldDelegate.flipX != flipX || oldDelegate.flipY != flipY;
}

/// 蓝图网格背景
class GridBackground extends StatelessWidget {
  const GridBackground({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      foregroundPainter: _GridPainter(),
      child: child,
    );
  }
}

class _GridPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = Ink.bg3
      ..strokeWidth = 1;
    const cell = 44.0;
    for (double x = 0; x < size.width; x += cell) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), paint);
    }
    for (double y = 0; y < size.height; y += cell) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), paint);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// 待审批卡片的倒计时条：琥珀 → 变红耗尽
class CountdownBar extends StatelessWidget {
  const CountdownBar({super.key, required this.remaining, required this.total});

  final int remaining; // 秒
  final int total; // 秒

  @override
  Widget build(BuildContext context) {
    final frac = (remaining / total).clamp(0.0, 1.0);
    final color = frac > 0.4 ? Ink.amber : frac > 0.2 ? Colors.orange : Ink.bad;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(
              'T-${remaining}s',
              style: TextStyle(fontFamily: mono, fontSize: 10, color: color, letterSpacing: 1.4),
            ),
            const Spacer(),
            Text(
              'EXPIRES',
              style: TextStyle(fontFamily: mono, fontSize: 9, color: Ink.textFaint, letterSpacing: 1.6),
            ),
          ],
        ),
        const SizedBox(height: 4),
        ClipRect(
          child: Align(
            alignment: Alignment.centerLeft,
            widthFactor: frac == 0 ? 0.001 : frac,
            child: Container(height: 3, color: color),
          ),
        ),
      ],
    );
  }
}

/// 空闲信标：呼吸脉冲点
class Beacon extends StatefulWidget {
  const Beacon({super.key, this.color = Ink.ok});

  final Color color;

  @override
  State<Beacon> createState() => _BeaconState();
}

class _BeaconState extends State<Beacon> with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl =
      AnimationController(vsync: this, duration: const Duration(seconds: 2))..repeat();

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: Tween(begin: 0.25, end: 1.0).animate(
        CurvedAnimation(parent: _ctrl, curve: Curves.easeInOut),
      ),
      child: Container(
        width: 10,
        height: 10,
        decoration: BoxDecoration(color: widget.color, shape: BoxShape.circle),
      ),
    );
  }
}
