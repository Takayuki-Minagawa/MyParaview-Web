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
