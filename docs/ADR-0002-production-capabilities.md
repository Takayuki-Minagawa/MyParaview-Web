# ADR-0002: Optional production capabilities and trust boundaries

Status: Accepted · Date: 2026-07-10

## Decision

ローカルMVPを維持しながら、database/storage/auth/native renderingを環境変数で切り替える。

- Database: SQLiteまたはPostgreSQL、schema変更はAlembicのみ。
- Object storage: local filesystemまたはS3互換。object keyはopaque/immutable。
- Authentication: OIDC 3設定をall-or-nothingで有効化し、Project roleで全resourceを認可。
- Native processing: pvpythonを別process groupで起動し、timeout/cancelで子孫も停止。
- Interactive rendering: 信頼するbroker hostだけを許可し、期限付きcapability subprotocolでproxy。
- Assistant: proposalとexecutionを分離し、clientで差分確認後に既存の認可済APIを呼ぶ。

## Consequences

- ParaView/trame/GPUが無いCIとlocal環境でも、browser-direct機能と契約検証を実行できる。
- 外部capabilityが無い処理は明示失敗し、擬似Artifactや偽の成功状態を作らない。
- worker/broker運用者はcontainer isolation、resource quota、network policy、監視を追加する必要がある。
