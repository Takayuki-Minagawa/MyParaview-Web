# 表示状態の undo / redo（G7）

`useDisplayState` は、保存済み `ViewState` と同じ表示パラメータを undo / redo
履歴として管理する。右プロパティパネルの「元に戻す / やり直す」、または次の
ショートカットから操作できる。

- undo: `Ctrl+Z` / `⌘Z`
- redo: `Ctrl+Shift+Z` / `⌘⇧Z` / `Ctrl+Y`

入力欄、テキストエリア、セレクト、contenteditable にフォーカスがある場合は、
ブラウザ標準の編集履歴を優先し、表示状態のショートカットは実行しない。

## 履歴の契約

- 最大 50 snapshot の bounded stack とし、長時間操作しても無制限に増えない。
- 値が等しい更新は JSON 値で dedupe し、空の undo step を作らない。
- undo 後に新しい表示変更を行うと redo stack を破棄する。
- Pipeline / View State の復元は全フィールドを 1 transaction として適用するため、
  1 回の undo で復元前の状態へ戻る。
- データセット選択、プロジェクト切替、アップロード完了で呼ばれる `reset()` は
  hard boundary であり、過去・未来の両 stack を消去する。別データセットの camera
  や array 選択を誤って復元しない。

履歴対象は representation、scalar 選択と手動 range、opacity、colormap、legend、
camera、Table 座標、ImageData mode / slice、timestep、volume opacity points である。
自動計算される runtime color range、再生中フラグ、データセットを跨いで維持する
orientation axes 表示は保存済み `ViewState` と同様に履歴対象外とする。undo / redo と
ViewState 復元時は再生を停止し、runtime range を再計算する。

回帰テストは履歴の往復、redo branch、no-op dedupe、50件上限、reset boundary、
ViewState の atomic 復元、キーボード操作と入力欄保護を固定している。
