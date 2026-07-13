# サーバー配置メモ

最終更新: 2026-07-13

この文書は、初期公開をGitHub Pagesで行い、将来MyParaView-Webを本格的なサーバーへ
移行するための方針と作業手順を記録するメモです。記載している本番用ファイル名とコマンドは
目標形を示すものであり、未実装のものは「整備予定」と明記します。

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

- `infra/docker-compose.yml` が起動するのはPostgreSQL、MinIO、bucket初期化だけ。
- FastAPI用Dockerfile、フロントエンド用Dockerfile、本番用Compose、リバースプロキシ設定は未作成。
- 現時点では、リポジトリをサーバーへコピーするだけではアプリ全体は起動しない。
- バックエンドを直接起動する場合はPython環境、フロントエンドにはNode.jsのbuildと静的配信が必要。
- DB migrationはAlembic `0007` がhead。現在はFastAPI起動時にもmigrationが実行される。

## 目標とするコンテナ構成

```text
Internet
   |
   v
web / reverse proxy (HTTPS, React配信, /api proxy)
   |
   +--> api (FastAPI)
           +--> postgres
           +--> minio または外部S3
           +--> pvpython worker（任意）
           +--> trame broker（任意）
```

基本サービスは次のとおりです。

| サービス | 役割 | 永続化 |
|---|---|---|
| `web` | React配信、HTTPS終端、`/api` proxy | 不要 |
| `api` | FastAPI、認証、ファイル・ジョブ管理 | cacheのみ |
| `migration` | API起動前にAlembicを1回実行 | 不要 |
| `postgres` | project、metadata、job、権限など | 必須volume |
| `minio` | upload、export、artifact本体 | 必須volume |
| `worker` | ParaView変換・filter | 任意 |
| `trame-broker` | remote rendering session | 任意 |

単一サーバーの初期構成では、`web / api / postgres / minio / migration` から始めます。
workerとtrameは必要になった段階で追加します。

## リポジトリ側で一度だけ整備するもの

以下は今後追加する予定です。

- `backend/Dockerfile`
- `frontend/Dockerfile`（Node build + CaddyまたはNginxのmulti-stage build）
- `compose.production.yml`
- `.env.production.example`（秘密値を含めない）
- CaddyfileまたはNginx設定
- migration専用のone-shot service
- API、PostgreSQL、MinIOのhealthcheck
- GitHub Actionsによるcontainer image buildとGHCR publish（任意）
- PostgreSQLとobject storageのbackup/restore手順

これらを一度整備すれば、サーバーごとにDockerfileを書き換える必要はありません。
サーバー固有の値は環境変数またはsecretとして渡します。

## 初回配置手順（本番用Compose整備後の想定）

サーバーにはDocker Engine、Docker Compose plugin、Gitを導入しておきます。

```bash
git clone https://github.com/Takayuki-Minagawa/MyParaview-Web.git
cd MyParaview-Web
cp .env.production.example .env.production
```

`.env.production` にドメイン、DB password、S3/MinIO credential、OIDC設定を記入します。
このファイルはGitへcommitしません。

設定確認後に起動します。

```bash
docker compose --env-file .env.production -f compose.production.yml config
docker compose --env-file .env.production -f compose.production.yml build
docker compose --env-file .env.production -f compose.production.yml up -d
docker compose --env-file .env.production -f compose.production.yml ps
```

起動後は、health endpoint、ログイン、upload、表示、download、project削除を確認します。

## 更新手順（想定）

ソースからサーバー上でbuildする場合:

```bash
git pull --ff-only
docker compose --env-file .env.production -f compose.production.yml build
docker compose --env-file .env.production -f compose.production.yml up -d
docker compose --env-file .env.production -f compose.production.yml ps
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
- `VITE_APP_MODE=server`
- `VITE_OIDC_AUTHORITY`
- `VITE_OIDC_CLIENT_ID`
- `VITE_OIDC_REDIRECT_URI`
- upload上限、cache上限、worker timeout
- worker/trameを使う場合だけ、それぞれのURL、command、token、allowlist

本番環境で `PVWEB_AUTH_MODE=dev` や `PVWEB_ALLOW_INSECURE_DEV_AUTH=1` は使用しません。

## 永続データとバックアップ

永続データはコンテナimageやコンテナ本体に置かず、volumeまたは外部サービスへ保存します。

- PostgreSQL: project、user、権限、dataset metadata、pipeline、job、artifact record
- MinIO/S3: uploadしたdataset、bundle member、export、screenshot、変換結果
- API cache: 再生成できるためbackup対象外

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
- worker/trameにはCPU、memory、実行時間、同時実行数の上限を設ける。

## 配置前チェックリスト

- [ ] `static` / `server` のbuild切替が実装されている
- [ ] backend/frontend Dockerfileがある
- [ ] `compose.production.yml` がある
- [ ] 本番secretがGit管理外である
- [ ] migrationがAPIの複数起動より前に1回だけ成功する
- [ ] PostgreSQLとobject storageに永続volumeがある
- [ ] DB/object backupとrestoreを検証した
- [ ] OIDC loginとrole付与を検証した
- [ ] upload/download/deleteを本番相当環境で検証した
- [ ] HTTPSとWebSocket proxyを検証した
- [ ] PostgreSQL/MinIOのportが外部へ露出していない
- [ ] restart policy、healthcheck、ログ監視を設定した

## 現時点の判断

初期公開はGitHub Pagesの `static` モードを使用します。本格サーバーへの移行時は、既存の
FastAPI/PostgreSQL/S3/OIDC実装を `server` モードとしてcontainer化します。サーバーでは
Dockerfileを毎回調整するのではなく、共通imageとComposeを使用し、環境差分をsecretと環境変数に
限定します。
