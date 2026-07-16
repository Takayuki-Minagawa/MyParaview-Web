# リファクタリング作業 進捗管理

計画: [refactoring-and-feature-plan.md](refactoring-and-feature-plan.md)
ブランチ: `feature/refactoring-2026-07`

## 再開手順（セッションが中断した場合）

1. `git log --oneline main..HEAD` で完了済みコミットを確認
2. 本ファイルのチェックリストで次の未完了タスクを特定
3. `cd backend && ./.venv/bin/pytest -q` と `cd frontend && npm test -- --run && npm run typecheck` で現状が緑であることを確認してから次タスクへ
4. 1タスク = 1コミットの原則。作業途中で止まった場合は `git stash` せず、テストが通る単位まで完成させてコミットするか revert する

## 運用ルール

- 各タスク完了時: テスト実行 → コミット → 本ファイルのチェックボックス更新（次コミットに含めてよい）
- コミットメッセージ先頭にタスクID（例: `R1-1: Add ESLint ...`）
- 外部仕様（API/UI）はリファクタフェーズ中は凍結

## Phase R1: 安全網

- [x] R1-1: ESLint導入（typescript-eslint + react-hooks）+ npm run lint
- [x] R1-2: ruff導入（backend lint/format設定）
- [x] R1-3: CIにlintジョブ追加
- [x] R1-4: backend依存分離（requirements-dev.txt）
- [x] R1-5: bundles.py の単体テスト（path containment）
- [x] R1-6: responses.py LeasedFileResponse の単体テスト
- [x] R1-7: project_locks.py の並行性/rollbackテスト
- [x] R1-8: pipeline_lifecycle.py / config.py のテスト
- [x] R1-9: useJobPolling / useProjectResources のテスト
- [x] R1-10: useDisplayState のテスト

## Phase R2: 高優先リファクタ

- [x] R2-1 (RB-1): services.py ジョブ骨格の共通ヘルパー抽出
- [x] R2-2 (RB-3): access.py 認可リゾルバ集約
- [x] R2-3 (RB-2): アップロード3エンドポイント共通化 + audit付与ヘルパー
- [x] R2-4 (RB-4): run_ingest 分割
- [x] R2-5 (RF-3): lib/download.ts blob download統一（timestep拡張子修正込み）
- [x] R2-6 (RF-1): App.tsx フック分割（usePipelineActions / useDatasetJobs / useRemoteSession / useDeepLink / useDatasetUpload）
- [x] R2-7 (RF-2): DisplayStateContext 導入、PropertiesPanel props削減 + memo化

## Phase R3: 中優先リファクタ

- [x] R3-1 (RB-5): responses.serve_object 共通化
- [x] R3-2 (RB-6): broker.py 新設、remote削除ヘルパー2本化
- [x] R3-3 (RB-7): validation.py 新設（sniff系移動）
- [x] R3-4 (RF-4/5): VtkViewer シーンビルダー分割 + Scene型付け
- [x] R3-5 (RF-6): JobKind/colormap/representation 単一情報源化
- [x] R3-6 (RF-7): nonce廃止 → useImperativeHandle
- [x] R3-7 (RB-8): backend小型修正一式（audit CSV分離、last-adminガード抽出、owning_project_id一元化、型注釈、_plan_output、_write_params）
- [x] R3-8 (RF-8): frontend小型修正一式（ApiError構造化、a11y、i18n `〜`）

## Phase R4: 機能追加

- [x] R4-1 (F2): 統計ヒストグラムのUI可視化
- [x] R4-2 (F1): VTU（UnstructuredGrid）ブラウザ直接描画
- [x] R4-3: E2Eスモーク（実施可否は環境依存 — Playwrightブラウザ取得が不可なら見送りを記録）

対象外（今回スコープ外として記録）: F3〜F10、RI-3（デプロイ要件確定後）

## 最終フェーズ

- [ ] FIN-1: 全テスト・lint・typecheck・build 緑を確認
- [ ] FIN-2: PR作成（gh pr create）
- [ ] FIN-3: サブエージェントによるレビュー→修正を、指摘ゼロになるまで反復
