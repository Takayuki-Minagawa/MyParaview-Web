# リファクタリング・追加機能 作業計画（2026-07-16）

対象: MyParaView-Web 全体（backend / frontend / workers / infra / CI）
前提: [implementation-status.md](implementation-status.md) の追加機能17件と2ラウンドのレビュー是正は完了済み。
本計画はその後の全コードレビュー（2026-07-16実施）に基づく次期作業計画である。

**総評**: コード品質は高い（トランザクション順序、SSRF対策、lease/eviction、stale-response
ガードなどが丁寧に実装済み）。正確性のバグはほぼなく、指摘の中心は「重複の集約」
「巨大ファイルの分割」「型・テストの補強」である。

---

## 1. リファクタリング — バックエンド

### RB-1. ジョブ本体の共通骨格を抽出【優先度: 高 / 規模: 中】

`backend/app/services.py` の4関数がほぼ同一の骨格を繰り返している。

- `run_stats_operation` (358–400)
- `run_movie_export` (403–461)
- `run_pipeline_execution` (505–563)
- `run_dataset_operation` (566–615)

共通部分: `progress更新 → _load_dataset_source → cancel確認 → key採番 → acquire_path →
生成 → persist_job_artifact → 結果dict / except: rollback_job_artifact / finally: release_path`。

**作業**: `_run_artifact_job(dataset_id, *, kind, ext, content_type, produce, ...)` を抽出し、
各操作を小さな `produce` クロージャに縮退させる。約120行削減、rollback/lease契約の
一元化（現在はコピペで、関数ごとに微妙に壊れやすい）。

- DoD: 4関数が共通ヘルパー経由になり、既存のジョブ系テスト（stats/movie/pipeline/convert）が全て通る。

### RB-2. アップロード3エンドポイントの共通化【優先度: 高 / 規模: 中】

`backend/app/routers/datasets.py` の `upload_dataset` (206–249) /
`upload_dataset_bundle` (252–327) / `upload_external_dataset_bundle` (330–404) は
約90%同一（404→RBAC→normalize→persist→cleanup→Dataset/DatasetFile作成→audit付与）。

**作業**:
- `_create_bundle_dataset(...)` に集約し、descriptor検証（`_pvd_references` vs
  `_validate_external_descriptor`）と許可拡張子だけをコールバック/引数で差し替える。
- `request.state.audit_*` の3点セット（ルーター全体で約15回出現）を
  `_tag_audit(request, type, id, project_id)` ヘルパーに置換。
- DoD: 3エンドポイントの挙動不変（既存upload/ingest/guardテストが通る）。

### RB-3. 「リソース取得→所属project解決→認可」パターンの集約【優先度: 高 / 規模: 中】

`db.get(X) → None なら404 → require_project_role(...)` のイディオムが全ルーターで
約20回出現（datasets.py:433–501, jobs.py:189–215, artifacts.py:84–97, sessions.py:171–207,
pipelines.py:113–136, assist.py:180–214 ほか）。「jobにproject_idがない→403」ガードも
3ヶ所に逐語コピー。

**作業**: `access.py`（新設）に `authorized_dataset(db, id, principal, role)` /
`authorized_job(...)` / `authorized_pipeline(...)` 等を実装し、404/403の文言を統一。

- DoD: 各ルーターの認可ブロックが1行に縮退。エラーメッセージが全ルーターで一貫。

### RB-4. `run_ingest` の分割【優先度: 中 / 規模: 中】

`services.py:57–170` の内部関数 `body` が約115行・深いネスト
（bundle/single → .pvd/external/native 分岐）。

**作業**:
- `_ingest_bundle` / `_ingest_single` / `_enrich_pvd_first_sibling` に分割。
- 88–98の手書きコピーは既存の `materialize_bundle` を再利用。
- `services.py:135` の `pvd_enrich_siblings=source_ext != ".pvd"` は実質no-opフラグ。
  意図をコメント付きで単純化する。

### RB-5. presigned/leased download 尾部の共通化【優先度: 中 / 規模: 小】

`datasets.py:587–601` と `artifacts.py:253–268` が逐語一致
（presigned→307 redirect / acquire_path→410→LeasedFileResponse）。
timestep download (`datasets.py:531–542`) も後半を繰り返す。

**作業**: `responses.serve_object(store, key, *, filename, media_type)` を追加し、3ヶ所を1行に。

### RB-6. remote session削除ヘルパーの整理【優先度: 中 / 規模: 小】

`sessions.py:32–52` に重複ヘルパー3つ（`_delete_remote_id` / `_delete_remote_session` /
`_best_effort_delete_remote`）があり、broker失敗時の扱いが呼び出し側で3通りに分裂
（黙殺 / 502 / log継続）。`projects.py:18` はプライベートシンボルを跨モジュールimport。

**作業**: broker通信を `broker.py`（新設）へ移し、`delete_remote`（raise）と
`try_delete_remote`（best-effort）の2本に統一。expiry駆動cleanupのポリシーを1つに決める。

### RB-7. sniff検証の共有モジュール化【優先度: 中 / 規模: 小】

`artifacts.py:23` が `from .datasets import _sniff_ok`（兄弟ルーターのprivate import）。
`datasets.py:356–359` は既存 `_sniff_upload` を使わずインライン再実装。

**作業**: `_sniff_ok` / `_valid_png` / `_sniff_upload` を `validation.py`（新設）へ移動し公開APIに。

### RB-8. その他の一貫性・小型修正【優先度: 低 / 規模: 小】

- `projects.py:285–312` `list_audit_events`: `response_model=list[AuditEventOut]` 宣言なのに
  CSV分岐で `PlainTextResponse` を返す。`/audit` と `/audit.csv` に分割するか
  `response_model=None` + ドキュメント化。
- DELETE系のレスポンス規約統一（204 no-body vs 200+削除済みbody が混在。
  `delete_member` だけ200+bodyを返す）。
- 「最後のadmin」ガードの重複（`projects.py:192–200` と `250–258`）→
  `_assert_not_last_admin(db, project_id)` に抽出。
- 監査のresource→project解決が `main.py:56–84` とルーター側（例: `artifacts.py:236–252`）で
  二重実装 → `owning_project_id(db, resource_type, resource_id)` に一元化。
- 型注釈: `services.py:183/256` の `bundle_files: list` →
  `list[tuple[str, str, bool]]`。`routers/jobs.py:36–54` のcursor型を
  `datetime | None` にして `# type: ignore` を除去。
- `services.py:242–246` `_plan_output` のネスト三項演算子 → dict/if-ladderへ。
- `worker.py:107–144` のparamsファイル書き込み3回繰り返し → `_write_params` ヘルパー。
- `config.py`: 手書きenv解析を`pydantic-settings`化、`max_artifact_bytes <= max_upload_bytes`
  等の不変条件をconfig側で検証（現在は`artifacts.py`が`min(...)`で呼び出し側補正）。
  import時シングルトン（db/storage/config）のfactory化は影響が広いため任意。

---

## 2. リファクタリング — フロントエンド

### RF-1. App.tsx（1,095行）の機能フック分割【優先度: 高 / 規模: 大】

`AppBody`（74–1095行）が useState×20、useCallback×25、effect×9 を持つ god component。
4フック（`useDisplayState` 等）は抽出済みだが、依然として中心ハブ。

**作業**: 以下の5フックへ分割し、`AppBody` を合成+JSXへ縮退させる。

| 新フック | 移動対象（App.tsx内） |
|---|---|
| `usePipelineActions` | `savePipeline`(384) `restorePipeline`(415) `deletePipeline`(454) `renamePipeline`(468) `runPipeline`(539) |
| `useDatasetJobs` | `trackJob`(485) `runDatasetJob`(499) `exportDataset`/`convertDataset`/`runStats`/`runServerFilter`(519–537) `promoteArtifact`(559) |
| `useRemoteSession` | `stopRemoteSession`(209) `startRemote`(626) `stopRemote`(642) |
| `useDeepLink` | `deepLink`(169) 復元effect(704–721) `copyShareLink`(691) |
| `useDatasetUpload` | `upload`(320–377) |

- DoD: App.tsxが概ね500行以下、各フックに単体テスト（→ §4）、既存84テスト全通過。

### RF-2. PropertiesPanel の57 propsドリリング解消【優先度: 高 / 規模: 中】

`PropertiesPanel.tsx`（Props定義 24–81行）は57 propsを受け取り9子セクションへ
ほぼ素通し。App側（1034–1091行）は安定メモ化済みの `display` オブジェクトを
わざわざ約35個の個別propsに展開している。

**作業**: `DisplayStateContext` を導入（または `display` を単一propで渡す）し、
各子セクションが必要なスライスを直接consumeする。App.tsx 1034–1091の機械的
配線と `PropertiesPanel` のProps再型付けを削除。完了後 `PropertiesPanel` を `memo` 化。

### RF-3. blob download の重複排除【優先度: 高 / 規模: 小】

同一パターンが5ヶ所: `App.tsx:43–50`（正とすべき実装）、`DatasetPanel.tsx:72–82`、
`ArtifactsSection.tsx:80–90`、`VtkViewer.tsx:688–695, 713–718`。

**作業**: `lib/download.ts` に `triggerBlobDownload(blob, filename)` を置き全箇所で再利用。
併せて `timestep-${index}` のダウンロードに拡張子が付かない問題も修正。

### RF-4. VtkViewer.tsx（769行）のシーンビルダー分割【優先度: 中 / 規模: 大】

scene構築effect（419–628行）が PolyData(514–527) / Table・CSV(528–562) /
ImageData slice・volume(563–589) の3パイプラインに分岐する巨大effect。

**作業**: `lib/viewer/` に `buildPolyDataScene` / `buildTableScene` / `buildImageScene` を
抽出し、effectはオーケストレーション+ライフサイクルのみに。mock render windowで
単体テスト可能になる。

### RF-5. Scene の `any` 型排除【優先度: 中 / 規模: 中】

`VtkViewer.tsx:46–52` の `VtkHandle` が `[member: string]: any`（コードベース唯一のany）。
`vtk-shim.d.ts` が全vtk型を消しているため、約350行のeffect内の全vtk呼び出しが未検査。

**作業**: 実際に使うメソッドだけの構造的interface（`Mapper` / `Actor` / `Renderer` /
`RenderWindow`）を定義し `Scene` のフィールドに適用。RF-4とセットで実施すると効率的。

### RF-6. 定数・型の単一情報源化【優先度: 中 / 規模: 小】

- **JobKind union の重複**: `api.ts:129` と `App.tsx:500` に同一union →
  `types.ts` に `export type JobKind` を定義し `Job.kind: string` も `JobKind` に。
- **colormap一覧が4ヶ所**: `types.ts:60` / `colormap.ts:10` / `viewState.ts:14–20` /
  `AssistantSection.tsx:7–13` → `colormap.ts` の `COLOR_MAP_NAMES` を正とし
  `typeof` でunion導出。representation一覧（3ヶ所）も同様。
- **依存方向の逆転**: `useDisplayState.ts:12` がコンポーネント（`VtkViewer` =
  vtk.js全体をimportする重いモジュール）から `DEFAULT_VOLUME_OPACITY_POINTS` を
  import → `lib/imageData.ts` へ移動。

### RF-7. nonce方式の廃止（imperative handle化）【優先度: 中 / 規模: 小】

`screenshotNonce`/`exportNonce`/`resetNonce`（App.tsx:93–95）による
「stateインクリメントでコマンド発火」方式は、`clientExport` の10秒 `setTimeout`
フォールバック（App.tsx:623）のような脆いレース検出を生んでいる。

**作業**: `VtkViewer` に `useImperativeHandle` で `screenshot()` / `exportGeometry(): boolean` /
`resetCamera()` を公開し、Appは同期戻り値で結果を判定。

### RF-8. その他【優先度: 低 / 規模: 小】

- API エラーの構造化: `api.ts:41–49` は全失敗を文字列Errorに潰す →
  `ApiError { status, body }` 型を導入し 401→再ログイン誘導、413→分かりやすい
  容量超過メッセージなど分岐可能に。
- a11y: `DatasetPanel.tsx:241–245` のクリック可能`<li>`に `role`/`tabIndex`/キー操作を
  追加（または`<button>`化）。モーダル（App.tsx:945–946）にEscapeキー対応。
- i18n: `ScalarColorSection.tsx:61` の `〜` 区切りをカタログへ
  （ja/enカタログ自体は219キー完全一致で健全）。

---

## 3. リファクタリング — 開発基盤・インフラ

### RI-1. Lint導入【優先度: 高 / 規模: 小】

現在CIは typecheck+test+build のみで **linterが皆無**。

- frontend: ESLint（`typescript-eslint` + `eslint-plugin-react-hooks`）。
  hooks依存配列の regressions（過去に実際に発生: render-loop hooks修正）を機械検出できる。
- backend: `ruff`（lint + format）、可能なら `mypy --strict` を段階導入。
- CIに `lint` ジョブを追加。

### RI-2. 依存関係の整理【優先度: 中 / 規模: 小】

`backend/requirements.txt` に実行時依存と `pytest` が混在 →
`requirements.txt` / `requirements-dev.txt` に分離（または `pyproject.toml` 移行）。

### RI-3. アプリ本体のコンテナ化【優先度: 中 / 規模: 中】

`infra/docker-compose.yml` は Postgres/MinIO のみ。
[server-deployment-memo.md](server-deployment-memo.md) の将来Docker移行方針に沿って、
backend / frontend（nginx静的配信）のDockerfileと full-stack compose profile を追加。

---

## 4. テスト補強

### バックエンド（現在138件）

| 対象 | 理由 |
|---|---|
| `responses.py` `LeasedFileResponse` | lease解放（early-return / エラー経路）がクラスの存在意義なのに直接テストなし |
| `bundles.py` path containment | `..`/絶対パス/ドライブ文字のセキュリティ境界。パラメトライズテストを追加 |
| `project_locks.py` | `BEGIN IMMEDIATE` 経路・例外時rollback・ロック内RBAC再チェックの並行性テストなし |
| `pipeline_lifecycle.py` | `(pipeline_id is None) == (project_id is None)` ガードが偶発的カバーのみ |
| `config.py` | truthy-env解析（`s3_presigned_downloads` 等）の分岐が未テスト |
| S3 store (`storage.py:118–310`) | `_evict_cache` 等のキャッシュeviction。motoまたはstubで |

**方針**: §1のH級リファクタ（RB-1〜RB-4）の**前または同時**にこれらを追加し、
抽出したヘルパーをテストで固定してから動かす。

### フロントエンド（現在84件）

| 対象 | 優先度 |
|---|---|
| `useJobPolling` / `useProjectResources`（mock apiで容易） | 高 |
| `useDisplayState.reset()` | 高 |
| RF-1で抽出する各フック（upload/stale-guardフロー含む） | 高（抽出と同時） |
| `VtkViewer` シーンビルダー（RF-4後にmock render windowで） | 中 |
| `DatasetPanel` / `RemoteViewer` / `AssistantSection` / `oidc.ts` | 中 |

### E2E（新規）

Playwright によるスモークE2E（アップロード→表示→ViewState保存→復元→ダウンロード）を
1本導入し、CIのfrontendジョブに追加。手動の
[verify-all-features.md](verify-all-features.md) の一部を自動化する足がかりとする。

---

## 5. 追加機能候補

既存17候補は完了済みのため、以下は次期候補。優先度は「解析ユーザー価値 ÷ 実装コスト」。

| # | 機能 | 価値 | 難易度 | 最初のスライス |
|---:|---|---|---|---|
| F1 | **VTU（UnstructuredGrid）のブラウザ直接描画** | 高 | 中 | vtk.js XMLUnstructuredGridReader + surface抽出。現在はサーバ変換必須で、CAE主要形式なのに直読できない |
| F2 | **統計ヒストグラムのUI可視化** | 高 | 低〜中 | 既存stats JSONジョブ（ヒストグラム含む）の結果をフロントでチャート表示。バックエンド完成済みで表示だけが未実装 |
| F3 | **クライアントサイドclip/slice平面ウィジェット** | 高 | 中 | vtk.js `vtkClipClosedSurface`/plane widgetでPolyDataの対話的clip。サーバ往復なしの即時操作感 |
| F4 | **Probe/ピッキング** | 中〜高 | 中 | クリック点のpoint/cell scalar値をツールチップ表示。vtk.js hardware selector |
| F5 | **比較ビュー（2-up viewport）** | 中〜高 | 中〜高 | 2 datasetまたは2 timestepを並べてカメラ同期。ViewState基盤を再利用 |
| F6 | **ジョブキューの外部化** | 中（運用） | 中〜高 | in-process job manager → Dramatiq/RQ。当初計画（work_plan.md M1）の未消化項目。水平スケールとプロセス再起動耐性 |
| F7 | **データセットのタグ/検索** | 中 | 低〜中 | Dataset にtags列+一覧フィルタ。プロジェクトが育つと必須になる |
| F8 | **計測ツール（距離/角度）** | 中 | 中 | vtk.js distance widget。CAE実務の定番要望 |
| F9 | **カスタムcolormap import（JSON）** | 低〜中 | 低 | ParaView `.json` colormap preset読込。RF-6の単一情報源化が前提 |
| F10 | **表示状態のundo/redo** | 低〜中 | 中 | ViewState履歴スタック。RF-2のcontext化が前提 |

**推奨**: F2（バックエンド済みで表示のみ）→ F1（対応形式の本丸）→ F3/F4（対話性向上）の順。
F6は機能ではなく運用要件が生じた時点で着手。

---

## 6. 推奨実施順序

依存関係と「テストで固定してから動かす」原則でフェーズ分けする。

### Phase R1: 安全網（1〜2日相当）
1. RI-1 lint導入（ESLint / ruff）+ CI組み込み
2. §4バックエンドの `bundles.py` / `responses.py` / `project_locks.py` テスト追加
3. §4フロントの `useJobPolling` / `useProjectResources` / `useDisplayState` テスト追加
4. RI-2 依存分離

### Phase R2: 高優先リファクタ（3〜5日相当）
1. RB-1 ジョブ骨格抽出 → RB-3 認可集約 → RB-2 アップロード共通化 → RB-4 ingest分割
2. RF-3 blob download統一（小さく独立、いつでも可）
3. RF-1 App.tsx フック分割（抽出と同時に各フックへテスト）
4. RF-2 PropertiesPanel context化

### Phase R3: 中優先リファクタ（2〜4日相当）
1. RB-5〜RB-7 共有ヘルパー（serve_object / broker.py / validation.py）
2. RF-4+RF-5 VtkViewer分割と型付け
3. RF-6 定数の単一情報源化、RF-7 imperative handle化
4. RB-8 / RF-8 の小型修正一式

### Phase R4: 機能追加（順次）
1. F2 ヒストグラムUI → F1 VTU直読 → F3/F4 対話ツール
2. E2Eスモーク（Playwright）導入
3. RI-3 コンテナ化（デプロイ要件が確定した時点）

### 完了条件（全体DoD)
- CI: lint + typecheck + test + build が全て通る
- テスト: バックエンド160件以上 / フロントエンド110件以上（目安）
- `App.tsx` ≤ 500行、`services.py` ≤ 450行、`datasets.py` ≤ 400行（目安)
- コードベースから `any` と跨モジュールprivate importがゼロ
- 挙動変更なし（リファクタフェーズ中はAPI/UIの外部仕様を凍結）
