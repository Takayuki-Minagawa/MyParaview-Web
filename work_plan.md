# ParaView類似Webアプリ 開発作業計画

作成日: 2026-07-09 (JST)
基となる調査: [`paraview_webapp_research.md`](./paraview_webapp_research.md)
対象: CAE/CFD/FEA/科学データを表示・分析するParaView類似Webアプリ

---

## 0. この計画の考え方

調査メモの結論を作業に翻訳する。方針は次の3点に集約する。

1. **ハイブリッド前提** — 小規模データはブラウザ(`vtk.js`)、重いデータ・重いフィルタはサーバ(ParaView/VTK/PyVista)。
2. **2段階アプローチ** — まず`trame`でPoCを最短で立て、学びを得てから製品アーキテクチャ(`React + vtk.js` / `FastAPI` / worker分離)へ移行する。
3. **先端技術(VTK.wasm/WebGPU)はMVPの主軸にしない** — Phase 4で検証枠として扱う。

作業計画は「マイルストーン → 作業項目(タスク) → 成果物 → 完了条件(DoD)」の粒度で記述する。番号はロードマップのPhaseに対応する。

---

## 1. 技術スタックの確定（着手前の意思決定）

| レイヤ | 第一候補 | 代替 | 決定タイミング |
|---|---|---|---|
| フロントエンド描画 | `vtk.js` (WebGL2) | `three.js` / `deck.gl`(補助) | M0で確定 |
| フロントUIフレームワーク | React + TypeScript | Vue | M1着手前 |
| PoC UI | `trame` + `trame-vtk` (Vuetify) | — | M0で使用 |
| API | FastAPI (Python) | — | M1で確定 |
| リアルタイム通信 | WebSocket (`wslink`/trame) | 独自WS | M1で確定 |
| ジョブ処理worker | `pvpython` / VTK / PyVista / meshio | — | M1で確定 |
| メタデータDB | PostgreSQL | — | M1で確定 |
| オブジェクトストレージ | S3互換 (MinIO開発 / S3本番) | — | M1で確定 |
| ジョブキュー | Celery / RQ / Dramatiq | — | M1で確定 |
| 認証 | OIDC (Keycloak等) | SAML | M1で確定 |

> ライセンスは調査メモでBSD-3/Apache-2.0/MIT系に統一済み。`xeokit`(AGPL)は採用しない。採用直前にStar/最終push/ライセンスを再確認する運用を守る。

**作業項目**
- [ ] 上表の未確定項目(UIフレームワーク、キュー、認証基盤)を確定しADR(Architecture Decision Record)に記録する
- [ ] リポジトリ初期化（monorepo構成: `frontend/` `backend/` `workers/` `infra/` `docs/`）
- [ ] `git init` と CI雛形（lint / typecheck / test）を用意する

---

## 2. マイルストーン M0 — 技術検証 PoC（Phase 0）

**目的**: 「ブラウザ直読」と「サーバ処理」の両輪が実データで成立するかを数値で確認する。製品コードは書かない。

### M0-A: 代表データセットの準備
- [ ] 小規模: `.vtp` / `.vti`（表面・ImageData）
- [ ] 中規模: `.vtu` / `.pvd`（非構造格子・時系列）
- [ ] 大規模: `.xdmf + .h5` または `.cgns` / `.exo` / EnSight `.case`
- **成果物**: サンプルデータ一式 + それぞれのbounds/点数/セル数/timesteps一覧

### M0-B: サーバ処理PoC（trame + ParaView/VTK）
- [ ] `trame + trame-vtk`で`VTU`/`PVD`/`XDMF+HDF5`/`CSV`を読み込む
- [ ] 表示・clip・slice・contour・time sliderを実装
- [ ] `VtkRemoteView`(サーバ描画) / `VtkLocalView`(geometry転送) を切り替えて比較
- **成果物**: trame製PoCアプリ + 操作動画/スクリーンショット

### M0-C: ブラウザ直読PoC（vtk.js単体）
- [ ] `vtk.js`で`VTP`/`VTI`を読み、scalar coloring・colormap・clip/slice相当UIを試す
- [ ] `vtkVolumeMapper`で`VTI`のボリュームレンダリングを試す
- **成果物**: vtk.js最小デモ

### M0-D: 変換・メタデータ抽出PoC（pvpython）
- [ ] `pvpython`でメタデータ抽出（dataset type / bounds / points/cells / blocks / timesteps / arrays / range / components）
- [ ] `VTU`等から表面抽出して`VTP/VTI`へ変換するスクリプト
- **成果物**: 抽出スクリプト + 出力JSONサンプル（後のDB schema原型）

### M0-E: 計測とレポート
- [ ] 各データセットで「メモリ / 読み込み時間 / 描画FPS / 変換時間 / 転送量」を測定
- [ ] 1ユーザーあたりのサーバGPU/メモリ使用量を測り同時接続上限を試算
- **DoD**: 測定結果を`docs/m0-benchmark.md`にまとめ、MVPで「どのサイズまでブラウザ直読にするか」の閾値を数値で決定する

---

## 3. マイルストーン M1 — MVP（Phase 1）

**目的**: 認証付きで、アップロード→メタデータ抽出→表示→基本フィルタ→スクショまでの一連が動く最小製品。

> **実装状況 (2026-07-10)**: M1コアに加え、追加機能候補17件の最小スライスを実装済み。
> browser-directはVTP/CSV/VTI/PVD、production adapterはPostgreSQL/S3/OIDC/RBAC、
> server capabilityはpvpython filter/external readerとtrame broker/WS proxyを実装した。
> WebGPU/WASMは検出+WebGL fallback、ParaView/trameは外部runtimeを必要とする。
> 詳細は[機能対応表](./docs/implementation-status.md)と
> [全機能検証](./docs/verify-all-features.md)を参照。

### M1-A: 基盤・バックエンド
- [ ] FastAPIプロジェクト、PostgreSQLスキーマ、S3互換ストレージ、ジョブキューを結線
- [ ] 認証（OIDC）、プロジェクト単位RBAC、監査ログ、署名付きアップロードURL
- [ ] データモデル実装: `Project` / `Dataset` / `ArrayInfo` / `TimeStep` / `Pipeline` / `PipelineNode` / `Representation` / `Job` / `Artifact` / `Session`

### M1-B: データ取り込み
- [ ] `POST /datasets`（アップロード登録・署名付きURL発行）
- [ ] `POST /datasets/{id}/ingest`（メタデータ抽出ジョブ）→ M0-Dスクリプトをworker化
- [ ] `GET /datasets/{id}/metadata`
- [ ] セキュリティ: magic/header検査、ファイルサイズ/配列数/セル数のquota、zip爆弾対策

### M1-C: パイプライン & ジョブ
- [ ] `POST /pipelines` / `PATCH /pipelines/{id}`（`reader → filter → representation`のDAGを保存）
- [ ] `POST /jobs` / `GET /jobs/{id}`（変換・フィルタ・レンダリング、進捗/ログ/結果、**キャンセル可能**に）
- [ ] ジョブworkerとinteractive render sessionのプロセス分離

### M1-D: レンダリングセッション
- [ ] `POST /sessions` / `WS /sessions/{id}`（trame/ParaView render session、カメラ・選択・更新）
- [ ] `GET /artifacts/{id}`（変換`VTP/VTI`・画像配信）
- [ ] インフラ: NGINX/IngressのWebSocket upgrade・長timeout・sticky session設定

### M1-E: フロントエンド（React + vtk.js）
- [ ] レイアウト: データパネル / パイプラインツリー / 3Dビュー / プロパティパネル
- [ ] 表示: surface / wireframe / points、scalar coloring、colormap・range・opacity、color legend
- [ ] block表示切替、time slider、カメラ保存/復元、スクリーンショット
- [ ] 基本フィルタUI: **Slice / Clip / Contour(Isosurface) / Threshold**
- [ ] 小規模`VTP/VTI`はvtk.jsローカル描画、閾値超えはサーバレンダリングpreviewに自動フォールバック（M0-Eの閾値を使用）

**M1 DoD**
- [ ] 代表データ3種のうち小・中規模で end-to-end（アップロード→表示→フィルタ→スクショ）が動く
- [ ] 進捗の見える化とジョブキャンセルが機能する
- [ ] `docs/verify-m1.md`に手順と結果を記録（`/verify`相当の実操作確認）

---

## 4. マイルストーン M2 — 形式と解析の拡張（Phase 2）

- [ ] `CGNS` / `Exodus` / `EnSight` の正式対応（サーバreader、補助に`seacas`/`ensight-reader`/`meshio`）
- [ ] block/set選択UI
- [ ] フィルタ追加: Cell Data to Point Data / Resample / Decimation
- [ ] volume rendering（`vtkVolumeMapper`をUI統合）
- [x] vector glyph sampling
- [ ] pipeline state の保存 / 共有（`glance`のscene export形式を参考に）
- **DoD**: 大規模データ（M0-Aの1種）が読み込み・block選択・フィルタまで到達する

---

## 5. マイルストーン M3 — 大規模・時系列対応（Phase 3）

- [ ] LOD / 間引き / 事前変換、progressive rendering（操作中は低解像度、停止時に高品質）
- [ ] block単位キャッシュ、時系列の部分ロード
- [ ] animation / video export
- [ ] Kubernetes / HPC job連携、GPU render pool（EGL、CPU fallbackはOSMesa）
- **DoD**: 大規模時系列データで実用的なインタラクション応答を維持できる

---

## 6. マイルストーン M4 — 先端技術検証（Phase 4・並行R&D）

MVP〜M3の本線とは別トラックで、リスクを取らずに検証する。

- [ ] `VTK.wasm`で特定reader/filterのブラウザ移植を評価（bundleサイズ・起動時間・メモリ・JS/WASM境界コストを計測）
- [ ] `trame-vtklocal`（VTK 9.4+）の成熟度を追跡
- [ ] `ITK-Wasm`で画像系前処理
- [ ] `WebGPU` / `luma.gl` で点群・volume・独自shader
- [ ] `deck.gl` / `loaders.gl` で地理空間・3D Tiles・Arrow/Parquet連携
- **DoD**: 各技術の「本線採用可否」を判断メモ化（現時点は実験段階という前提を維持）

---

## 7. 横断的な作業（全マイルストーン共通）

### 性能・UX
- [ ] 大容量配列はJSON埋め込み禁止、binary artifactとして配信
- [ ] 多ビュー時のWebGL context数を管理（共有render window / canvas管理）
- [ ] progressive UX（操作中LOD低下→停止時高品質）を横断ポリシー化

### セキュリティ・運用
- [ ] worker はコンテナ分離、CPU/GPU/メモリ/時間制限
- [ ] 任意Python実行は不許可（programmable filter開放時は隔離環境必須）
- [ ] 監視・ログ・コスト計測（同時セッション数とGPU/メモリの相関を継続測定）

### ドキュメント
- [ ] ネイティブVTK形式（VTP/VTI/VTU/PVD/VTKHDF）と外部reader形式（CGNS/Exodus/EnSight/Xdmf）を**区別して**記述
- [ ] ADR、API仕様、DBスキーマ、運用Runbookを継続整備

---

## 8. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| 非構造格子でブラウザメモリ超過 | 描画不能/クラッシュ | サーバ処理へ振り分け、表面抽出`VTP`化、quota |
| trame/ParaViewセッションのGPU/メモリコスト | 同時接続数の制約 | M0-Eで上限を実測、render pool・セッション分離 |
| WebSocket運用の不安定さ | 描画途切れ | NGINX設定(upgrade/timeout/sticky)、再接続設計 |
| 長時間ジョブ（等値面・流線・時系列変換） | UX悪化・リソース占有 | 全ジョブをキャンセル可能に、進捗表示 |
| VTK.wasm/WebGPUの未成熟 | 手戻り | 本線に載せず M4 の検証枠に隔離 |
| OSSのメンテ停止（paraviewweb等） | 保守不能 | 新規基盤に非採用、採用直前に再確認 |

---

## 9. 最短の次アクション（今すぐ着手）

1. **M0-A**: 代表データ3種を集める（小`VTP/VTI` / 中`VTU/PVD` / 大`XDMF+HDF5`か`CGNS/Exodus/EnSight`）。
2. **M0-B/C**: `trame + ParaView`のPoCと`vtk.js`単体デモを並行で立てる。
3. **M0-D**: `pvpython`メタデータ抽出スクリプトを書き、DB用JSON schemaを固める。
4. **M0-E**: メモリ/FPS/転送量/変換時間を計測し、ブラウザ直読の閾値を数値決定する。
5. これらの結果を持って **M1のアーキテクチャ確定** に進む。
