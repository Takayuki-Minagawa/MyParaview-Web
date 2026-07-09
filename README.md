# MyParaView-Web

ParaView風の科学データWebビューアです。小～中規模データはReact + vtk.jsで直接描画し、
外部形式・重いフィルタ・サーバレンダリングは、任意構成のParaView/trame workerへ安全に委譲します。

追加機能候補17件の実装状態と境界は
[docs/implementation-status.md](docs/implementation-status.md) に集約しています。

## 主な機能

- VTP: surface / wireframe / points、point/cell scalar、3種のcolormap、手動range、opacity、凡例
- VTI: X/Y/Z slice とvolume rendering
- CSV: X/Y/Z列選択による点群化（ブラウザ上限250,000点）
- PVD: 参照ファイル込みbundle upload、時系列slider/playback、完全bundle ZIP export
- 表示状態: Pipeline browser、camera/representation/color/VTI/PVD状態の保存・復元
- UX: job center、cancel、進捗/ログ、panel折りたたみ、resize、orientation axes、標準view
- Artifact: source/bundle export、client screenshot、worker生成VTPの一覧と認証付きdownload
- 本番基盤: Alembic、PostgreSQL、S3/MinIO、OIDC Code+PKCE、Project RBAC、監査ログ
- Server capability: pvpython reader/convert/filter、trame broker session、期限付きWebSocket proxy
- R&D: WebGPU/WASM検出（描画は安定版vtk.js WebGL）、Python/Jupyter deep link、安全な操作提案

## アーキテクチャ

```text
React + vtk.js ── HTTP/JSON ── FastAPI ── PostgreSQL or SQLite
      │                            ├────── S3/MinIO or local object store
      │                            ├────── cancellable local job manager
      │                            ├────── pvpython worker (optional)
      └── OIDC Code+PKCE           └────── trame broker + WS proxy (optional)
```

外部worker/brokerが未設定の場合、該当操作は成功扱いにせず、503またはfailed jobで
capability不足を明示します。

## ローカル起動

Python 3.9+、Node.js 20+を使用します。

```bash
cd backend
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
./.venv/bin/uvicorn app.main:app --reload
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

## PostgreSQL + MinIO

```bash
docker compose -f infra/docker-compose.yml up -d
set -a
source infra/.env.example
set +a
cd backend
PVWEB_AUTH_MODE=dev ./.venv/bin/uvicorn app.main:app
```

MinIO bucketは`minio-init`が作成します。S3 objectはimmutable key + local read-through
cacheでVTK reader/FileResponseへ渡されます。cacheは
`PVWEB_S3_CACHE_MAX_BYTES`（既定5 GiB）と`PVWEB_S3_CACHE_TTL_SECONDS`（既定24時間）で制限されます。

## OIDC / RBAC

Backendはデフォルトでfail closedです。ローカル開発だけ`PVWEB_AUTH_MODE=dev`を明示し、
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

## ParaView worker

```text
PVWEB_PVPYTHON=/opt/paraview/bin/pvpython
PVWEB_WORKER_TIMEOUT=900
```

`workers/pv_worker.py`を別process groupで起動し、cancel/timeout時は子孫processも停止します。
対応する縦スライスは次のとおりです。

- CGNS / Exodus / EnSight / XDMF metadata reader
- external/composite dataset → MergeBlocks → ExtractSurface → VTP
- Slice / Clip / Contour / Threshold → surface VTP Artifact
- Contourのcell scalarはCell Data to Point Dataを挿入

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

## テスト

```bash
cd backend && .venv/bin/pytest -q
cd frontend && npm run typecheck && npm test -- --run && npm run build
python3 -m pytest -q python
git diff --check
```

実操作の確認項目は[docs/verify-all-features.md](docs/verify-all-features.md)を参照してください。

## 重要な制約

- PVD browser playbackは現時点で各時刻1 DataSet（VTPまたはVTI、同一形式）です。
- WebGPU/WASMはfeature detection段階で、rendererはvtk.js WebGLです。
- trame/ParaView自体はこのrepositoryに同梱しません。外部capabilityとして接続します。
- productionではworker/brokerをcontainer分離し、CPU/GPU/memory/time quotaを設定してください。
