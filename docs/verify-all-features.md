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

PostgreSQL 16でタグmigration、削除outbox migration、実検索まで確認する場合は、必ず破棄可能な
検証専用databaseを使う。このscriptはhead（0010）→0008→head（0010）のmigrationと
検証rowの挿入を行うため、開発・本番databaseへ向けて実行しない。

```bash
cd backend
PVWEB_DATABASE_URL=postgresql+psycopg://u:p@localhost/db \
  .venv/bin/python -m scripts.verify_postgres_tags
```

## 2026-08-02 実施記録

このブランチで実際に確認した範囲を、手順と区別して記録する。

- Playwright全4 scenario（browser smoke、2-up比較、対話ツールVTP、対話ツールVTU）が
  4/4 PASS。clip平面drag前後のcanvas変化、Probeのcell scalar値、正の距離readout、2 canvas、
  primary canvasのdragに追従するsecondary camera、比較表示を10回再生成した後のcontext slot再利用を
  確認した。
- 一時PostgreSQL 16 containerでfresh databaseをheadへmigrationした後、0010→0008 downgrade、
  legacy dataset挿入、0008→0010 upgrade、空tagsのbackfill、JSON tagのcase-insensitive検索、
  `object_deletion_outbox`の作成とjobへの外部キーを持たないことを`scripts.verify_postgres_tags`で
  確認した。さらに12件のterminal jobを並列drainし、PostgreSQL advisory lock下で12/12件が
  一度ずつACKされることを確認した。確認用container/network/volumeは終了後に削除した。
- full-stack image buildとCompose起動を行い、`/healthz`、`/api/health`、`/api/capabilities`、
  `/api/docs`から`/api/openapi.json`への参照、外部Host/portを保持したslash redirectを確認した。
- Redis/RQ構成でworker停止中に作成したqueued jobがAPI再起動後も同じID・状態で残り、worker再開後に
  成功することを確認した。別のqueued jobはworker再開前にcancelし、再開後も実行されず
  `canceled`のままArtifactを作らないことを確認した。
- 検証専用Compose projectで`job-worker`を2 replica作成し、`docker inspect`で
  `/var/lib/pvweb`に異なるanonymous volume IDが割り当てられることを確認した。
  検証用container、network、volumeは確認後に削除した。
- ParaView 5.10.1の実`pvpython`でG10の3 filterを実行した。Cell Data to Point Dataはcell配列を
  point配列へ変換し、Resample To Image `[4,4,4]`は8 points / 6 cells、Decimation 0.5は
  224→112 cellsとなった。生成した3 VTPは別`pvpython` processから再読込できた。
- 同じ実runtimeとXvfbによるoffscreen renderingで2 timestepのPVDを処理し、160×120 PNG、
  H.264/yuv420p MP4、VP9/yuv420p WebMを生成した。両動画とも2 frameをdecode確認した。
  実ffmpeg単体でも3 frame（322×242）の両codecを確認した。
- 実ParaView 5.10の内蔵Python 3.8で見つかった`str.removeprefix`非互換を修正し、metadataが
  PolyData、point/cell数、point/cell配列を返すことも再確認した。
- backend 354 test、frontend 214 test、Python client 3 testがすべてPASS。最終coverageはbackendが
  line 84.57% / branch 67.69%（term総合81%）、frontendがline 51.54% / branch 45.98%だった。
  新規logicと外部capability未設定時の失敗境界を含む。

実runtime検証には`openfoam/openfoam11-paraview510:latest`のParaView 5.10.1を使用した。
このimageはX11版でX serverを含まないため、repositoryをmountしないcontainerでXvfb packageを
取得し、`--network none`の一時imageから`xvfb-run`と`--force-offscreen-rendering`で検証した。
一時container/image/outputは終了後に削除した。以下は別の配布用runtimeでも再確認できる手順である。

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

展開後の構成で、APIとjob-workerが同じ永続object store設定を使いながら、
`/var/lib/pvweb`はsource未指定のanonymous volumeであることも確認する。これにより
Compose/Engineがcontainerごとに固有volumeを割り当て、scaleしたreplica間でも共有されない。

```bash
docker compose --env-file .env.production.example \
  -f infra/docker-compose.yml --profile full-stack config --format json \
  > /tmp/pvweb-compose.json
python3 - <<'PY'
import json

with open("/tmp/pvweb-compose.json") as source:
    config = json.load(source)

services = config["services"]
cache_source = lambda service: next(
    mount
    for mount in services[service]["volumes"]
    if mount["target"] == "/var/lib/pvweb"
)
for service in ("api", "job-worker"):
    cache = cache_source(service)
    assert cache["type"] == "volume"
    assert "source" not in cache
for key in ("PVWEB_S3_BUCKET", "PVWEB_S3_ENDPOINT_URL"):
    assert services["api"]["environment"][key] == services["job-worker"]["environment"][key]
PY
```

実containerでscale時の分離を確認する場合は、検証専用project名でworkerを2個createし、
それぞれの`/var/lib/pvweb`に異なるanonymous volume名が割り当てられることを
`docker inspect`で確認する。確認後は検証用projectを`down -v`で削除する。

```bash
docker compose -p pvweb-cache-verify -f infra/docker-compose.yml \
  --profile full-stack up --no-build --no-deps --no-start \
  --scale job-worker=2 job-worker
for container in $(docker compose -p pvweb-cache-verify \
  -f infra/docker-compose.yml --profile full-stack ps -q job-worker); do
  docker inspect --format \
    '{{range .Mounts}}{{if eq .Destination "/var/lib/pvweb"}}{{.Name}}{{end}}{{end}}' \
    "$container"
done
docker compose -p pvweb-cache-verify -f infra/docker-compose.yml \
  --profile full-stack down -v --remove-orphans
```

loopbackでE2E相当の確認を行う場合は、production用OIDC placeholderを使わず、
この起動だけ明示的にdev認証へ切り替える。

```bash
PVWEB_AUTH_MODE=dev PVWEB_ALLOW_INSECURE_DEV_AUTH=1 \
PVWEB_WEB_BIND_ADDRESS=127.0.0.1 POSTGRES_BIND_ADDRESS=127.0.0.1 \
MINIO_BIND_ADDRESS=127.0.0.1 \
  docker compose -f infra/docker-compose.yml --profile full-stack up --build -d
docker compose -f infra/docker-compose.yml --profile full-stack ps
curl --fail http://localhost:8080/healthz
curl --fail http://localhost:8080/api/health
curl --fail http://localhost:8080/api/capabilities
curl --fail http://localhost:8080/api/docs | grep '/api/openapi.json'
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

## G1〜G3 client interaction manual test

1. scalarを含むVTPまたはVTUを表示し、**Clip**を有効にする。平面widgetをdragして切断面が
   即時更新され、サーバjobが作られないことを確認する。**Slice**へ切り替え、平面上の断面だけに
   変わることも確認する。
2. **Probe**を有効にして形状をクリックし、座標、point/cell ID、point/cell scalar値がtooltipへ
   表示されることを確認する。hardware selectorが値を返さない環境でもray picker fallbackで
   point IDが維持されることを確認する。
3. **距離**を選んで形状上の2点を指定し、正の距離が表示されることを確認する。
   **角度**へ切り替えて3点を指定し、degree値が表示されることを確認する。
4. reset、tool切替、dataset切替を繰り返し、古いwidget・tooltip・measurement readoutが残らず、
   browser consoleにerrorが出ないことを確認する。

自動E2EはVTP/VTU双方でClip、Probeの既知cell scalar、距離readoutを固定している。

## G4 dataset tags/search manual test

1. editor/adminでdatasetのタグ編集を開き、`thermal, Review, thermal`のような入力を保存する。
   空白と重複が正規化され、tag chipが表示されることを確認する。
2. dataset名の部分検索とタグの完全一致検索をそれぞれ実行し、両方を指定した場合は両条件に
   一致するdatasetだけが表示されることを確認する。タグの大文字小文字は区別しない。
3. viewerにはタグ編集controlが出ず、APIで更新しても403になることを確認する。editorの更新が
   監査ログに記録されることも確認する。
4. PostgreSQLを使う場合は上記`python -m scripts.verify_postgres_tags`を実行し、0009の
   legacy row backfillとJSON array検索、および0010の削除outbox tableを確認する。

## G6 custom colormap manual test

1. Propertiesの **ParaView カラーマップ JSON を読み込む** から`RGBPoints`または
   `IndexedColors`を含むpresetを選び、preset名がcolormap選択肢へ追加されることを確認する。
2. presetを選び、surface/volumeと凡例が同じ色停止点へ更新されることを確認する。
3. 壊れたJSON、非有限値、0〜1外のRGB、重複scalar位置、1 MB超のfileを読み込み、現在の
   colormapを変えず明示errorになることを確認する。fileがserverへuploadされないことも確認する。

## G7 display undo/redo manual test

1. representation、scalar、range、opacity、colormap、camera、VTI/PVD状態を順に変更し、
   **元に戻す** / **やり直す** または`Ctrl/⌘+Z` / `Ctrl/⌘+Shift+Z`で往復することを確認する。
2. undo後に別の表示変更を行い、redo履歴が破棄されることを確認する。ViewState復元は1回のundoで
   復元前の状態へ戻ることを確認する。
3. input/select編集中はbrowser標準undoを優先すること、dataset/project切替後は過去のcameraや
   scalar選択をundoできないことを確認する。

## G8 VTS/VTR browser-direct manual test

1. ascii / inline base64 / raw appended（little-endian、必要に応じzlib）のVTSとVTRをuploadし、
   server変換jobなしで外表面が表示されることを確認する。
2. point/cell scalar、surface/wireframe/points、client geometry export、G1〜G3の対話toolが
   VTS/VTRでも動作することを確認する。
3. unsupported compressor/endianness/encodingを読み込み、偽の表示を作らず既存のserver VTP変換へ
   誘導するerrorになることを確認する。

## G9 vector glyph manual test

1. 3成分のpoint配列（例: `velocity`）を含むVTPまたはVTUを選択し、右上の
   **ベクトル矢印**ツールに配列名が表示されることを確認する。cell配列は直接の対象外で、
   必要な場合はG10の **Cell Data to Point Data** を先に実行する。
2. **ベクトル矢印**を有効にし、矢印が各ベクトル方向を向き、ベクトルの相対的な大きさが
   長さへ反映されることを確認する。配列を変更すると向き・大きさが更新されることを確認する。
3. **矢印倍率**を0.1〜5.0倍で動かし、主形状やcameraを再読み込みせず矢印だけが変わることを
   確認する。標準1.0倍では最大矢印長がモデル対角長のおよそ8%に正規化される。
4. 2,000点を超えるデータでは **矢印数 / 元点数** の左側が2,000以下であること、同じデータを
   再読込しても同じ点が選ばれることを確認する。samplingは全点範囲を等間隔に選ぶ決定的方式。
5. 全ベクトルがゼロまたは非有限値の配列では矢印actorを追加せず、表示可能なベクトルがない旨を
   UIに表示することを確認する。ON/OFF、dataset切替を繰り返して古い矢印やWebGL resourceが
   残らないことも確認する。

## G5 2-up comparison manual test

設計上、vtk.jsの共有render windowは単一canvas/interactorとなり、既存VtkViewerが所有する
widget・orientation marker・DOM overlayをpaneごとに独立させられない。そのため最初のsliceは
各pane 1 contextとし、global leaseを2個にhard limitしている。比較toggleではprimaryを保持し、
secondaryだけを生成・`delete()`・lease解放する。

1. ready状態のVTP/VTUを選び、top barの **比較** を有効にする。左viewerを再読込せず
   右viewerだけが追加され、2画面とも描画されることを確認する。
2. ready状態の別datasetを **右側データセット** で選び、左側のdatasetを変えず右側だけが
   切り替わることを確認する。両datasetに同じscalarがなければ、右側は無効なscalarを
   適用せず単色表示へ安全に戻ることを確認する。
3. PVD collectionを左右に選び、左はPropertiesのtimestep、右は比較barの
   **右側タイムステップ** で別々のstepを指定できることを確認する。
4. **カメラ同期** がONの状態でどちらかをrotate/pan/zoomし、もう一方のcameraが追従する
   ことを確認する。OFFにして右側を操作し、左側cameraが変わらないことも確認する。
5. 比較ON/OFF、右dataset切替を10回以上繰り返す。常にcanvasは単一表示で1個、比較表示で
   2個だけで、3個目のWebGL contextを作らず、context上限messageやcontext lostが出ないことを
   browser developer toolsで確認する。

## G10 server filter manual test（pvpython環境）

1. `PVWEB_PVPYTHON=/path/to/pvpython` を設定してbackendを起動し、
   `GET /capabilities` の `paraview_worker` が `true` であることを確認する。
2. cell scalarを含むdatasetで **Cell Data to Point Data** を実行する。生成VTPを
   datasetへ昇格・ingestし、元の全cell配列に対応するpoint配列が存在することを確認する。
3. **Resample To Image** を `dimensions = [16, 24, 32]` で実行する。生成VTPを
   datasetへ昇格・ingestし、表示できること、およびジョブログが成功で終わることを確認する。
4. PolyDataで **Decimation** を `target_reduction = 0.5` で実行する。生成VTPを
   datasetへ昇格・ingestし、元データよりcell数が減り、形状を表示できることを確認する。
5. `PVWEB_PVPYTHON` を外してbackendを再起動する。UIの実行ボタンが無効になることに加え、
   APIから `cell_to_point` filter jobを作成してもjobが `failed` となり、Artifactが作られず、
   ログに `PVWEB_PVPYTHON` が必要と記録されることを確認する。

## G13 animation/video export manual test（pvpython + ffmpeg環境）

1. 実行可能な絶対パスを指定してbackendを起動する。

   ```bash
   PVWEB_PVPYTHON=/path/to/pvpython \
   PVWEB_FFMPEG=/path/to/ffmpeg \
   PVWEB_AUTH_MODE=dev PVWEB_ALLOW_INSECURE_DEV_AUTH=1 \
     .venv/bin/uvicorn app.main:app
   ```

2. `GET /capabilities` で `paraview_worker=true` と `video_export=true` を確認する。
3. 複数timestepのPVD bundleを選び、**PNG frames (ZIP)** を実行する。Artifactの
   content typeが`application/zip`、ファイル名が`*-movie.zip`で、ZIP内が
   `frame-0000.png`から連番になっていることを確認する。format省略のAPI jobでも
   同じZIPが生成されることを確認する。
4. FPS=24、幅1280、高さ720で **MP4 (H.264)** を実行する。Artifactが
   `*-movie.mp4` / `video/mp4`となり、`ffprobe`でcodec=`h264`、pix_fmt=`yuv420p`
   を確認する。
5. FPS=30で **WebM (VP9)** を実行する。Artifactが`*-movie.webm` / `video/webm`
   となり、`ffprobe`でcodec=`vp9`、pix_fmt=`yuv420p`を確認する。
6. APIで`format=gif`、`format=MP4`、`fps=0`、`fps=121`、小数FPS、16未満または
   4096超の幅・高さを送り、すべて422になることを確認する。
7. `PVWEB_FFMPEG`を外す、存在しないパスにする、実行権限のないファイルにする、の各状態で
   `video_export=false`となり、MP4/WebM jobが`failed`、Artifactなし、ログに
   `PVWEB_FFMPEG`が明記されることを確認する。この状態でもPNG ZIPは成功する。
8. `PVWEB_PVPYTHON`を外した状態ではZIP/MP4/WebMのすべてが`failed`となり、ログに
   `PVWEB_PVPYTHON`が明記されることを確認する。
9. 長い動画jobをcancelし、短い`PVWEB_WORKER_TIMEOUT`でも再実行する。jobがそれぞれ
   `canceled` / `failed`となり、pvpythonとそのffmpeg子processが残らないことを確認する。

## G12 external job queue restart/cancel test

copy/paste時にdev認証や既定credentialをLANへ公開しないよう、検証構成は明示的に
loopbackへbindして起動する。

```bash
PVWEB_AUTH_MODE=dev PVWEB_ALLOW_INSECURE_DEV_AUTH=1 \
PVWEB_WEB_BIND_ADDRESS=127.0.0.1 POSTGRES_BIND_ADDRESS=127.0.0.1 \
MINIO_BIND_ADDRESS=127.0.0.1 \
  docker compose -f infra/docker-compose.yml --profile full-stack up --build -d
```

1. 上記構成で`redis`、`job-worker`、`api`が起動し、`GET /capabilities`の`job_queue`が`rq`に
   なることを確認する。
2. 大きなdatasetのingestまたは長時間filter jobを作成し、statusが`queued`または`running`の間に
   `docker compose -f infra/docker-compose.yml restart api`を実行する。API復帰後もjobが
   `failed`へ強制遷移せず、同じjob idで`running`からterminal stateへ進むことを確認する。
3. job実行中に`POST /jobs/{job_id}/cancel`を送り、APIとは別processのworkerがDB上の
   cancel状態を検出すること、jobが`canceled`になり、途中Artifact/objectが残らないことを確認する。
4. `job-worker`を停止した状態でjobを作成するとRedisにqueuedのまま残り、worker再起動後に
   実行されることを確認する。Redisも停止した場合はjob作成APIが503となり、DB jobが
   `failed`（偽のqueued/succeededではない）になることを確認する。
5. local fallbackは`PVWEB_JOB_QUEUE_BACKEND=local`で起動し、API再起動前のactive jobが従来通り
   `failed`と`retry required`ログへ遷移することを確認する。
6. object storeを一時的に停止してproject/jobを削除し、DB transactionは成功して削除対象が
   `object_deletion_outbox`へ残ることを確認する。object store復帰後、APIの周期drainまたはworkerの
   startup drainで対象objectとoutbox rowが削除されることを確認する。

## G14 repository maintenance verification

1. READMEのcoverage commandを実行し、`backend/coverage/coverage.xml`、
   `backend/coverage/html/`、`frontend/coverage/`が生成されることを確認する。
2. CIのbackend/frontend jobでcoverage artifactがuploadされることを確認する。
3. `.github/dependabot.yml`がpip、npm、GitHub Actions、Docker Composeを週次対象にしていることを
   確認する。脆弱性PRが必要な場合はrepository settingsでDependabot alerts/security updatesも
   有効化する。
4. LICENSEは利用者がライセンス種別を選択するまで未完了とする。選択前にMIT/Apache-2.0等を
   推測して追加せず、READMEの「未指定」と実体を一致させる。

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
