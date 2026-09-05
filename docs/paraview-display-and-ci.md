# ParaViewとの機能比較・表示機能追加とCI分離

確認日: 2026-09-06

## コード確認結果と候補

既存のvtk.jsビューアはVTP/VTU/VTS/VTR/VTI/CSV/PVD、断面・クリップ、Probe、
距離・角度計測、ベクトルGlyph、比較表示まで対応している。ParaView worker側にも
Contour/Thresholdなど7種類のフィルタがあり、同名機能を重複追加する必要はない。

[ParaView公式の表示ガイド](https://docs.paraview.org/en/latest/UsersGuide/displayingData.html)
と、`VtkViewer`・`camera.ts`・表示状態管理・API検証を照合し、次の順で候補を整理した。

| 候補 | 今回の対応 | 根拠・境界 |
| --- | --- | --- |
| Surface / Surface With Edgesの分離 | 実装 | 既存Surfaceはエッジを常に有効にしていた。通常表面をエッジなしに修正し、専用の表現を追加 |
| 平行投影 / 透視投影 | 実装 | カメラツールバーにトグルを追加。注視点での大きさを保ち、比較ビューの同期にも含める |
| 単色・エッジ色・点サイズ・線幅 | 実装 | vtk.jsのactor propertyへ接続。スカラー着色中は単色編集を無効化 |
| 上記設定の保存・復元・Undo/Redo | 実装 | 表示履歴・PipelineのAPI保存・比較ビューへ接続。既存schema_version=1を読み込み可能 |
| ベクトル成分選択（X/Y/Z/Magnitude） | 次候補 | 現状は着色のMagnitude固定。UIだけでなくrange、凡例、VTI、保存形式の整合が必要 |
| Spreadsheet View / Plot Over Line | 次候補 | Probeに加え、配列全体や線上サンプリングを確認できる。表面データと体積補間の区別が必要 |
| Calculator / Warp By Vector | 次候補 | workerフィルタ・入力検証・Pipeline連鎖までの実装が必要 |
| ブラウザ単独ファイル読込 | 次候補 | Pagesのみでデータ操作するための機能。現状のuploadとproject管理はAPIが必要 |

今回の表示機能はブラウザのvtk.js描画が対象。別サービスのtrame UIやpvpythonの
render/movieジョブに新しい表示設定を適用する変更は含まない。古い保存データの
`surface`は今後エッジなしになる。以前の見た目が必要な場合は「エッジ付きサーフェス」を選ぶ。

点サイズは1–30、線幅は1–10。実際に描画できる線幅はWebGL実装の上限による。
小規模CSVの球Glyphは、従来の半径を点サイズ7として比例変更する。
VTIでは形状用の色・点・線編集を表示せず、既存のスカラー／volume設定を使用する。

## GitHub Pagesを使わない検証

通常のGitHub-hosted CI workflowとpush時の自動Pagesデプロイを廃止した。
`scripts/ci.sh`をローカル、社内CI、任意の外部ランナーで共通利用する。
GitHubへのpush/PRだけではCIもPagesも起動しない。

初回準備（Node.js 22.12+、Python 3.11+）:

```bash
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-dev.txt
(cd frontend && npm ci && npx playwright install chromium)
# Linuxでは必要に応じて npx playwright install --with-deps chromium
```

通常の検証:

```bash
bash scripts/ci.sh check
```

Ruff、配布ZIP検証テスト、backendのcoverage下限80%、Pythonクライアントテスト、
PostgreSQL migration SQL生成、TypeScript、ESLint、frontend coverage下限、
production build、実APIを起動するPlaywright E2E、diff checkを順に実行する。
失敗した段階で停止し、古い配布ZIPも無効化する。依存のインストールや公開は行わない。

push前に自動実行する場合:

```bash
git config --local core.hooksPath .githooks
```

既存のGit hookを設定済みの場合は、そのhookから`bash scripts/ci.sh check`を呼ぶ。
この設定はcloneごとに必要。外部CIではcheckout・依存インストール後に同じコマンドを呼ぶ。
branch protectionに旧GitHub Actionsの必須checkが残っている場合は管理画面で見直す必要がある。

Pythonの対応下限3.11と配布版3.13は、それぞれの仮想環境で検証する。
PostgreSQLを用意したランナーでは、**破棄可能な専用DB**を指定して追加検証する:

```bash
PVWEB_DATABASE_URL=postgresql+psycopg://user:password@localhost/test_db \
  bash scripts/ci.sh postgres
```

## 検証済み成果物の最終配置

公開API URLはActionsの変数ではなく、**検証・ビルドする環境**に指定する。
`VITE_BASE_PATH`、必要な`VITE_OIDC_*`も同様。バックエンド側では公開originのCORSを許可する。

```bash
VITE_API_BASE=https://api.example.com \
VITE_BASE_PATH=/MyParaview-Web/ \
  bash scripts/ci.sh release
```

全検証が成功した場合だけ、`artifacts/pages/pages-site.zip`と
`pages-site.zip.sha256`を生成する。ZIPには`build-info.json`としてcommitと未コミット変更の
有無も記録する。公開物はcommit済みのリリース対象から作成し、dirty=falseを確認する。

1. ZIPを、このリポジトリのGitHub Releaseに`pages-site.zip`という名前で添付する。
2. PagesのSourceを「GitHub Actions」に設定する。
3. `deploy-pages`を**main上で手動実行**し、Release tagと、検証環境が出力したSHA-256を入力する。

このworkflowはReleaseからの取得・チェックサム照合・ZIPの展開・Pagesへの最終配置のみを行う。
テスト、npm install、ビルドを再実行しない。配置用のActions実行とPagesの配信制限は引き続き適用される。
チェックサム不一致、不正なZIPパス、symlink、512 MiBを超える展開データは配置前に拒否する。

配布ZIPをローカル確認するときは次のように展開して配信できる（未使用の出力先を指定）:

```bash
backend/.venv/bin/python scripts/pages_bundle.py unpack artifacts/pages/pages-site.zip /tmp/pvweb-release/MyParaview-Web
python3 -m http.server 8080 --directory /tmp/pvweb-release
# http://localhost:8080/MyParaview-Web/
```

## 今回の検証結果

- Python 3.11 / 3.13: backend各365件成功。3.13のbranch coverage込み総合80%以上。
- Frontend: 233件成功、TypeScript・ESLint・production build成功。
- Playwright: 新しい表示設定の描画／保存復元／Undo/Redo／投影同期を含む5シナリオ成功。
- Pythonクライアント3件、ZIP展開テスト2件、migration SQL生成、workflow YAML・shell構文の確認成功。
- PostgreSQL実DBへのmigrationとGitHub Pages本番配置はこの作業では実行していない。

今回のローカル成果物は未コミットの変更を含む検証用ビルド。公開用API URLを設定した
commit済みのリリースから、公開用ZIPを作成する。
