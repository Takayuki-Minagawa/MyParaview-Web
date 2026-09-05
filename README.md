# MyParaView-Web

ParaView風の科学データWebビューアです。小～中規模データはReact + vtk.jsで直接描画し、
外部形式・重いフィルタ・サーバレンダリングは、任意構成のParaView/trame workerへ安全に委譲します。

追加機能候補17件の実装状態と境界は
[docs/implementation-status.md](docs/implementation-status.md) に集約しています。
GitHub Pagesでの初期公開と将来のDockerサーバー移行方針は
[docs/server-deployment-memo.md](docs/server-deployment-memo.md) に記録しています。

## 公開範囲

このリポジトリは研究・開発中のWeb可視化アプリケーションです。GitHub Pagesなどの静的公開では、
ブラウザ内で完結するファイル表示機能を初期対象とします。プロジェクト保存、認証、サーバフィルタ、
trame session、PostgreSQL/S3連携はサーバーモードで提供する機能です。

今回のParaView表示機能追加と、Pagesを最終配置に限定するCI手順は
[docs/paraview-display-and-ci.md](docs/paraview-display-and-ci.md) を参照してください。

## 主な機能

- VTP: surface / surface with edges / wireframe / points、point/cell scalar、5種の組み込みcolormap、ParaView JSON preset import、手動range、opacity、凡例
- VTU: ブラウザ内で外表面を抽出して直接描画（ascii / inline binary / raw appended、zlib対応。未対応形式はサーバVTP変換へ誘導）、point/cell scalar着色、表面のclient export
- VTS/VTR: StructuredGrid / RectilinearGridの外表面をブラウザ内で抽出して直接描画（VTUと同じDataArray encoding範囲、未対応形式はサーバVTP変換へ誘導）
- VTI: X/Y/Z slice とvolume rendering（2〜4点の不透明度transfer function編集）
- CSV: X/Y/Z列選択による点群化（ブラウザ上限250,000点、無効行スキップ数を表示）
- PVD: 参照ファイル込みbundle upload、時系列slider/playback、step単位download、完全bundle ZIP export
- 対話ツール: VTP/VTU/VTS/VTRのクライアントclip/slice平面、point/cell scalar Probe、距離/角度計測、最大2,000本に制限したvector glyph
- 比較・管理: dataset名検索、タグの付与/絞り込み、datasetまたはtimestepの2画面比較、カメラ同期（WebGL contextは最大2）
- 表示状態: Pipeline browser（保存・復元・リネーム・サーバ実行）、camera/representation/color/VTI/PVD状態の保存・復元、共有リンク、最大50履歴のundo/redo
- 表示編集: 平行投影/透視投影、単色・エッジ色・点サイズ・線幅（保存/復元、Undo/Redo、比較ビュー対応）
- UX: job center（フィルタ/ページングAPI、SSEストリーム）、cancel、進捗/ログ、panel折りたたみ、resize、orientation axesトグル、6方向標準view、背景色選択
- Artifact: source/bundle export、VTP変換、統計JSON（ヒストグラム含む）とそのUI可視化（配列別ヒストグラム/件数/平均/範囲/標準偏差）、client screenshot/geometry export、Artifact→Dataset昇格、認証付きdownload
- ジョブ・解析: 開発用local executorまたはRedis/RQ worker、7種のParaView filter、Pipelineフィルタ連鎖、PNG frame ZIP / MP4 / WebM animation export
- 本番基盤: backend/frontend container、full-stack Compose、Alembic、PostgreSQL、S3/MinIO（presigned URL redirect対応）、OIDC Code+PKCE、Project RBAC（メンバー削除対応）、監査ログ（Web UIビューア + CSV export）
- Server capability: pvpython reader/convert/filter/render/movie、trame broker session、期限付きWebSocket proxy とフロントのリモートビューア
- R&D: WebGPU/WASM検出（描画は安定版vtk.js WebGL）、Python/Jupyter deep link、安全な操作提案（永続化・確認後適用・却下）

## アーキテクチャ

```text
React + vtk.js ── HTTP/JSON ── FastAPI ── PostgreSQL or SQLite
      │                            ├────── S3/MinIO or local object store
      │                            ├────── local executor (development)
      │                            ├────── Redis/RQ ── independent job worker
      │                            │                    └── pvpython + ffmpeg (optional)
      └── OIDC Code+PKCE           └────── trame broker + WS proxy (optional)
```

外部worker/brokerが未設定の場合、該当操作は成功扱いにせず、503またはfailed jobで
capability不足を明示します。

## ローカル起動

Python 3.11+、Node.js 22.12+を使用します。

```bash
cd backend
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
PVWEB_AUTH_MODE=dev PVWEB_ALLOW_INSECURE_DEV_AUTH=1 ./.venv/bin/uvicorn app.main:app --reload
```

別ターミナルで:

```bash
cd frontend
npm install
npm run dev
```

- UI: `http://localhost:5173`
- API/OpenAPI: `http://localhost:8000/docs`
- `VITE_API_BASE`でAPI URLを変更可能

## full-stack container起動

`backend/Dockerfile`、`frontend/Dockerfile`と`full-stack` Compose profileで、migration、
API、Redis/RQ worker、nginx配信フロント、PostgreSQL、MinIOをまとめて起動できます。
本番相当の起動前に`.env.production.example`を`.env.production`へ複製し、OIDCやsecretの
placeholderを実値へ置き換えてください。

```bash
docker compose --env-file .env.production \
  -f infra/docker-compose.yml --profile full-stack up --build -d
docker compose --env-file .env.production \
  -f infra/docker-compose.yml --profile full-stack ps
```

loopback上でdev認証を使う確認手順とhealth endpointは
[docs/verify-all-features.md](docs/verify-all-features.md#g11-container構成の検証)を参照してください。

## PostgreSQL + MinIO

```bash
docker compose -f infra/docker-compose.yml up -d
set -a
source infra/.env.example
set +a
cd backend
PVWEB_AUTH_MODE=dev PVWEB_ALLOW_INSECURE_DEV_AUTH=1 ./.venv/bin/uvicorn app.main:app
```

`dev` modeはloopback上のローカル開発専用です。`X-PVWeb-User`を検証しないため、
`PVWEB_ALLOW_INSECURE_DEV_AUTH=1`も明示しない限り503になります。外部へ公開する環境では
使用せず、`PVWEB_AUTH_MODE=oidc`とOIDC 3値を設定してください。

MinIO bucketは`minio-init`が作成します。S3 objectはimmutable key + local read-through
cacheでVTK reader/FileResponseへ渡されます。cacheは
`PVWEB_S3_CACHE_MAX_BYTES`（既定5 GiB）と`PVWEB_S3_CACHE_TTL_SECONDS`（既定24時間）で制限されます。
full-stack ComposeではMinIO/S3のobject本体だけを共有し、process-localなlease/lockを安全に保つため、
APIとjob-workerのread-through cacheにはsource未指定のanonymous volumeを使います。scale時も
各containerが固有volumeを持つため、同一serviceのreplica間でもcacheを共有しません。
`PVWEB_S3_PRESIGNED_DOWNLOADS=1`を設定すると、dataset/artifactのダウンロードは
API経由のストリーミングではなく期限付きpresigned URLへの307リダイレクトになります。

その他の調整可能な上限: `PVWEB_MAX_ARTIFACT_BYTES`（client artifact上限、既定32 MiB）、
`PVWEB_AUDIT_LIST_LIMIT`（監査ログ一覧の最大件数、既定500）。

## OIDC / RBAC

Backendはデフォルトでfail closedです。ローカル開発だけ`PVWEB_AUTH_MODE=dev`と
`PVWEB_ALLOW_INSECURE_DEV_AUTH=1`を明示し、
本番では`PVWEB_AUTH_MODE=oidc`と次の3値をすべて設定します。欠落時は503になります。

```text
PVWEB_AUTH_MODE=oidc
PVWEB_OIDC_ISSUER
PVWEB_OIDC_AUDIENCE
PVWEB_OIDC_JWKS_URL
```

FrontendはAuthorization Code + PKCEを使用します。

```text
VITE_OIDC_AUTHORITY
VITE_OIDC_CLIENT_ID
VITE_OIDC_REDIRECT_URI  # 省略時は現在のapp path
```

roleは`viewer / editor / admin`です。明示的なdev modeだけ`anonymous`を使用し、
テスト用途に限り`X-PVWeb-User`で開発identityを切り替えられます。adminはWeb UIから
OIDC subjectへroleを付与できます。

既存local DBをOIDCへ切り替える初回だけ、復旧adminのOIDC `sub`を
`PVWEB_BOOTSTRAP_ADMIN_SUBS=<sub>`（複数はカンマ区切り）に指定してください。ログイン時に
`anonymous` adminが残るlegacy projectだけadmin権限が付与されます。確認後は環境変数を外し、
以降のメンバー追加はWeb UIで行います。

## ジョブ実行方式

追加サービスなしで動かす場合は既定の`local` executorを使用します。API再起動を跨ぐ永続jobや
workerの水平分離が必要な環境ではRedis/RQを選択します。RQ messageは永続化済みjob IDだけを持ち、
workerがDBから検証済みoperationを再構築します。enqueue失敗は503/failedとして扱い、偽のqueuedを
残しません。

```text
PVWEB_JOB_QUEUE_BACKEND=rq
PVWEB_REDIS_URL=redis://redis:6379/0
PVWEB_JOB_QUEUE_NAME=pvweb
```

APIと同じbackend image/environmentで`python -m app.rq_worker`を起動します。
`full-stack` Compose profileではRedisとRQ workerも自動起動します。
DB commit後のobject削除は永続outboxから再試行されます。APIの周期drainは
`PVWEB_OBJECT_DELETE_INTERVAL_SECONDS`（既定30秒）と
`PVWEB_OBJECT_DELETE_BATCH_SIZE`（既定100件）で上限を調整できます。project削除requestでは
最大5,000件を同期drainし、それを超える安全な残りは周期drainへ引き継ぎます。既定値では
残りを約200件/分で回収します。数万object規模のprojectを運用する場合は、object storeとDBの
負荷を確認しながら`PVWEB_OBJECT_DELETE_BATCH_SIZE`（最大1,000件）を増やすかintervalを短縮します。

## ParaView / ffmpeg worker capability

```text
PVWEB_PVPYTHON=/opt/paraview/bin/pvpython
PVWEB_FFMPEG=/usr/bin/ffmpeg
PVWEB_WORKER_TIMEOUT=900
```

`workers/pv_worker.py`を別process groupで起動し、cancel/timeout時は子孫processも停止します。
対応する縦スライスは次のとおりです。

- CGNS / Exodus / EnSight / XDMF metadata reader
- external/composite dataset → MergeBlocks → ExtractSurface → VTP
- Slice / Clip / Contour / Threshold / Cell Data to Point Data / Resample To Image / Decimation → surface VTP Artifact
- Contourのcell scalarはCell Data to Point Dataを挿入
- render: サーバサイドscreenshot（PNG Artifact、サイズ/着色/timestep指定可）
- movie: 全timestepのframe PNG ZIP、またはffmpegによるMP4（H.264）/ WebM（VP9）Artifact
- Pipeline実行: `POST /pipelines/{id}/run`が保存済みフィルタ連鎖を順に適用しVTP Artifactを生成

ParaView未設定時、これらのジョブは成功を偽らず`PVWEB_PVPYTHON`必要の明示エラーでfailedになります。
MP4/WebMは`PVWEB_FFMPEG`も必要で、未設定時もPNG ZIPは引き続き利用できます。
ffmpegの検出成功・失敗はAPI process内でcacheされます。起動後にffmpegをinstallした場合や
実行fileを差し替えた場合は、APIとjob workerを再起動してcapabilityを再検出してください。
配列統計（`kind=stats`）はworker不要で、CSVとascii VTK XMLの範囲でmin/max/mean/stddevと
ヒストグラムをJSON Artifactに出力します（binary/appended配列は明示的に失敗します）。

EnSight/XDMFはdescriptorとsidecarをfolder uploadします。相対参照closureを検証し、
absolute path、外部URI、未upload参照を拒否します。

## trame session broker

```text
PVWEB_TRAME_BROKER_URL=http://trame-broker:9002
PVWEB_TRAME_ALLOWED_WS_HOSTS=trame-broker
PVWEB_SESSION_TTL=3600
```

`POST /sessions`はbrokerへTTLを渡し、返却WebSocket hostをallowlist検査します。
client capability tokenはURL queryではなく`Sec-WebSocket-Protocol`で渡します。期限到達時は
proxyを閉じ、remote sessionをbest-effort cleanupします。

## Python / Jupyter deep link

```python
from python.pvweb_client import PVWebClient

client = PVWebClient("http://localhost:5173")
client.open_view(project_id="...", dataset_id="...")
```

`pipeline_id`も指定できます。OIDC redirect後もsame-originの元deep linkを復元します。

## 安全な操作アシスタント

`POST /assist/proposals`はdataset metadataからSlice/Clip/Contour/Threshold/着色の
変更案を返すだけで、JobやArtifactを生成しません。UIはJSON差分を表示し、現在dataset・prompt・
request世代の一致を再確認してから、利用者の明示操作で適用します。

提案は`assist_proposals`テーブルに永続化されます。`GET /assist/proposals?dataset_id=`で履歴を
参照でき、`POST /assist/proposals/{id}/apply`はfilter提案を検証のうえjobとして実行して
`applied`へ、`POST /assist/proposals/{id}/dismiss`は`dismissed`へ遷移させます。
表示変更（view_change）提案はクライアント側で適用されます。

## テスト

```bash
(cd backend && .venv/bin/pytest -q && .venv/bin/ruff check --config ruff.toml .)
(cd frontend && npm run typecheck && npm run lint && npm test && npm run build)
(cd frontend && npm run e2e)  # Playwright（初回は npx playwright install chromium）
backend/.venv/bin/python -m pytest -q python
git diff --check
```

CIと同じカバレッジレポートは次のコマンドで生成できます。バックエンドは
`backend/coverage/`、フロントエンドは`frontend/coverage/`にHTMLなどのレポートを出力します。

```bash
cd backend
mkdir -p coverage
.venv/bin/pytest --cov=app --cov=../workers --cov-branch --cov-fail-under=80 --cov-report=term-missing --cov-report=xml:coverage/coverage.xml --cov-report=html:coverage/html
cd ../frontend
npm run test:coverage
```

検証は `bash scripts/ci.sh check` をローカルまたは外部CIで実行します。GitHub Actionsの
通常CIは起動しません。サポート下限のPython 3.11と、backend imageが配布するPython 3.13の
両方で同じコマンドを実行する運用です。frontend coverageにもlines 51%、branches 45%、functions 48%、
statements 49%の退行防止下限を設定しています。

GitHub DependabotはPython・npm・GitHub Actions・Docker Composeの依存関係を週次で確認します。
脆弱性に基づく更新PRも受け取るには、リポジトリ側のDependabot alertsとsecurity updatesを
有効にしてください。

実操作の確認項目は[docs/verify-all-features.md](docs/verify-all-features.md)を参照してください。

## 重要な制約

- PVD browser playbackは現時点で各時刻1 DataSet（VTP/VTI/VTU/VTS/VTRの同一形式）です。
- WebGPU/WASMはfeature detection段階で、rendererはvtk.js WebGLです。
- trame/ParaView自体はこのrepositoryに同梱しません。外部capabilityとして接続します。
- productionではworker/brokerをcontainer分離し、CPU/GPU/memory/time quotaを設定してください。

## ライセンス

このリポジトリ固有のソースコードは[MIT License](LICENSE)で提供します。著作権表示と
ライセンス文を維持する条件で、利用・改変・再配布・商用利用が可能です。

React、vtk.js、FastAPI、ParaView などの第三者ソフトウェアと依存パッケージには、それぞれの
ライセンスが適用されます。配布物を作成する場合は、各依存関係のライセンス表記とNOTICEの条件を
確認してください。
