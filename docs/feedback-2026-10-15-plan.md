# 追加要望（2026-10-15 動作確認結果）への対応計画

作成日: 2026-10-15

対象: 「MyParaview-Web 追加要望・動作確認結果」（確認日 2026-10-15）で整理された
F-01〜F-07、R-01〜R-06。本文書は、要望ごとの原因調査結果、対応方針、受入条件への
対応、今回の実装範囲外の項目を記録する。

## 1. 調査結果（GitHub / リポジトリ）

- Issue: 未登録（open 0件）。要望書の項目に対応する既存Issueはない。
- Pull Request: open はすべて dependabot の依存更新。直近の機能PRは
  [#41](https://github.com/Takayuki-Minagawa/MyParaview-Web/pull/41)（PVD再生・metadata・
  Linux CI、2026-10-04 merge）で、要望書の項目とは重複しない。
- `docs/server-deployment-memo.md` は `static` / `server` の2モード方針を「目標」として
  記録しているが、`VITE_APP_MODE` の実装は未着手だった（配置前チェックリスト未完了）。
- `docs/paraview-display-and-ci.md` の候補表でも「ブラウザ単独ファイル読込」は次候補。

### 不具合の原因確認（ソース）

| ID | 原因箇所 | 内容 |
|---|---|---|
| F-01 | `frontend/src/api.ts` | `VITE_API_BASE` 未指定時に `http://localhost:8000` へ固定。Pages 配布物はこの既定値のまま起動時に `/projects` と `/capabilities` を呼ぶ |
| F-02 | `DatasetPanel.tsx` | `onCreateProject()` 呼出し直後に `setNewName("")`。成功を待たない |
| F-03 | `styles.css` | `.segmented button` / `.mode-controls` の子要素に `white-space: nowrap` と `flex-shrink: 0` がなく、flex 縮小で1文字ずつ折り返す |
| F-04 | `styles.css` | `.workspace` が常に `300px 1fr 320px` の固定3列。632px では中央が 12px になる |
| F-05 | `App.tsx` | Escape は backdrop の `onKeyDown` でのみ処理。Tab のフォーカス循環・起点への復帰がない |
| F-06 | `i18n.ts` | `manual.publicNote` が「静的公開ではブラウザ内表示機能を使う」と説明するが実装がない |
| F-07 | `DatasetPanel.tsx` / `App.tsx` | project select・新規名入力・ファイル入力に label がない。エラーバナーに `role="alert"` がない |
| R-05 | `DatasetPanel.tsx` | 作成が `<form>` ではなく button click のみ。空欄時は無反応 |
| R-06 | `App.tsx` | 背景とパネル開閉は state のみで保存されない（テーマ・言語は localStorage） |

## 2. 対応方針

### アプリモード（F-01 / R-01 / R-04 / F-06）

`frontend/src/lib/appMode.ts` で接続設定を決定する。

| 条件 | モード | API 接続先 | 起動時の接続 |
|---|---|---|---|
| `VITE_APP_MODE=static` | static | なし | しない |
| `VITE_API_BASE` 指定 | server | 指定値 | する |
| `VITE_APP_MODE=server`（API 未指定） | server | `http://localhost:8000` | する |
| Vite dev server（`npm run dev`）で未指定 | server | `http://localhost:8000` | する（従来どおりのローカル開発） |
| production build で未指定（GitHub Pages） | static | なし | しない |

- static モードでは、利用者が「サーバーに接続」を選んで URL を入力するまで API へ
  一切アクセスしない（R-01）。入力した接続先は次回の候補として保存するが、自動接続は
  しない。
- 接続状態（未接続 / 接続中 / 接続済み / 失敗）、接続先、失敗理由、次に行える操作を
  左パネル上部の「接続」セクションに表示し、再接続ボタンと診断情報コピーを設ける（R-04）。
  `Failed to fetch` は「サーバー未起動・URL誤り・CORS 拒否のいずれか」として案内する。
- マニュアルは現在のモードを表示し、「ブラウザで利用可能」「サーバー接続が必要」
  「未対応」を分けて説明する（F-06）。

### ローカルファイル表示と内蔵サンプル（R-02）

- `frontend/src/lib/localDataset.ts`: 拡張子からブラウザ描画可否を判定し、`File` から
  `blob:` URL を持つ `Dataset` を合成する。PVD はフォルダ選択で参照先を解決し、不足
  ファイル名を列挙して通知する。
- メタデータ（配列・点数・境界）は `VtkViewer` が読み込み後に報告する
  `onSceneSummary` から取得する（サーバー ingest を使わない）。CSV は列名をブラウザで解析する。
- `frontend/public/samples/` に正常（VTP/VTU/VTS/VTR/VTI/CSV/PVD）、破損、未対応、
  関連ファイル不足の各サンプルを同梱し、「サンプルを開く」から読み込む。
- ローカルデータセット選択中はサーバー専用セクション（サーバフィルタ・AI・統計・trame・
  Artifacts）を隠し、「ブラウザ内処理・サーバーへ送信しない」旨と、スクリーンショット・
  ジオメトリ書き出し（ローカル保存）を表示する。
- 着色・クリップ・スライス・Probe・計測・比較・Undo/Redo はローカルでも既存の
  ビューア機能をそのまま使用する。

### プロジェクト作成・ラベル・通知（F-02 / R-05 / F-07）

- 作成を `<form>` にし Enter で送信。空欄・空白のみは `role="alert"` で理由を表示。
- 作成は Promise の成功後だけ入力をクリアし、処理中はボタンを無効化して二重送信を防ぐ。
- project select、新規プロジェクト名、単一ファイル、フォルダの各入力に表示ラベルを付ける。
  無効なときは理由（プロジェクト未選択・未接続）を `aria-describedby` で関連付ける。
- エラーバナーは `role="alert"`、処理中表示は `role="status"`。
- パネル開閉ボタンは `aria-expanded` と `aria-controls`、操作名のラベルを持つ。

### レイアウト（F-03 / F-04 / R-06）

- ツールバーのボタンを `white-space: nowrap; flex-shrink: 0` にし、グループ単位で折り返す。
- 幅 900px 以下ではサイドパネルを中央に重なるドロワーにし、初期状態で両方閉じる。
  トップバーの開閉ボタンから常に到達できる。「ビューア最大化」「レイアウト初期化」を追加。
- 背景・パネル開閉状態を localStorage に保存し、「表示設定を初期化」で
  テーマ・言語・背景・パネルを既定へ戻す。

### マニュアル（F-05）

- `ManualDialog` コンポーネントに分離。Tab / Shift+Tab をダイアログ内で循環、
  どこにフォーカスがあっても Escape で閉じ、閉じた後は起点ボタンへ戻す。

### 数値操作（R-03）

- プロパティパネルに「カメラ」セクション: 位置・注視点・上方向・平行投影倍率の数値入力、
  適用・リセット。ビューア操作と同期（`cameraState` を共有）。
- クライアント平面ツールに原点・法線の数値入力を追加（`planeTool` に `setPlane` /
  `getPlane` / 変更通知を追加）。
- Probe・計測結果を「テキストをコピー」で取得可能にする。単位は元データに情報がない
  ため「単位: データに定義なし」と明記する。
- 計測点の座標入力は vtk.js の widget state 操作の検証が必要なため今回の範囲外とする。

## 3. 範囲外・後続

- 計測点（距離・角度）の数値入力、Probe 結果の CSV 一括出力。
- サイドパネルのドラッグリサイズ。
- 公開 Pages の再配置（`scripts/ci.sh release` と `deploy-pages` の手動実行は運用作業）。
- 「許可ダイアログ」の実体は未特定のため、本対応では「明示操作まで localhost へ接続しない」
  設計で R-01 の受入条件を満たし、再現時に診断情報で特定できるようにする。

## 4. 検証計画

- 単体: `appMode`、`localDataset`（拡張子判定・PVD 解析・不足ファイル）、フォーカストラップ、
  カメラ入力の検証。
- コンポーネント: 作成フォーム（Enter・空欄・失敗時保持）、接続セクション、ローカル読込、
  マニュアルのキーボード操作。
- E2E: 既存 5 シナリオのセレクタをラベル基準に更新（ローカル入力の追加で `first()` が
  変わるため）。
- レイアウト: Playwright で 632px / 1280px の日英ツールバーとパネル幅を確認。
- 静的モードのスモーク: production build を static で起動し、API への通信が発生しない
  ことと、サンプル読込→着色→断面→画像保存を確認。
