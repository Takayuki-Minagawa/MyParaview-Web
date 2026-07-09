# 追加機能17件の実装状態

`additional_feature_candidates.md`の候補を、2026-07-10時点の実装へ対応付けた一覧です。

| # | 候補 | 状態 | 実装/境界 |
|---:|---|---|---|
| 1 | 凡例・range・opacity・colormap | 完了 | HTML legend、PNG合成、3map、manual/auto range |
| 2 | cell array着色 | 完了 | point/cell associationを同名でも識別 |
| 3 | job一覧・cancel UI | 完了 | progress/log/terminal merge、cancel race対策 |
| 4 | view操作改善 | 完了 | ResizeObserver、axes、front/side/top/isometric、panel折りたたみ |
| 5 | Pipeline browser/ViewState | 完了 | camera、表示、CSV/VTI/PVD stateを保存復元、deep link対応 |
| 6 | CSV Table-to-Points | 完了 | BOM/quoted CSV、XYZ検証、小規模glyph/大規模vertex、250k cap |
| 7 | VTI slice/volume | 完了 | whole extent対応orthogonal slice、volume opacity/constant range対策 |
| 8 | PVD time slider | 完了 | multi-file manifest、step API、load-complete駆動playback、ZIP export |
| 9 | Artifact付きjob | 完了 | export、screenshot、worker convert/filter VTP。未設定workerは明示失敗 |
| 10 | trame server rendering | 接続契約完了 | broker create/delete、host allowlist、TTL、WS proxy。外部trame serviceが必要 |
| 11 | Slice/Clip/Contour/Threshold | 接続契約完了 | schema/metadata照合、cancel worker、surface VTP Artifact。pvpythonが必要 |
| 12 | CGNS/Exodus/EnSight/XDMF | 接続契約完了 | magic check、bundle closure、ParaView reader/surface変換。pvpythonが必要 |
| 13 | PostgreSQL/Alembic/S3/MinIO | 完了 | migration 0001–0005、legacy adoption、Postgres offline SQL、S3 cache、Compose |
| 14 | OIDC/RBAC/audit | 完了 | Code+PKCE、RS256 validation、viewer/editor/admin、mutation/download audit |
| 15 | WebGPU/WASM | 検証スライス完了 | browser feature detectionを表示。描画は意図的にvtk.js WebGL fallback |
| 16 | Jupyter/Python | 完了 | dependency-free deep-link client、dataset/pipeline復元、OIDC returnTo |
| 17 | AI操作assistant | 安全な最小スライス完了 | metadata基準の決定的proposal、差分確認、非自動実行、stale request防止 |

「接続契約完了」は、外部native/runtimeをrepositoryに同梱したという意味ではありません。
capabilityを設定した環境で実処理へ接続し、未設定時は誤成功させないAPI/UI境界が完成した状態です。
