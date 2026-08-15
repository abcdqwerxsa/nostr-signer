import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:signpost/main.dart';

void main() {
  testWidgets('启动进入配对屏，品牌字标可见', (tester) async {
    SharedPreferences.setMockInitialValues({});
    await tester.pumpWidget(const SignpostApp());
    // _boot 的 SharedPreferences Future 需要一帧落下，再推进动画帧
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    // 字标为 RichText（SIGN+POST 双色拼接），textContaining 需显式开启 findRichText
    expect(find.textContaining('SIGN', findRichText: true), findsOneWidget);
    expect(find.text('PAIRING / 配对'), findsOneWidget);
  });
}
