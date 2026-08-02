# VTS/VTR ブラウザ直読

G8 では VTK XML の `StructuredGrid`（`.vts`）と `RectilinearGrid`（`.vtr`）を、
ParaView worker への変換ジョブなしで vtk.js の `PolyData` として表示する。

## 対応範囲

- `byte_order="LittleEndian"`
- `header_type="UInt32"` / `"UInt64"`
- `DataArray format="ascii"`
- inline base64 の `format="binary"`
- `encoding="raw"` の `AppendedData`
- 非圧縮、および `vtkZLibDataCompressor`
- 複数 `Piece`（各 Piece の外表面を結合）
- point/cell DataArray（cell値は抽出した外表面要素へ引き継ぐ）
- 3次元格子は外表面quad、2次元格子はquad、1次元格子はline、単一点はvertexとして表示
- 1 documentあたり合計200万source point以下（超過時は配列確保前にserver VTP conversionへ誘導）

ブラウザ側パーサが扱わない big-endian、base64 AppendedData、未知の compressor/header、
不正な extent/tuple数や上限超過は成功扱いにしない。3次元のtopology生成は内部cellを走査せず
6境界面だけを走査する。ビューアに理由と server VTP conversion の案内を表示し、従来の
サーバ側 **Convert to VTP** 操作をフォールバックとして残す。

現行実装は境界topologyだけを生成する一方、source pointとpoint attributeは格子全体ぶんを
保持し、複数Piece結合時にcopyする。200万point上限はこの使用量を有界にする安全策であり、
attribute配列数に応じた増加は別途発生する。将来この上限を引き上げる場合は、境界で参照する
pointとattributeだけへ再indexするcompactionを先に実装する。

## 自動検証

```bash
cd frontend
npm test -- --run src/lib/structuredGrid.test.ts src/lib/vtu.test.ts \
  src/lib/viewer/scenes.test.ts
npm run typecheck
npm run lint
npm run build
```

テストfixtureは `frontend/src/lib/fixtures/sample_structured.vts` と
`sample_rectilinear.vtr`。ASCII の代表例に加え、テスト内で inline binary と raw appended
の入力も生成して確認する。

## 手動確認

1. VTS と VTR をそれぞれ単一ファイルとしてアップロードする。
2. Network panel で dataset source の GET 以外に convert job が発行されないことを確認する。
3. 外表面、point/cell scalar着色、surface/wireframe/points、clip/probe/計測を確認する。
4. **Export current geometry** で、ブラウザ抽出面を VTP として保存できることを確認する。
5. big-endian、200万point超過等の非対応fixtureでは描画エラーと server VTP conversion の案内が表示され、
   ParaView worker 設定時には従来の **Convert to VTP** が利用できることを確認する。
