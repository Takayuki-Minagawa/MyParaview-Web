# 全追加機能の検証手順

## 自動検証

```bash
cd backend
.venv/bin/pytest -q

cd ../frontend
npm run typecheck
npm test -- --run
npm run build

cd ..
python3 -m pytest -q python
git diff --check
```

PostgreSQL offline migration:

```bash
cd backend
PVWEB_DATABASE_URL=postgresql+psycopg://u:p@localhost/db \
  .venv/bin/alembic -c alembic.ini upgrade head --sql >/tmp/pvweb.sql
```

## G11 container構成の検証

profileなしの従来構成とfull-stack構成を両方展開し、Composeの参照・環境変数・
healthcheck構文を検証する。

```bash
docker compose -f infra/docker-compose.yml config --quiet
docker compose --env-file .env.production.example \
  -f infra/docker-compose.yml --profile full-stack config --quiet
docker compose --env-file .env.production.example \
  -f infra/docker-compose.yml --profile full-stack build
```

loopbackでE2E相当の確認を行う場合は、production用OIDC placeholderを使わず、
この起動だけ明示的にdev認証へ切り替える。

```bash
PVWEB_AUTH_MODE=dev PVWEB_ALLOW_INSECURE_DEV_AUTH=1 \
  docker compose -f infra/docker-compose.yml --profile full-stack up --build -d
docker compose -f infra/docker-compose.yml --profile full-stack ps
curl --fail http://localhost:8080/healthz
curl --fail http://localhost:8080/api/health
curl --fail http://localhost:8080/api/capabilities
```

ブラウザでproject作成、VTP upload、表示、download、project削除まで確認する。
stock imageはParaView/ffmpeg/trameを含めず設定も渡さないため、capabilitiesの
`paraview_worker`、`video_export`（実装されている版の場合）、`trame_sessions` が
`false` であることも確認する。実体のないcommand/pathを設定して成功扱いにしない。

確認後はvolumeを削除せず停止する。

```bash
docker compose -f infra/docker-compose.yml --profile full-stack down
```

## Browser smoke test

1. Projectを作成/選択する。
2. VTPをuploadし、surface/wireframe/points、point/cell着色、map、range、opacity、legendを確認。
3. CSVをuploadし、XYZ列を変更して点群を確認。
4. VTIをuploadし、X/Y/Z sliceとvolumeを確認。
5. PVD folderをuploadし、step 0/1、play/pause、load完了待ちを確認。
6. 表示状態を保存し、別状態から復元してcamera/表示設定が戻ることを確認。
7. screenshot/source exportがArtifact一覧へ追加され、downloadできることを確認。
8. `?project=<id>&dataset=<id>`を開き、対象datasetが自動選択されることを確認。
9. assistantに「temperature の等値面」を入力し、提案だけではjobが増えないことを確認。
10. ParaView worker未設定時、server filter buttonが無効であることを確認。

## Security boundary test

- PVD: missing/escaping/non-finite/repeated timestep、不正part、standalone sibling分離を検証。
- VTK/PVD XML: DTD/internal entityをdefusedxmlで拒否。
- XDMF/EnSight: absolute path、external URI、未upload sidecarを拒否。
- RBAC: viewer write=403、非member read=403、unscoped legacy job/artifactはfail closed。
- OIDC: issuer/audience/JWKSの部分設定=503、不正/expired/exp欠落token=401。
- Pipeline: reader→filter→representationの自己参照chainを保持したPipeline/Project削除が204。
- S3 download: 正常、Range 400/416、client disconnectの全経路でcache leaseを解放。
- Session: broker WS host allowlist外=502、TTL到達でproxy/remote cleanup。
- Worker: timeout/cancelでprocess tree停止、stdout/stderr大量出力でもdeadlockしない。
