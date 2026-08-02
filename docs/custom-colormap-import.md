# ParaView カラーマッププリセットの読み込み

Properties の **ParaView カラーマップ JSON を読み込む** から、ParaView preset JSONを
ブラウザ内へ読み込めます。読み込み後はpreset名がカラーマップ選択肢へ追加され、凡例と
サーフェス/ボリュームのtransfer functionへ同じ色停止点が反映されます。ファイルはサーバーへ
送信されません。

対応する最初のスライスは次のとおりです。

- 単一preset object、preset objectの配列、または `Presets` 配列
- `Name` と `RGBPoints`（scalar/R/G/Bの4値組）
- `Name` と `IndexedColors`（R/G/Bの3値組）
- RGB channelは0〜1、停止点は最大4096、JSONは最大1 MB

`RGBPoints` のscalar座標は最小値〜最大値を0〜1へ正規化します。壊れたJSON、重複する
scalar位置、非有限値、範囲外channelはエラーとして表示し、現在のカラーマップを変更しません。
import済みpresetは現在のブラウザセッション内で利用できます。presetを読み込んでいない新しい
セッションでは、そのcustom presetを参照する保存済みViewStateは安全に拒否されます。
