# MyParaView-Web 追加機能候補

作成日: 2026-07-09 (JST)

> 実装更新 (2026-07-10): 本文の17候補はすべて、直接実装または外部capabilityへ接続する
> 安全な最小スライスとして対応した。項目別の状態、必要な外部runtime、意図的なfallbackは
> [`docs/implementation-status.md`](docs/implementation-status.md)を参照。特にParaView/trameと
> WebGPUは、未導入環境で成功を偽らない契約/検証スライスである。

## 調査方法

メインエージェントでリポジトリの既存実装、README、作業計画、ADR、主要ソースを確認し、並行してサブエージェント3本で以下の観点を調査した。

- バックエンド/API/データモデル観点
- フロントエンド/UI/VTKビューア観点
- 外部動向/ParaView・VTK Webエコシステム観点

## 現状整理

このリポジトリは M1 MVP として、FastAPI + SQLite + ローカル object store + in-process job manager、React + vtk.js の構成で実装されている。主な実装済み機能は、プロジェクト作成、データセットアップロード、メタデータ抽出、ジョブ状態管理、Pipeline DAGの保存、PolyDataのブラウザ描画、surface/wireframe/points 表示、point array のスカラー着色、カメラリセット、スクリーンショットである。

一方で、現状のブラウザ直接描画は `PolyData` に限定される。`ImageData`、`UnstructuredGrid`、`Collection` などはメタデータ抽出まではできるが表示は未実装で、サーバレンダリングや変換ジョブに渡す前提になっている。Pipeline APIも保存中心で、Slice/Clip/Contour/Threshold などの実行系は未接続である。

外部動向としては、旧 `ParaViewWeb` を新規基盤にするより、`vtk.js` と `trame` を中心に、必要に応じて ParaView/VTK サーバ処理、WebAssembly、WebGPU を段階導入する方針が妥当である。

## 推奨優先度

| 優先度 | 機能候補 | 期待効果 | 難易度 | 最初の実装スライス |
|---|---|---:|---:|---|
| P0 | カラーレジェンド、手動レンジ、opacity、カラーマップ選択 | 高 | 低 | 既存 `VtkViewer` と `PropertiesPanel` に表示設定を追加 |
| P0 | cell array 着色 | 中 | 低〜中 | point/cell association をUIで選び、mapperのscalar modeを切替 |
| P0 | ジョブ一覧・キャンセルUI | 中 | 低〜中 | 既存 `GET /jobs` と `POST /jobs/{id}/cancel` をフロントに接続 |
| P0 | ビュー操作改善 | 中 | 低〜中 | ResizeObserver、orientation axes、標準ビュー方向、パネル折りたたみ |
| P1 | Pipeline browser と表示状態保存 | 高 | 中 | 既存 Pipeline API をUIに接続し、reader/representation nodeを保存 |
| P1 | CSV Table-to-Points | 中 | 中 | x/y/z列選択UIと点群artifact生成、またはブラウザ側点群描画 |
| P1 | `.vti` のslice/volume rendering | 高 | 中〜高 | vtk.js の ImageData reader/mapperを追加し、sliceから開始 |
| P1 | `.pvd` 時系列スライダー | 高 | 中〜高 | PVDの参照ファイル管理、現在stepの取得API、再生UI |
| P1 | Artifact生成つきconvert/filter/exportジョブ | 高 | 中〜高 | `POST /jobs` を拡張し、変換済みVTPやスクショをArtifact化 |
| P2 | trame/ParaView サーバレンダリング | 非常に高 | 高 | `POST /sessions` とWebSocketの最小セッションを追加 |
| P2 | Slice/Clip/Contour/Threshold のサーバ実行 | 高 | 高 | filter parameter schemaとworker実行、結果artifact保存 |
| P2 | CGNS/Exodus/EnSight/XDMF 対応 | 高 | 高 | pvpython/ParaView workerでメタデータ抽出と表面抽出から開始 |
| P2 | PostgreSQL + Alembic + S3/MinIO | 高 | 中〜高 | SQLite/FS抽象を残したまま本番バックエンドを追加 |
| P2 | 認証/OIDC、RBAC、監査ログ | 高 | 高 | Project単位の権限境界と監査イベントから開始 |
| P3 | WebGPU/WASM 検証 | 中〜高 | 高 | feature detection + WebGL fallback、特定reader/filterでPoC |
| P3 | Jupyter/Python連携 | 中 | 中〜高 | Pythonからstateを開くリンク/API、PyVista/trame連携PoC |
| P3 | AI操作アシスタント | 中 | 中〜高 | 自然言語をPipeline変更案に変換し、実行前に差分確認 |

## P0: 短期で価値が出る改善

### 1. カラーレジェンド、レンジ、opacity、カラーマップ選択

現状は point array の値域から固定の cool-to-warm LUT を作り、スカラー着色を行っている。凡例、手動レンジ、opacity、カラーマップ選択を追加すると、解析結果確認の基本体験が大きく改善する。

- 根拠: `frontend/src/components/VtkViewer.tsx` の `applyColor`、`frontend/src/components/PropertiesPanel.tsx` のスカラー着色UI
- 効果: 高。ParaView風の可視化確認に必須
- 難易度: 低
- 注意点: 凡例はcanvas overlayかHTML overlayで実装する。将来のサーバレンダリングと設定名を合わせておく

### 2. cell array 着色

現状のUIは `association === "point"` の配列だけを色付け対象にしている。CAE/CFD/FEAではcell dataも一般的なので、point/cellの切替を早めに入れる価値がある。

- 根拠: `frontend/src/components/PropertiesPanel.tsx` の `pointArrays`、`backend/app/metadata.py` の point/cell array抽出
- 効果: 中〜高
- 難易度: 低〜中
- 注意点: point/cellで同名配列がある場合に識別できるUIが必要

### 3. ジョブ一覧・キャンセルUI

バックエンドにはジョブ一覧とキャンセルAPIがあるが、フロントではアップロード/ingest中のキャンセル操作や過去ジョブ確認ができない。長時間処理を増やす前にジョブセンターを作ると、以後の変換・フィルタ・レンダリングジョブにも流用できる。

- 根拠: `backend/app/routers/jobs.py`、`frontend/src/api.ts` の `cancelJob`
- 効果: 中
- 難易度: 低〜中
- 最小案: 左パネル下部に「実行中ジョブ」一覧、キャンセルボタン、最終ログ1行を表示

### 4. ビュー操作改善

実用Viewerとして、リサイズ追従、標準ビュー方向、orientation axes、サイドパネル折りたたみは早期に欲しい。解析担当は同じデータを何度も見比べるため、細かい操作の快適さが効く。

- 根拠: `frontend/src/components/VtkViewer.tsx`、`frontend/src/styles.css`
- 効果: 中
- 難易度: 低〜中
- 最小案: `ResizeObserver` で `grw.resize()`、上/正面/側面/isometric のカメラプリセット

## P1: プロダクトの中核になる機能

### 5. Pipeline browser と表示状態保存

バックエンドには `Pipeline` / `PipelineNode` があり、reader/filter/representation DAGを保存できる。一方でフロントはまだPipeline APIに接続していない。まずは reader + representation の保存から始め、後でfilter nodeを増やすとよい。

- 根拠: `backend/app/models.py`、`backend/app/routers/pipelines.py`
- 効果: 高。ParaViewらしい作業再開・比較・共有の基盤になる
- 難易度: 中
- 最小案: 「現在の表示を保存」「保存済み表示を復元」を実装し、representation、colorBy、range、cameraを保存する

### 6. CSV Table-to-Points

CSVはメタデータ抽出済みだが、現状はテーブルとして扱われるだけで点群表示に進めない。x/y/z列とスカラー列を選ぶUIを追加すると、軽量な点群ビューアとしての用途が増える。

- 根拠: `backend/app/metadata.py` の CSV parser、`frontend/src/components/DatasetPanel.tsx` の `.csv` upload許可
- 効果: 中
- 難易度: 中
- 最小案: ブラウザ側でCSVを点群PolyData相当に変換する。大規模CSVは後でサーバ変換に回す

### 7. `.vti` のslice/volume rendering

`ImageData` はメタデータ抽出済みだが、ビューアはPolyData専用である。vtk.jsはImageData/volume系の表現を持つため、まずはorthogonal slice、次にvolume renderingへ広げるとMVPの表示範囲が大きく広がる。

- 根拠: `backend/app/metadata.py` の `_extract_imagedata`、`frontend/src/components/VtkViewer.tsx` の `BROWSER_RENDERABLE`
- 効果: 高
- 難易度: 中〜高
- 最小案: `.vti` を1軸sliceで表示し、slice indexとcolor rangeだけ操作可能にする

### 8. `.pvd` 時系列スライダー

PVDはtimesteps抽出済みだが、時刻の選択・再生・各stepファイル取得が未実装である。時系列対応はCFD/FEA用途で価値が高い。

- 根拠: `backend/app/metadata.py` の `_extract_pvd`、`frontend/src/components/PropertiesPanel.tsx` の timesteps表示
- 効果: 高
- 難易度: 中〜高
- 注意点: PVDは参照ファイルを伴うため、multi-file upload、object store上の相対パス管理、step単位download APIが必要

### 9. Artifact生成つきconvert/filter/exportジョブ

`Artifact` モデルと取得APIはあるが、生成側はまだ薄い。変換済みVTP、スクリーンショット、`.vtkjs`、動画などをArtifactとして保存できると、ジョブ処理と共有機能の基盤になる。

- 根拠: `backend/app/models.py` の `Artifact`、`backend/app/routers/artifacts.py`
- 効果: 高
- 難易度: 中〜高
- 最小案: サーバ側で「アップロード済みPolyDataのスクリーンショット保存」ではなく、まずは「変換済み/派生ファイルの登録API」から作る

## P2: M2/M3相当の大きな拡張

### 10. trame/ParaView サーバレンダリング

非PolyData、大規模データ、外部形式、重いフィルタを扱うには、trame/ParaView/VTK workerが本命になる。`VtkRemoteView` はサーバレンダリング画像を送る方式、`VtkLocalView` はサーバが定義したシーンのgeometryをクライアントへ送る方式で、用途に応じた切替ができる。

- 根拠: `README.md` と `docs/ADR-0001-stack.md` でM2+に明示、trame-vtk公式ドキュメント
- 効果: 非常に高
- 難易度: 高
- 最小案: `POST /sessions` で1 datasetに対する一時render sessionを作り、WebSocketでカメラと画像更新だけを通す
- リスク: GPU/CPUコスト、WebSocket運用、セッション寿命、同時接続数

### 11. Slice/Clip/Contour/Threshold のサーバ実行

ParaViewらしい解析UIの中核はフィルタである。vtk.jsだけで全VTKフィルタを再現する方針は現実的ではないため、重い処理はサーバ側で実行し、結果をartifactとして返す設計がよい。

- 根拠: `work_plan.md` のM1/M2未実装項目、ParaView filtering documentation
- 効果: 高
- 難易度: 高
- 最小案: Contour 1種類だけを実装し、入力dataset、array、isovalueを指定して結果VTPをArtifact化する

### 12. CGNS/Exodus/EnSight/XDMF 対応

実務CAE/CFD/FEAでは外部形式対応が重要になる。ブラウザ直読ではなく、ParaView/VTK readerでメタデータ抽出、必要に応じて表面抽出や軽量artifact化を行う。

- 根拠: `README.md` でM2+に繰り延べ、`paraview_webapp_research.md` の形式分類
- 効果: 高
- 難易度: 高
- 最小案: 1形式を選び、メタデータ抽出 + 表面抽出VTP生成 + ブラウザ表示までを縦に通す

### 13. PostgreSQL + Alembic + S3/MinIO

現状のSQLiteとローカルFS object storeはMVPとして妥当だが、複数ユーザー、ジョブworker分離、容量管理には本番向けストレージが必要になる。

- 根拠: `docs/ADR-0001-stack.md` のMVP判断、`backend/app/storage.py` の抽象化
- 効果: 高
- 難易度: 中〜高
- 最小案: Alembic導入とPostgreSQL CIを先に行い、次にMinIOを開発環境へ追加

### 14. 認証/OIDC、RBAC、監査ログ

プロジェクト単位で解析データを扱う以上、認証と権限は本番化前に必要になる。特に企業/研究機関では、アップロード、ダウンロード、共有、削除の監査ログが重要になる。

- 根拠: `work_plan.md` のM1繰り延べ項目
- 効果: 高
- 難易度: 高
- 最小案: ユーザーIDをProjectに紐づけ、read/write/adminの3ロールから始める

## P3: R&D候補

### 15. WebGPU/WASM の段階導入

WebGPUやVTK.wasm/ITK-Wasmは有望だが、MVP本線の前提にするにはリスクが高い。導入する場合はfeature detectionとfallbackを前提にし、reader、画像処理、軽量filterなど限定領域から検証する。

- 効果: 中〜高
- 難易度: 高
- 最小案: WebGPU対応ブラウザだけで点群描画PoCを行い、WebGLとの性能差を測る

### 16. Jupyter/Python連携

研究・解析用途では、NotebookやPythonスクリプトからビューを開き、結果確認だけWebアプリで行う流れが強い。PyVista/trameとの連携、またはPipeline stateをPython scriptとして再現する機能が候補になる。

- 効果: 中
- 難易度: 中〜高
- 最小案: dataset/pipeline URLをPythonから発行し、ブラウザで該当ビューを開く

### 17. AI操作アシスタント

自然言語で「この配列でContourを作る」「流線を追加する」「論文用に色を整える」といった操作候補を作る機能は差別化になる。ただし、直接実行ではなくPipeline変更案を提示し、ユーザーが確認して適用する形が安全である。

- 効果: 中
- 難易度: 中〜高
- 最小案: 現在のdataset metadataとPipeline stateから、実行可能なfilter候補を提案するだけに限定

## 直近の推奨ロードマップ

### Sprint 1: 表示体験の底上げ

1. カラーレジェンド、手動レンジ、opacity、カラーマップ選択
2. cell array 着色
3. ResizeObserver、標準ビュー方向、orientation axes
4. ジョブ一覧・キャンセルUI

### Sprint 2: 作業状態を残せるViewerへ

1. Pipeline browserの最小UI
2. representation/color/cameraの保存と復元
3. Artifact登録APIの整理
4. CSV Table-to-Points

### Sprint 3: データ種別を広げる

1. `.vti` slice表示
2. `.pvd` multi-file管理とtime slider
3. Contourサーバジョブの縦通しPoC
4. 変換済みVTP artifactの再表示

### Sprint 4: 本格M2へ

1. trame/ParaView session API
2. WebSocketレンダリング
3. CGNS/Exodus/EnSight/XDMFのうち1形式を縦通し
4. PostgreSQL/Alembic/MinIOの導入

## 採用しない方がよい方向

- 旧 `ParaViewWeb` を新規実装基盤にすること。現在はmaintenance modeで、新機能追加なしの扱いである。
- vtk.jsだけでParaView/VTKの全フィルタを再実装すること。vtk.jsはWeb向けレンダリングの中核だが、VTK/C++全機能の置き換えを目指していない。
- WebGPU/WASMを短期MVPの前提にすること。検証価値は高いが、fallbackと性能計測を伴うR&D枠に置く方が安全である。

## 根拠ファイル

- `README.md`: M1 MVP範囲、M2+繰り延べ範囲、API surface
- `work_plan.md`: M0〜M4ロードマップ、M1実装状況、未実装項目
- `docs/ADR-0001-stack.md`: SQLite、stdlib metadata parser、thread pool、React + vtk.js採用理由
- `backend/app/models.py`: Project/Dataset/Pipeline/PipelineNode/Job/Artifact
- `backend/app/metadata.py`: VTK XML/PVD/CSV metadata parser
- `backend/app/routers/datasets.py`: upload、ingest、metadata、download
- `backend/app/routers/pipelines.py`: Pipeline CRUD
- `backend/app/routers/jobs.py`: job status/cancel
- `frontend/src/App.tsx`: 現在のUI状態管理
- `frontend/src/components/VtkViewer.tsx`: PolyData限定のvtk.js描画
- `frontend/src/components/PropertiesPanel.tsx`: 表示設定とmetadata表示
- `frontend/src/components/DatasetPanel.tsx`: project/dataset/upload UI
- `frontend/src/api.ts`: フロントAPI client

## 外部参考資料

- [VTK.js Overview](https://kitware.github.io/vtk-js/docs/)
- [trame documentation](https://trame.readthedocs.io/en/latest/)
- [trame-vtk GitHub](https://github.com/Kitware/trame-vtk)
- [ParaViewWeb GitHub](https://github.com/Kitware/paraviewweb)
- [ParaView Glance supported file formats](https://kitware.github.io/glance/doc/readers.html)
- [Export ParaView animations to Kitware Glance](https://www.kitware.com/export-paraview-animations-to-paraview-glance-2/)
- [ParaView filtering documentation](https://docs.paraview.org/en/latest/UsersGuide/filteringData.html)
- [ParaView saving results documentation](https://docs.paraview.org/en/v5.12.0/UsersGuide/savingResults.html)
