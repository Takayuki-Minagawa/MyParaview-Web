# 追加機能17件の実装状態

`additional_feature_candidates.md`の候補を、2026-07-10時点の実装へ対応付けた一覧です。

| # | 候補 | 状態 | 実装/境界 |
|---:|---|---|---|
| 1 | 凡例・range・opacity・colormap | 完了 | HTML legend、PNG合成、3map、manual/auto range |
| 2 | cell array着色 | 完了 | point/cell associationを同名でも識別 |
| 3 | job一覧・cancel UI | 完了 | progress/log/terminal merge、cancel race対策 |
| 4 | view操作改善 | 完了 | ResizeObserver、axes、front/side/top/isometric、panel折りたたみ |
| 5 | Pipeline browser/ViewState | 完了 | camera、表示、CSV/VTI/PVD stateを保存復元、deep link対応 |
| 6 | CSV Table-to-Points | 完了 | BOM/quoted CSV、XYZ検証、疎な数値列のNaN保持、小規模glyph/大規模vertex、250k cap |
| 7 | VTI slice/volume | 完了 | whole extent clamp、1成分point scalar限定、orthogonal slice、volume opacity/constant range対策 |
| 8 | PVD time slider | 完了 | multi-file manifest、step API、load-complete駆動playback、ZIP export |
| 9 | Artifact付きjob | 完了 | export、screenshot、worker convert/filter VTP。未設定workerは明示失敗 |
| 10 | trame server rendering | 接続契約完了 | broker create/delete、host allowlist、TTL、WS proxy。外部trame serviceが必要 |
| 11 | Slice/Clip/Contour/Threshold | 接続契約完了 | schema/metadata照合、cancel worker、surface VTP Artifact。pvpythonが必要 |
| 12 | CGNS/Exodus/EnSight/XDMF | 接続契約完了 | magic check、bundle closure、ParaView reader/surface変換。pvpythonが必要 |
| 13 | PostgreSQL/Alembic/S3/MinIO | 完了 | migration 0001–0010、legacy adoption、Postgres実migration、atomic・有界・lease保護S3 cache、永続object削除outbox、Compose |
| 14 | OIDC/RBAC/audit | 完了 | default fail-closed、Code+PKCE、RS256 validation、legacy bootstrap、member UI、viewer/editor/admin、mutation/download audit |
| 15 | WebGPU/WASM | 検証スライス完了 | browser feature detectionを表示。描画は意図的にvtk.js WebGL fallback |
| 16 | Jupyter/Python | 完了 | dependency-free deep-link client、dataset/pipeline復元、OIDC returnTo |
| 17 | AI操作assistant | 安全な最小スライス完了 | metadata基準の決定的proposal、差分確認、非自動実行、stale request防止 |

「接続契約完了」は、外部native/runtimeをrepositoryに同梱したという意味ではありません。
capabilityを設定した環境で実処理へ接続し、未設定時は誤成功させないAPI/UI境界が完成した状態です。

## 2026-07-10 レビュー是正での追加

コードレビュー全指摘への対応として、上記17件に加えて次を実装しました。

- リファクタリング: 監査ミドルウェアのthreadpool化、アップロード系ブロッキングI/O解消、
  ingest重複ガード、アップロード3endpoint共通化、`run_dataset_operation`分割、
  App.tsx/PropertiesPanelのフック・セクション分割、VtkViewerのScene型付けと依存配列修正、
  MessagesContext、i18nカタログ完全化、エラーバナー多重化+ErrorBoundary
- 追加機能: メンバー削除、監査ログUI+CSV export、一覧フィルタ/ページング、S3 presigned
  download、Artifact→Dataset昇格、統計JSONジョブ、サーバrender/movieジョブ、
  Pipelineフィルタ連鎖のサーバ実行、assist提案の永続化+apply/dismiss、ジョブSSE、
  共有リンク、Pipelineリネーム、VTP変換UI、colormap 2種追加、6方向カメラプリセット、
  axes/背景トグル、timestep単体download、CSVスキップ行表示、Volume TFエディタ、
  クライアントジオメトリexport、trameリモートビューアUI
- テスト: バックエンド129件（+40件追加）、フロントエンドunit+コンポーネントテスト
  （jsdom/testing-library基盤を導入）

### 第2ラウンド（レビュー再指摘の是正）

PRレビューで指摘された「現行テストで検出されない回帰・境界条件」への対応です。

- フロントエンドP1: `useProjectScope`/`useDisplayState`が毎レンダーで新オブジェクトを
  返し、リソース取得・ジョブポーリングの各effectが自走リフェッチループ化する問題を
  useMemoで是正（`mergeJobSnapshots`も内容不変時に同一参照を返すよう変更）。
  アップロード完了時の自動選択がユーザーの選択を奪う回帰、再生タイマーが無関係な
  再レンダーでリセットされる回帰、ErrorBoundaryが一度のクラッシュ後に復帰不能となる
  問題（`resetKey`導入）、監査ログがプロジェクト切替後も前プロジェクトの内容を
  表示し続ける問題を修正。
- フロントエンドP2: Volume不透明度制御点をViewStateとして保存/復元、データセット
  切替時のリモートセッション停止、昇格後ingest失敗の通知、等値の制御点で伝達関数の
  端点が消える問題、リモートフレームURLのrevokeレース+セッション終了表示、
  アシスタント適用ボタンの二重送信ガード、レンジ入力のaria/検証不整合を修正。
- バックエンドP2: `/jobs/stream` のカーソルが同一`updated_at`の更新を取りこぼす
  問題（`>=`+送信済み(タイムスタンプ,ID)フィルタへ変更）と、接続中ずっと
  リクエストスコープのDBセッションを占有する問題、Artifact昇格がアップロード時の
  マジックチェックを迂回できる問題、presignedリダイレクトがオブジェクト存在確認
  なしにS3の生404へ誘導しうる問題を修正。
- テスト: バックエンド132件、フロントエンド84件に増加（SSEカーソル、promote sniff、
  presignedガード、フック安定性、ErrorBoundary復帰、ViewState往復などを追加）。
