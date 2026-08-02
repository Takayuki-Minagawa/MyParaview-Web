# 追加機能 作業計画（2026-08-02）

対象: MyParaView-Web 全体（backend / frontend / workers / infra / CI）
前提: [refactoring-and-feature-plan.md](refactoring-and-feature-plan.md) の R1〜R4 フェーズ
（リファクタリング一式 + F1 VTU直読 + F2 統計ヒストグラムUI + Playwright E2E）は
完了済み（[refactoring-progress.md](refactoring-progress.md) 参照、PR #4 マージ済み）。

本計画は未着手の次期候補 F3〜F10、[work_plan.md](../work_plan.md) M2/M3 の未消化項目、
および新規提案を統合し、優先度付きの実施計画に翻訳したものである。

> **実施状況（2026-08-02）**: G1〜G13は実装済み。G14もbackend/frontend coverageと
> Dependabot設定までは完了した。LICENSEは利用者によるライセンス選択待ちであり、
> 許諾条件をこちらで決めず保留する。詳細は[§6 実施結果](#6-実施結果2026-08-02)を参照。

**選定基準**: 「解析ユーザー価値 ÷ 実装コスト」を第一軸とし、既存基盤
（ViewState / ジョブ基盤 / stats / 分割済み scene builder / DisplayStateContext）の
再利用度が高いものを優先する。

---

## 1. 計画開始時と実装後のサマリ

### 計画開始時

- **当時実装済み**: VTP/VTU/VTI/CSV/PVD のブラウザ直読、サーバフィルタ4種
  （Slice/Clip/Contour/Threshold）、統計ヒストグラム、時系列 playback、
  Pipeline browser、Job center（SSE）、RBAC/監査/OIDC、S3/PostgreSQL 対応
- **当時未着手**: F3〜F10（[refactoring-and-feature-plan.md §5](refactoring-and-feature-plan.md)）、
  M2 の block/set 選択・追加フィルタ・vector glyph、M3 の LOD・動画 export、
  RI-3 コンテナ化
- **当時のリポジトリ衛生の欠落**: LICENSE ファイルなし、カバレッジ測定なし、
  依存脆弱性スキャン（Dependabot 等）なし

### 実装後

- **ブラウザ操作**: VTS/VTR直読、対話clip/slice、Probe、距離/角度計測、vector glyph、
  2画面比較、ParaView colormap preset、表示状態undo/redoを追加
- **データ・サーバ解析**: datasetタグ/検索とAlembic 0009を追加し、サーバfilterを
  Cell Data to Point Data / Resample To Image / Decimationを含む7種へ拡張
- **運用**: backend/frontend containerとfull-stack Compose、Redis/RQ worker、
  PNG frame ZIPに加えてMP4/WebM exportを追加
- **リポジトリ衛生**: pytest-cov / Vitest coverageとDependabot設定を追加。
  LICENSEだけは利用者の選択待ち

避けるべき方向（[additional_feature_candidates.md](../additional_feature_candidates.md) の結論を維持）:
旧 ParaViewWeb 基盤の採用、vtk.js での全 VTK フィルタ再実装、WebGPU/WASM の本線化。

---

## 2. 追加機能候補一覧

番号は G1〜G14 で採番し、出典（F 番号 / M 番号）を併記する。

### Tier 1 — 対話性向上【最優先】

| ID | 機能 | 出典 | 価値 | 難易度 | 最初のスライス |
|---:|---|---|---|---|---|
| G1 | **クライアントサイド clip/slice 平面ウィジェット** | F3 | 高 | 中 | vtk.js `vtkImplicitPlaneWidget` + `vtkClipClosedSurface` で PolyData を対話的に clip。サーバ往復なしの即時操作感。`lib/viewer/scenes.ts` の `buildPolyDataScene` に clipPlane を注入する形で実装 |
| G2 | **Probe/ピッキング** | F4 | 中〜高 | 中 | クリック点の point/cell scalar 値をツールチップ表示。vtk.js hardware selector。VtkViewer に picking モードトグルを追加 |
| G3 | **計測ツール（距離/角度）** | F8 | 中 | 中 | vtk.js distance widget で2点間距離。CAE 実務の定番要望。G2 のピッキング基盤を再利用 |

### Tier 2 — データ管理・比較

| ID | 機能 | 出典 | 価値 | 難易度 | 最初のスライス |
|---:|---|---|---|---|---|
| G4 | **データセットのタグ/検索** | F7 | 中 | 低〜中 | `Dataset.tags`（JSON列、Alembic 0009）+ 一覧のタグフィルタ/名前検索。プロジェクトが育つと必須になる |
| G5 | **比較ビュー（2-up viewport）** | F5 | 中〜高 | 中〜高 | 2 dataset または 2 timestep を並べてカメラ同期。ViewState 基盤を再利用。WebGL context 数の管理に注意（work_plan §7） |
| G6 | **カスタム colormap import** | F9 | 低〜中 | 低 | ParaView `.json` colormap preset の読込。前提だった RF-6（定数の単一情報源化）は完了済みで着手可能 |
| G7 | **表示状態の undo/redo** | F10 | 低〜中 | 中 | ViewState 履歴スタック。前提だった RF-2（DisplayStateContext 化）は完了済みで着手可能 |

### Tier 3 — 形式・フィルタ拡張

| ID | 機能 | 出典 | 価値 | 難易度 | 最初のスライス |
|---:|---|---|---|---|---|
| G8 | **VTS/VTR のブラウザ直読** | 新規 | 中 | 中 | F1 の VTU 自前パーサ設計を流用し、StructuredGrid/RectilinearGridの外表面抽出とbrowser-direct表示を実装 |
| G9 | **vector glyph 表示** | M2 | 中 | 中 | ベクトル配列の矢印表示（`vtkGlyph3DMapper`）+ 点数上限付きサンプリング |
| G10 | **サーバフィルタ追加** | M2 | 中 | 低〜中 | 従来4種へCell Data to Point Data / Resample / Decimationを追加し、API・UI・pvpython workerの全経路を7種に拡張 |

### Tier 4 — 運用・基盤【要件発生時に着手】

| ID | 機能 | 出典 | 価値 | 難易度 | 最初のスライス |
|---:|---|---|---|---|---|
| G11 | **アプリ本体のコンテナ化** | RI-3 | 中（運用） | 中 | backend / frontend（nginx静的配信）のDockerfileと、migration/API/RQ workerを含むfull-stack Compose profileを実装 |
| G12 | **ジョブキューの外部化** | F6 | 中（運用） | 中〜高 | in-process local executorを開発用に維持し、Redis/RQの独立worker、再起動復旧、retry/cancel契約を追加 |
| G13 | **animation/video export** | M3 | 中 | 中 | 後方互換のframe PNG ZIPを維持し、pv_worker + ffmpegでMP4/WebM生成を追加 |
| G14 | **リポジトリ衛生** | 新規 | 中（保守） | 低 | pytest-cov / Vitest coverageとDependabotは完了。LICENSEは利用者のライセンス選択待ち |

---

## 3. 推奨実施順序

依存関係と「1タスク = 1コミット、ID をコミットメッセージ先頭に」の流儀を維持する。

### Phase G-A: 対話ツール（最優先）
1. G1 clip/slice 平面ウィジェット
2. G2 Probe/ピッキング

計画書 R4 の推奨（「次は F3/F4」）をそのまま引き継ぐ。いずれも分割済みの
`lib/viewer/` scene builder + 型付き interface（RF-4/RF-5 完了）の上に載せる。

### Phase G-B: 小粒の独立機能（並行可能）
1. G6 カスタム colormap import（前提クリア済み・難易度低）
2. G4 タグ/検索（Alembic 0009 + 一覧フィルタ）
3. G14 リポジトリ衛生（カバレッジ / Dependabot完了、LICENSE選択待ち）

### Phase G-C: 比較・計測
1. G3 計測ツール（G2 のピッキング基盤を再利用するため G-A 後）
2. G5 比較ビュー
3. G7 undo/redo

### Phase G-D: 形式・フィルタ拡張
1. G8 VTS/VTR 直読
2. G10 サーバフィルタ追加
3. G9 vector glyph

### Phase G-E: 運用・基盤（デプロイ/スケール要件が確定した時点）
1. G11 コンテナ化
2. G12 ジョブキュー外部化
3. G13 動画 export

---

## 4. 完了条件（DoD）

### フェーズ共通
- CI 5ジョブ（lint / backend / frontend / e2e / postgres-migration）が全て通る
- 新規ロジックには単体テストを同時追加（「テストで固定してから動かす」原則を維持）
- 外部 capability（pvpython 等）未設定時に偽の成功を作らない方針を全機能で維持
- ja/en の i18n カタログへキーを両方追加し、型で完全一致を維持

### フェーズ別
| Phase | DoD |
|---|---|
| G-A | clip 平面のドラッグ操作と probe 値表示が VTP/VTU で動作。Playwright E2E に対話ツールのシナリオを1本追加 |
| G-B | colormap JSON import が凡例に反映。タグの付与・検索が RBAC 下で動作し監査ログに記録。LICENSE が存在し CI にカバレッジレポートが出る |
| G-C | 2-up ビューのカメラ同期が動作し WebGL context リークがない。undo/redo が ViewState 保存/復元と整合 |
| G-D | VTS/VTR がサーバ変換なしで表示。新フィルタ3種が pvpython 有効環境の手動検証（[verify-all-features.md](verify-all-features.md) に追記）で通る |
| G-E | full-stack compose で `docker compose up` から E2E 相当の手動確認が通る。ジョブがプロセス再起動を跨いで生存 |

---

## 5. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| vtk.js widget API の癖（G1/G2/G3） | 実装コスト増 | 最初のスライスを PolyData 限定で切り、ImageData/volume への拡張は後続タスクに分離 |
| 2-up ビューの WebGL context 上限（G5） | 描画不能 | 共有 render window 方式を先に検証（work_plan §7 の横断ポリシー） |
| VTS/VTR パーサの形式網羅（G8） | 手戻り | F1 と同様に対応範囲を明記（ascii/inline base64/raw appended、little-endian のみ等）し、範囲外は既存のサーバ変換へフォールバック |
| ジョブキュー移行の互換性（G12） | ジョブ喪失 | 既存 `jobs.py` の協調キャンセル・再起動復旧のテストを移行前に拡充し、契約をテストで固定してから差し替える |

---

## 6. 実施結果（2026-08-02）

| ID | 状態 | 実装結果 |
|---:|---|---|
| G1 | 完了 | `vtkImplicitPlaneWidget`と共有平面を使い、PolyDataのclient clip/sliceをサーバ往復なしで操作可能にした |
| G2 | 完了 | hardware selectorとray picker fallbackでpoint/cell ID・座標・scalar値を表示するProbe tooltipを追加した |
| G3 | 完了 | 2点の距離と3点の角度を測るwidget、reset、数値readoutを追加した |
| G4 | 完了 | `Dataset.tags`、Alembic 0009、名前/タグ検索、RBAC付きタグ更新、監査記録を追加した。SQLite/PostgreSQL双方の検索経路を実装した |
| G5 | 完了 | datasetまたはtimestepを並べる2-up viewとcamera同期を追加し、global WebGL context leaseを2個に制限した |
| G6 | 完了 | ParaView JSONの`RGBPoints` / `IndexedColors` presetをブラウザ内へimportし、凡例・surface・volumeに適用可能にした |
| G7 | 完了 | ViewStateと同じ表示項目を対象とする最大50 snapshotのundo/redoを追加し、dataset/project境界で履歴をresetするようにした |
| G8 | 完了 | StructuredGrid（VTS）/ RectilinearGrid（VTR）の外表面をブラウザで抽出し、VTUと同じ対応encoding範囲で直接描画可能にした |
| G9 | 完了 | `vtkGlyph3DMapper`によるpoint vector表示を追加し、決定的samplingで矢印を最大2,000本に制限した |
| G10 | 完了 | Cell Data to Point Data / Resample To Image / DecimationをAPI・UI・pvpython workerへ追加した。Resampleは1軸上限に加え総sample数も16,777,216以下へ制限した |
| G11 | 完了 | backend/frontend Dockerfile、nginx API proxy、migration/API/RQ worker/Redisを含む`full-stack` Compose profileを追加した |
| G12 | 完了 | local executorを維持しつつRedis/RQを追加した。永続job IDだけをenqueueし、再起動復旧、outbox再照合、retry、DB協調cancel、Redis障害時にjobをfailedへ戻す処理を実装した |
| G13 | 完了 | 後方互換のPNG frame ZIPに加え、ffmpegによるMP4（H.264）とWebM（VP9）export、capability検出、入力上限を追加した |
| G14 | 一部保留 | backend/frontend coverageとDependabot（pip/npm/GitHub Actions/Docker Compose）は完了。LICENSEは利用者のライセンス選択待ち |

### 検証記録

- Playwright全4 scenario（browser smoke、2-up比較、対話ツールVTP、対話ツールVTU）が
  4/4 PASS。clip平面drag前後のcanvas変化、Probeのcell scalar値、正の距離readout、
  2 canvas生成、secondary解放後のcontext slot再利用を確認した。
- PostgreSQL 16上でfresh migrationをheadまで適用し、0009→0008 downgrade、legacy dataset挿入、
  0008→0009 upgrade、tags backfillと大文字小文字を区別しないJSON tag検索を確認した。
- full-stack container imageのbuild、Compose起動、health endpoint smokeとcleanupを確認した。
- 実ffmpegで3 frame（322×242）のH.264 MP4とVP9 WebMをそれぞれ生成し、codec・frame数・
  解像度を確認した。
- backend/frontendの単体・契約テストは、新規ロジックと失敗境界（外部capability未設定、
  numeric上限、RQ enqueue/restart/cancel）を含めて実行した。

このローカル環境には`pvpython`がないため、G10の実ParaView filterと、G13のParaView frame renderを
含むend-to-end manual testは未実施である。ffmpeg単体の実encode、fake `paraview.simple`を使う
worker testとAPI契約テストは通しているが、外部runtime環境での最終確認は
[全機能検証](verify-all-features.md)の手順を使用する。
また、PR作成後のCI結果はこの記録とは分けて確認する。
