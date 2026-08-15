/// SIGNPOST 视觉语言 —— 仪器面板 / 磷光琥珀。
/// 与 Web 控制台同一套 token：深墨底、琥珀单色、等宽字体、角标记。
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

class Sp {
  static const bg = Color(0xFF0B0C0E);
  static const bg2 = Color(0xFF111316);
  static const bg3 = Color(0xFF17191D);
  static const line = Color(0xFF26282D);
  static const line2 = Color(0xFF33363C);
  static const amber = Color(0xFFFFB224);
  static const amberDim = Color(0xFF8F6413);
  static const text = Color(0xFFD6D3CB);
  static const textDim = Color(0xFF8A877F);
  static const textFaint = Color(0xFF55534D);
  static const ok = Color(0xFF7EE081);
  static const bad = Color(0xFFFF6B5E);
}

const mono = 'monospace';

ThemeData buildTheme() {
  final base = ThemeData.dark(useMaterial3: true);
  return base.copyWith(
    scaffoldBackgroundColor: Sp.bg,
    colorScheme: base.colorScheme.copyWith(
      primary: Sp.amber,
      secondary: Sp.amber,
      surface: Sp.bg2,
      error: Sp.bad,
    ),
    textTheme: base.textTheme.apply(
      bodyColor: Sp.text,
      displayColor: Sp.text,
      fontFamily: mono,
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: Sp.bg,
      surfaceColor: Sp.bg,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(
        fontFamily: mono,
        fontSize: 13,
        letterSpacing: 3.5,
        color: Sp.text,
        fontWeight: FontWeight.w600,
      ),
      systemOverlayStyle: SystemUiOverlayStyle.light,
    ),
    dividerTheme: const DividerThemeData(color: Sp.line, thickness: 1, space: 1),
    snackBarTheme: const SnackBarThemeData(
      backgroundColor: Sp.bg3,
      contentTextStyle: TextStyle(fontFamily: mono, color: Sp.amber, fontSize: 13),
      behavior: SnackBarBehavior.floating,
    ),
  );
}

/// 大写间距小标 —— 面板眉标
Widget eyebrow(String text, {Color color = Sp.amber}) => Text(
      text.toUpperCase(),
      style: TextStyle(
        fontFamily: mono,
        fontSize: 10,
        letterSpacing: 2.6,
        color: color,
        fontWeight: FontWeight.w600,
      ),
    );

/// 状态胶囊
Widget pill(String text, {Color color = Sp.textDim}) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(border: Border.all(color: color)),
      child: Text(
        text.toUpperCase(),
        style: TextStyle(fontFamily: mono, fontSize: 9, letterSpacing: 1.6, color: color),
      ),
    );
