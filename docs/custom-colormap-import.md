# ParaView カラーマッププリセットの読み込み

Properties の **ParaView カラーマップ JSON を読み込む** から、ParaView preset JSONを
ブラウザ内へ読み込めます。読み込み後はpreset名がカラーマップ選択肢へ追加され、凡例と
サーフェス/ボリュームのtransfer functionへ同じ色停止点が反映されます。読み込み時に元の
JSONファイル自体はサーバーへ送信されません（View保存時は後述の正規化済み定義を保存します）。

対応する最初のスライスは次のとおりです。

- 単一preset object、preset objectの配列、または `Presets` 配列
- `Name` と `RGBPoints`（scalar/R/G/Bの4値組）
- `Name` と `IndexedColors`（R/G/Bの3値組）
- RGB channelは0〜1、停止点は最大4096、JSONは最大1 MB

`RGBPoints` のscalar座標は最小値〜最大値を0〜1へ正規化します。壊れたJSON、重複する
scalar位置、非有限値、範囲外channelはエラーとして表示し、現在のカラーマップを変更しません。
import済みpresetを選んでViewを保存すると、preset IDに加えて表示名と正規化済み停止点が
ViewStateへ埋め込まれます。そのため、presetをまだ読み込んでいない新しいブラウザセッションでも、
保存済みViewを開くだけで同じカラーマップが復元されます。サーバーとブラウザの両方で、停止点数、
0〜1の有限な位置/RGB値、0と1の端点、位置の昇順、preset IDとの一致を検証します。不正な定義や、
同じIDですでに登録されている別定義は、現在のカラーマップを変更せず安全に拒否されます。

以前に保存された、定義を含まないcustom ViewStateにも互換性があります。そのpresetが現在の
セッションですでに読み込まれていれば従来どおり復元できます。未登録なら一度presetを読み込み、
Viewを保存し直すと、以後は新しいセッションでも自己完結して復元できます。組み込みカラーマップを
使うViewStateの保存形式は変わりません。
