# サーバー配置メモ

最終更新: 2026-08-02

この文書は、初期公開をGitHub Pagesで行い、将来MyParaView-Webを本格的なサーバーへ
移行するための方針と作業手順を記録するメモです。G11 で実装した単一サーバー向け
`full-stack` Compose profile と、まだ外部で用意する必要がある機能を区別して記載します。

## GitHub Pagesへのフロントエンドデプロイ（実装済み）

`.github/workflows/deploy-pages.yml` が `main` push時に `frontend/` を
`npm run build` し、`actions/deploy-pages` で公開します。`vite.config.ts` の
`base` はproduction buildでのみ `/MyParaview-Web/` を使用します
（`VITE_BASE_PATH` で上書き可能）。

初回のみ、リポジトリのSettings > Pages で Source を「GitHub Actions」に切り替える
必要があります。

これは**フロントエンドの静的配信のみ**です。プロジェクト一覧・データセットupload・
pipeline実行などは引き続きFastAPIバックエンドへのHTTP呼び出しが必要なため、
バックエンドを別途どこかへデプロイしない限り、公開されたUIはロードはできても
データ操作はエラーになります。バックエンドを用意したら、リポジトリのSettings >
Secrets and variables > Actions > Variables に `VITE_API_BASE`（例:
`https://api.example.com`）を設定し、backend側で該当Pages originからのCORSを
許可してください。ブラウザ内で完結し外部APIを一切呼ばない「真の`static`モード」
（下記）は未実装です。

## 公開モードの方針

同じリポジトリから次の2モードをビルドできる形を目標とします。

- `static`: GitHub Pages向け。ファイルはブラウザ内で読み込み、DBやFastAPIを使わない。
- `server`: 本格サーバー向け。FastAPI、PostgreSQL、S3/MinIO、OIDCを使用する。

想定するビルド変数は `VITE_APP_MODE=static|server` です。サーバーモードではフロントエンドと
APIを同一originで公開し、リバースプロキシが `/api` をFastAPIへ転送する構成を優先します。
これにより、公開先ごとのCORS設定とAPI URL指定を最小化できます。

## 現在の状態

- profileを指定しない `infra/docker-compose.yml` は従来どおりPostgreSQL、MinIO、
  bucket初期化だけを起動する。
- `--profile full-stack` を付けると、`migration`、FastAPIの `api`、Reactを配信する
  nginxの `web` が追加で起動する。
- `backend/Dockerfile` はnon-rootのAPI image、`frontend/Dockerfile` はNode buildから
  non-root nginxへ成果物だけを渡すmulti-stage imageである。
- nginxは同一originの `/api/*` をFastAPIの `/*` へ転送し、SSEとWebSocket upgradeも
  proxyする。React routeは `index.html` へfallbackする。
- `migration` がAlembic headへの更新に成功してからAPIを起動する。現行APIは起動時にも
  Alembicの冪等なhead確認を行う。
- HTTPS終端、証明書管理、backup/restore、image registry公開はこのprofileの外側で用意する。
- ParaView、`pvpython`、ffmpeg、trame brokerはbase imageに含めない。設定していない
  capabilityは `/api/capabilities` で `false` のままである。

## 目標とするコンテナ構成

```text
Internet
   |
   v
TLS proxy / load balancer (HTTPS)
   |
   v
web / nginx (HTTP, React配信, /api proxy)
   |
   +--> api (FastAPI)
           +--> postgres
           +--> minio または外部S3
           +--> redis --> job-worker (RQ)
           +--> pvpython worker（任意）
           +--> trame broker（任意）
```

基本サービスは次のとおりです。

| サービス | 役割 | 永続化 |
|---|---|---|
| `web` | React配信、`/api` proxy（HTTP） | 不要 |
| `api` | FastAPI、認証、ファイル・ジョブ管理 | container専用anonymous cacheのみ |
| `migration` | API起動前にAlembicを1回実行 | 不要 |
| `postgres` | project、metadata、job、権限など | 必須volume |
| `minio` | upload、export、artifact本体 | 必須volume |
| `redis` | 永続job queue（AOF） | 必須volume |
| `job-worker` | DB jobを取得して実行するRQ worker | container専用anonymous cacheのみ |
| `worker` | ParaView変換・filter | 任意 |
| `trame-broker` | remote rendering session | 任意 |

単一サーバーの初期構成は
`web / api / job-worker / redis / postgres / minio / minio-init / migration` です。
ParaView workerとtrameは、実体を含む派生imageまたは別serviceとリソース制限を
用意した段階で追加します。

## リポジトリ側で整備済みのもの

- `backend/Dockerfile`
- `frontend/Dockerfile`（Node build + nginxのmulti-stage build）
- `frontend/nginx.conf`
- rootの `.dockerignore`
- `infra/docker-compose.yml` の `full-stack` profile
- `.env.production.example`（秘密値を含めない雛形）
- migration専用のone-shot service
- Redis AOF volumeと独立RQ worker
- API、web、PostgreSQL、Redis、MinIOのhealthcheck

今後の運用作業は、HTTPSを終端する外部proxy/load balancer、container imageのregistry公開、
PostgreSQLとobject storageのbackup/restore自動化です。サーバー固有の値はDockerfileを
変更せず、環境変数またはsecretとして渡します。

## 初回配置手順

サーバーにはDocker Engine、Docker Compose plugin、Gitを導入しておきます。

```bash
git clone https://github.com/Takayuki-Minagawa/MyParaview-Web.git
cd MyParaview-Web
cp .env.production.example .env.production
```

`.env.production` にドメイン、DB password、MinIO credential、OIDC設定を記入します。
exampleの `change-me` / `example.com` はすべて置き換えてください。このファイルは
`.gitignore` と `.dockerignore` の対象であり、Gitへcommitせず、Compose configの展開結果も
secretを含むためログへ貼り付けません。

設定確認後に起動します。

```bash
docker compose --env-file .env.production -f infra/docker-compose.yml \
  --profile full-stack config --quiet
docker compose --env-file .env.production -f infra/docker-compose.yml \
  --profile full-stack build
docker compose --env-file .env.production -f infra/docker-compose.yml \
  --profile full-stack up -d
docker compose --env-file .env.production -f infra/docker-compose.yml \
  --profile full-stack ps
```

起動後は `http://<host>:${PVWEB_WEB_PORT:-8080}/healthz` と `/api/health` を確認し、
OIDC login、upload、表示、download、project削除を確認します。`web` が公開するのはHTTPです。
インターネットへ公開するときは、前段のload balancer/Caddy/nginx等でHTTPSを終端し、
`PVWEB_WEB_PORT` はその前段からだけ到達できるようにします。exampleはweb、PostgreSQL、
MinIOのpublish先を `127.0.0.1` に限定しています。

loopback上の手動確認に限り、OIDCの代わりに明示的なdev認証を使えます。
nginxは外部の`/api`をAPI container内の`/`へstripするため、Composeでは
`PVWEB_ROOT_PATH=/api`を渡します。これによりSwagger/OpenAPI URLとredirect先にも
公開prefixが保持され、同じ値がfrontend buildの`VITE_API_BASE`にも渡されます。別prefixで
公開する場合は`PVWEB_ROOT_PATH`に加え、`frontend/nginx.conf`の`location`と
`X-Forwarded-Prefix`を揃えて変更します。`proxy_pass`末尾の`/`によるprefix stripは維持し、
web imageを再buildします。

API imageは既定ではloopbackからのproxy headerだけを信頼します。Composeは専用networkの
`PVWEB_COMPOSE_SUBNET`だけを`FORWARDED_ALLOW_IPS`へ渡します。サブネット競合を避けて値を
変更する場合も、この1変数だけを変更してください。API portを直接公開する構成で
`FORWARDED_ALLOW_IPS=*`を指定しないでください。

```bash
PVWEB_AUTH_MODE=dev PVWEB_ALLOW_INSECURE_DEV_AUTH=1 \
PVWEB_WEB_BIND_ADDRESS=127.0.0.1 POSTGRES_BIND_ADDRESS=127.0.0.1 \
MINIO_BIND_ADDRESS=127.0.0.1 \
  docker compose -f infra/docker-compose.yml --profile full-stack up --build -d
curl --fail http://localhost:8080/healthz
curl --fail http://localhost:8080/api/health
curl --fail http://localhost:8080/api/capabilities
curl --fail http://localhost:8080/api/docs | grep '/api/openapi.json'
```

このdev認証を外部interfaceへ公開しないでください。

## 更新手順（想定）

ソースからサーバー上でbuildする場合:

```bash
git pull --ff-only
docker compose --env-file .env.production -f infra/docker-compose.yml \
  --profile full-stack build
docker compose --env-file .env.production -f infra/docker-compose.yml \
  --profile full-stack up -d
docker compose --env-file .env.production -f infra/docker-compose.yml \
  --profile full-stack ps
```

将来GHCRへimageを公開する場合は、サーバーにソース一式を置かず、Composeと環境設定だけを置いて
`docker compose pull` と `docker compose up -d` で更新できます。image tagは `latest` 固定ではなく、
release tagまたはcommit SHAへ固定する方針にします。

## サーバーごとに設定する値

最低限、次を環境変数またはsecretで設定します。

- 公開domainとHTTPS設定
- `PVWEB_DATABASE_URL`
- PostgreSQL user/password
- `PVWEB_OBJECT_STORE=s3`
- bucket、endpoint、region、S3/MinIO credential
- `PVWEB_AUTH_MODE=oidc`
- `PVWEB_OIDC_ISSUER`
- `PVWEB_OIDC_AUDIENCE`
- `PVWEB_OIDC_JWKS_URL`
- frontend buildの `VITE_APP_MODE=server`（Composeが設定）
- `VITE_OIDC_AUTHORITY`
- `VITE_OIDC_CLIENT_ID`
- `VITE_OIDC_REDIRECT_URI`
- upload上限、cache上限、worker timeout
- worker/trameを使う場合だけ、それぞれの実体、URL、command、token、allowlist

本番環境で `PVWEB_AUTH_MODE=dev` や `PVWEB_ALLOW_INSECURE_DEV_AUTH=1` は使用しません。
また、stockのAPI imageに存在しない `/opt/paraview/bin/pvpython` 等を値だけ設定しません。
ParaView/ffmpegを含む派生imageまたはread-only mountを構成し、container内で実行確認してから
`PVWEB_PVPYTHON` / `PVWEB_FFMPEG` を設定します。trameも到達可能なbrokerとhost allowlistを
用意してから設定します。X11版ParaViewでrender/movieを実行する場合は、`PVWEB_PVPYTHON`から
起動するwrapperでXvfbと`--force-offscreen-rendering`を使用するか、EGL/OSMesa対応buildを
採用してください。

## 永続データとバックアップ

永続データはコンテナimageやコンテナ本体に置かず、volumeまたは外部サービスへ保存します。

- PostgreSQL: project、user、権限、dataset metadata、pipeline、job、artifact record
- MinIO/S3: uploadしたdataset、bundle member、export、screenshot、変換結果
- Redis: queued RQ message。DBのjob recordと同じ復旧点でbackupする
- API / job-worker cache: containerごとのanonymous volume。再生成できるためbackup対象外

S3/MinIOのobject本体は両serviceで共有しますが、read-through cacheは共有しません。
cacheのlease、download lock、起動時の一時file cleanupはprocess-localに管理されるため、
APIとjob-workerで同じcache directoryをmountすると、相手processが使用中のfileを削除する
可能性があります。Composeではsource未指定のanonymous volumeをmountし、同一serviceを
水平scaleした場合も各replicaのcacheを分離してこの競合を防ぎます。

APIとjob-workerは起動時にDBの`queued` jobをRedisへ再投入します。RQ job idはDB job idから
一意に決まり、複数replicaが同時起動してもRedis側のatomic unique enqueueで重複を防ぎます。
実行中にworkerが失われたjobはRQ retry後に同じDB recordから再構築されます。
object削除意図もPostgreSQLのoutboxへ先にcommitし、APIが既定30秒ごとに最大100件ずつ再試行します。
間隔とbatch上限は`PVWEB_OBJECT_DELETE_INTERVAL_SECONDS`と
`PVWEB_OBJECT_DELETE_BATCH_SIZE`で変更できます。project削除時は応答遅延を有界にするため
最大5,000件だけをrequest内で同期drainし、残りはこの周期drainが回収します。

`docker compose down` は通常volumeを残しますが、`docker compose down -v` は永続volumeを削除するため、
本番では実行しません。DB recordとobjectを対応させる必要があるため、PostgreSQLとMinIO/S3は同じ
復旧点としてbackupします。restore試験も定期的に行います。

## 公開時の安全確認

- 外部公開portは原則 `80/443` のみ。
- PostgreSQL `5432`、MinIO API/console `9000/9001` は直接インターネットへ公開しない。
- HTTPSを必須にし、HTTPはHTTPSへredirectする。
- password、OIDC secret、S3 keyをGitへcommitしない。
- OIDC redirect URIとallowed originを本番domainに限定する。
- reverse proxyでrequest body上限とtimeoutをupload要件に合わせる。
- containerをnon-rootで実行し、不要なhost directory mountを避ける。
- dependencyとbase imageを定期更新し、CI成功後のimageだけを配置する。
- job-worker/ParaView worker/trameにはCPU、memory、実行時間、同時実行数の上限を設ける。
- Redisを外部公開せず、AOF永続化、memory監視、DB/object storeと整合した復旧試験を行う。

## 配置前チェックリスト

- [ ] `static` / `server` のbuild切替が実装されている
- [x] backend/frontend Dockerfileがある
- [x] `infra/docker-compose.yml` に `full-stack` profileがある
- [x] nginxがReactと `/api`（SSE/WebSocketを含む）を配信する
- [ ] 本番secretがGit管理外である
- [x] migration serviceの成功後にAPIが起動する
- [x] PostgreSQLとobject storageに永続volumeがある
- [x] Redis/RQ workerがAPIから分離され、Redisに永続volumeがある
- [ ] API再起動中もRQ jobが完了することを本番相当環境で検証した
- [ ] DB/object backupとrestoreを検証した
- [ ] OIDC loginとrole付与を検証した
- [ ] upload/download/deleteを本番相当環境で検証した
- [ ] HTTPSとWebSocket proxyを検証した
- [ ] PostgreSQL/MinIOのportが外部へ露出していない
- [x] app serviceのrestart policyと主要serviceのhealthcheckを設定した
- [ ] 外部のログ収集・監視とalertを設定した

## 現時点の判断

GitHub Pages公開は引き続きフロントエンドのみです。本格サーバーではG11の `full-stack`
profileを初期構成として使用できます。これは単一host向けのHTTP originであり、HTTPS、backup、
監視、外部workerは運用環境側で補います。サーバーごとにDockerfileを調整せず、共通imageと
Composeを使用し、環境差分をsecretと環境変数に限定します。
