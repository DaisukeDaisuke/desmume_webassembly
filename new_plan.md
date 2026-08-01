再レビューの結果、現状は修正必須です。自己呼び出し対策は「フック登録済みの呼び出し元スクリプト」だけを拒否するため経路依存で抜ける一方、フック外の正当な呼び出しまで常時拒否しています。また、保存フックとNative State、復元前検証とState loadの境界が原子的ではありません。

# Codex指示書：永続スクリプトのベースライン保存・復元とエラー行伝達の再レビューおよび修正

## 目的

新規実装された永続スクリプトのベースライン保存・復元とユーザーソース行伝達を、過去にレビュー済みであることを理由に省略せず、実装全体から再レビューして修正する。
サンドボックス突破、攻撃手段、プロトタイプ汚染などのセキュリティ評価は今回の対象外とする。通常のAPI利用で発生する再入、循環待機、競合、部分復元、誤った実行順序、誤ったエラー位置だけを扱う。

## 結論

現状のままではマージ不可。少なくとも以下のP0とP1を修正し、回帰テストを追加すること。

## P0-1：ベースライン操作の再入防止をグローバル化する

対象：

* `src/commands/context-commands.js`
* `src/script-service.js`
* `src/commands/script-commands.js`
* 必要なら`src/command-dispatcher.js`
  現在の対策は、`queuePersistentScriptOperation()`で呼び出し元スクリプト自身がベースラインフックを登録している場合だけ、`saveAnalysisBaseline`と`restoreAnalysisBaseline`を拒否している。
  この方式には次の問題がある。
* ベースライン操作中であることではなく、呼び出し元スクリプトの登録状態を見ている。
* 合成コマンド、別スクリプトのMCP、将来追加されるラッパーを経由すると同じ判定を維持できない。
* 同名ベースラインへの再入は`withAnalysisBaselineLock()`の待機に入り、外側が内側の完了を待つ循環待機になる。
* 別名ベースラインなら名前別ロックが働かず、操作が入れ子になる。
* フック実行中でなくても、フックを登録したスクリプトからの正当なベースライン操作を常時拒否している。
  修正方針：
* 名前別ロックとは別に、ランタイム全体で一つのベースライン操作状態を導入する。
* 状態には最低でも`operationId`、`name`、`phase`、`save|restore`を保持する。
* ベースライン操作中に別の`saveAnalysisBaseline`または`restoreAnalysisBaseline`が要求された場合、待機させず即座に`BUSY`を返す。
* 判定は最外層のコマンド名だけでなく、実際の`saveAnalysisBaseline`、`restoreAnalysisBaseline`実装入口で必ず行う。
* `batch`などの合成コマンドから呼ばれても同じ入口で拒否される構造にする。
* 現在の「フック登録済みスクリプトからは常時拒否する」判定は削除する。拒否条件はフック登録の有無ではなく、実際にベースライン操作が進行中かどうかにする。
* 全MCPを拒否してはならない。ベースライン操作そのものと、後述するフェーズ別禁止コマンドだけを拒否する。

## P0-2：ベースライン保存を原子的な停止境界内で行う

対象：

* `src/commands/context-commands.js:185-255`
  現在は次の順序になっている。

1. `activity`を取得する。
2. 非同期の保存フックを順番に実行する。
3. `native.saveStateBytes()`を呼ぶ。
   保存フックの待機中もエミュレーターが実行可能であり、保存フックから状態変更コマンドも呼べる。このため、記録した`paused/running`、永続スクリプトのJSON、Native State、PC/CPSRが異なる時点の状態になる。
   修正方針：

* 保存開始時に元の`paused/running`を記録する。
* 最初の保存フックを呼ぶ前にエミュレーターを停止する。
* フレーム実行、進行中のデバッガー操作、入力タスク、State loadなどと競合しない専用のベースライン境界を作る。
* 停止後に参加スクリプトを固定し、保存フック、Native State、PC/CPSR、ROM identityを同じ停止境界内で取得する。
* 成功時と失敗時の両方で、保存開始前の実行状態へ戻す。
* 保存中にROM generation、参加スクリプト、script instanceが変化した場合は保存をコミットしない。
* `saveAnalysisBaseline`を通常のアクティビティ競合判定から漏らさない。

## P0-3：復元前検証をファイルトランザクションのcommit後に行う

対象：

* `src/commands/context-commands.js:257-345`
* `src/commands/state-commands.js:61-108`
* `src/file-transaction-service.js:30-49`
  現在は永続スクリプトを検証した後、`loadState`内部の`commit()`が保留中のスクリプトイベントをキャンセルする。このキャンセル処理によって、検証済みの参加スクリプトが停止する可能性がある。その後Native Stateを読み込んでから復元フックが見つからず失敗すると、Native Stateだけが復元された部分復元になる。
  修正方針：
* 外側の`fileTransactionService.run()`から`commit`も受け取る。
* 保留イベントと入力タスクのキャンセルを先に完了する。
* キャンセル完了後の安定した参加スクリプト集合を検証する。
* 検証結果として得た復元計画を一度だけ生成し、Native State load後も同じ計画を使用する。
* 現在のように、load前の`validateAnalysisBaselineScriptState()`とload後の`restoreAnalysisBaselineScriptState()`で参加スクリプトを再検索してはならない。
* 計画には`script`参照、`scriptId`、`scriptInstanceId`、名前、source SHA-256、保存値を保持する。
* Native Stateを読み込む直前にも、固定したinstanceがまだ有効であることだけを確認する。

## P0-4：部分復元を通常の失敗として隠さない

Native State load後に次の処理が失敗する可能性がある。

* PC/CPSR検証
* 一つ目以降の復元フック
* trace/IRQ方針の適用
* 最終的なpause/resume
  現在は通常の例外として返るため、呼び出し側から「何も復元されなかった」のか「途中まで復元された」のか判別できない。
  修正方針：
* Native State適用後の失敗は専用の安定したエラーコードで返す。例：`STATE_PARTIALLY_RESTORED`。
* エラー詳細に、Native State適用済みか、復元済みスクリプト、未復元スクリプト、失敗したスクリプト、現在のpause状態を含める。
* 部分復元時は必ずエミュレーターを停止状態に保つ。
* 復元失敗後に記録済みのrunning状態へ自動復帰してはならない。
* 完全なロールバックを実装しない場合でも、部分復元であることを明示してfail closedにする。

## P1-1：保存フックと復元フックにフェーズ別許可リストを設ける

全MCP拒否にはしない。
保存フック：

* 原則として読み取り専用コマンドだけを許可する。
* status、register read、memory read、一覧取得など、エミュレーター状態を進めず変更しないものだけを明示的に列挙する。
* State保存・読込、ベースライン操作、resume、step、入力、memory write、register write、ROM操作、スクリプト開始・停止・再起動、MCP間呼び出しを禁止する。
  復元フック：
* 読み取り専用コマンドに加え、Native Stateを進めない少数の実行方針変更だけを許可できるようにする。
* 少なくとも、復元後に速度を4倍へ設定する正当な利用を壊さないこと。
* `setSpeed`のような許可された副作用は、その場で適用せず、全復元フック成功後に適用する遅延効果として扱うのが望ましい。
* 復元フック中はfile transactionが有効なので、現在の`FILE_TRANSACTION_ALLOWED_COMMANDS`では`setSpeed`が拒否される。この既存の非対称動作を修正する。
* `batch`を許可する場合は、内部コマンドをすべて再帰的に検査する。検査できない場合はフック中の`batch`を禁止する。
* `callPScriptMcp`は同一Worker待ちや別Workerを含む循環を作れるため、ベースラインフック中は許可しない。

## P1-2：フックの1500ms期限をキュー待機時間から分離する

対象：

* `src/script-service.js:289-336`
  現在はフックを`eventQueue`へ追加する前からタイマーを開始している。先行イベントやblocking MCPが実行中の場合、保存・復元コールバックが開始される前にTIMEOUTになる。
  修正方針：
* 1500msはコールバックの実行開始後から計測する。
* Workerから`baselineHookStarted`を返してからタイマーを開始するか、参加スクリプトを事前にquiescent状態へ移してから呼び出す。
* キュー待機用の期限が必要なら、コールバック実行期限とは別のエラーと時間を設ける。
* 既に実行中のnon-blocking MCPがある参加スクリプトでは、完了を待つか`BUSY`で保存・復元を開始しない。
* フック実行中は、その参加スクリプトへの新しいnon-blocking MCPを拒否または遅延する。

## P1-3：`stateLoad`イベントを永続スクリプト復元後まで遅延する

現在の`loadState`はNative State適用直後に`stateLoad`イベントをdispatchし、その後でベースライン復元フックが呼ばれる。
この順序では、`emu_onstateload`が古いJavaScript closure stateを観測する。また、そのイベントが長時間動作すると復元フックが後ろで待たされ、現在のタイムアウト実装では開始前TIMEOUTになる。
修正方針：

* ベースライン内部からの`loadState`では、通常の`stateLoad` dispatchを抑止または保留する内部メタデータを追加する。
* Native State load、永続スクリプト復元、許可された遅延効果、trace/IRQ方針の適用が完了した後に、一度だけ`stateLoad`をdispatchする。
* `stateLoad` callbackは復元済みのclosure stateを必ず観測する。

## P1-4：参加スクリプトのidentityを一意かつ固定する

対象：

* `captureAnalysisBaselineScriptState()`
* `prepareAnalysisBaselineScriptState()`
  現在は名前で最初のスクリプトを検索しているが、スクリプト名は一意ではない。同名スクリプトが複数あると、保存時には重複entryを生成できるのに、復元時になって初めて重複名として失敗する。また、一つ目の同名スクリプトが不一致でも、後ろに正しいスクリプトが存在する可能性を確認していない。
  修正方針：
* 保存開始時点の参加スクリプトを固定配列へコピーする。await中のMap iteratorをそのまま使用しない。
* ベースライン参加スクリプト名をidentityとして使い続けるなら、保存時点で名前の一意性を検証し、重複時はNative Stateを保存する前に`STATE_INVALID`を返す。
* 保存時に成功したidentityが復元時にちょうど一つだけ見つかることを確認する。
* 保存中と復元中は、対象スクリプトの停止、再起動、同名差し替え、遅延したbaseline registrationを禁止または検出する。
* `started`だけを準備完了条件にしない。現在はユーザーのトップレベル関数を実行する前に`started`が送られるため、baseline registration後もトップレベル初期化が継続している可能性がある。ユーザーのトップレベル処理完了を示す専用フラグ、またはMCP publication完了を参加条件にする。

## P1-5：保存済み参加者と現在の参加者の差を黙って無視しない

現在は保存entryに存在するスクリプトだけを検証し、ベースライン保存後に追加されたbaseline hook付きスクリプトは変更せず復元を成功させる。
これは現在の文書上は仕様化されているが、エミュレーターだけ過去へ戻り、追加スクリプトのclosure stateだけ未来のまま残る。
修正方針：

* デフォルトでは、保存済み参加者集合と現在のbaseline hook参加者集合が一致することを要求する。
* 緩い復元を残す必要がある場合は、明示的なオプションまたはバージョン付きポリシーにする。
* 少なくとも、追加参加者を黙って無視して完全復元成功として返してはならない。

## P1-6：エラー行伝達を全経路で完成させる

対象：

* `src/worker-error-summary.js`
* `src/workers/parser.worker.js`
* `src/workers/persistent-script.worker.js`
* `src/script-service.js`
  現状で確認できる不足：

1. Acornの構文エラー
   `serializeWorkerError()`はstack内のsourceURLだけを検索している。Acornの構文エラーが持つ`loc.line`と`loc.column`を読んでいないため、compile errorでは行番号が欠落する可能性が高い。
   修正：

* parser WorkerでAcorn errorの`loc`を明示的に読み取る。
* parserはユーザーコードの前にラッパーを1行追加しているため、ユーザー行へ正しく補正する。
* columnの0始まりと1始まりを統一する。
* `sourceName`と`sourceExcerpt`を必ず設定する。

2. 通常イベントcallbackのエラー
   `callbackErrorMessage()`は`serializeWorkerError()`でlineやsourceExcerptを生成しているが、返却文字列へ含めていない。現在の実装では計算した位置情報が破棄される。
   修正：

* callback errorの構造化結果に`line`、`column`、`sourceName`、`sourceExcerpt`を保持する。
* 文字列ログだけに埋め込まず、main側が構造として取得できる形式を優先する。

3. `await mcp.call()`失敗時の呼び出し位置
   RPC失敗時のErrorはWorker reply handler内で新しく生成されるため、stackがユーザーの`await mcp.call()`行ではなく内部実装を指す。
   修正：

* `ask()`または`mcp.call()`開始時にユーザー側call-site stackを保存する。
* RPC失敗時は保存したcall-siteを使用してline/columnを生成する。
* mainから受け取ったerror code/detailsは失わない。

4. テスト不足
   現在の追加テストはトップレベルruntime throwだけであり、機能全体の行伝達を保証していない。

## P2-1：2MiBのスクリプトJSONをlocalStorage metadataへ直接保存しない

対象：

* `src/debugger-service.js:164-180`
* `src/resource-limits.js`
  現在は最大2MiBの`persistentScripts`をbaseline metadataへ入れ、`JSON.stringify()`してlocalStorageへ保存する。ベースラインを複数保存できるAPIであり、設定した上限と保存先の性質が一致していない。
  修正方針：
* Native Stateと同様、永続スクリプトJSONもIndexedDBへ保存する。
* localStorageには小さいmanifest、IDB key、hash、sizeだけを保存する。
* State bytesとscript JSONの両方をtemporary keyへ書き、manifest切り替え後に旧データを削除する。
* 既存baselineとの互換性を維持するため、metadata versionとmigrationを追加する。

## P2-2：baseline名を入口で検証し、Worker側で黙って切り詰めない

現在はbaseline名に長さ制限がなく、Supervisorでのみ256文字へ切り詰められる。このため、保存キーの名前とcallbackが受け取る名前が異なる。
修正方針：

* `saveAnalysisBaseline`、`restoreAnalysisBaseline`、`deleteAnalysisBaseline`の共通入口で名前を検証する。
* 最大長を256文字以下へ統一する。
* 不正または長すぎる名前は`INVALID_ARGUMENT`にし、内部で黙ってsliceしない。

## 必須回帰テスト

次のテストを追加すること。

* ベースライン操作中の再度のsave/restoreが、名前の同異にかかわらず即座に`BUSY`となり、TIMEOUTや待機状態にならない。
* 合成コマンドや別スクリプト処理を経由しても、同じグローバル再入判定が働く。
* フック登録済みスクリプトでも、ベースライン操作外からの通常のsave/restoreは不必要に拒否されない。
* 異なる名前のsave同士、saveとrestore、restore同士が同時にNative Stateまたはbaseline hookへ入らない。
* running中に保存しても、保存フックJSON、PC/CPSR、Native Stateが同一停止境界の値になる。
* file transaction commitで参加スクリプトが停止した場合、Native State load前に`STATE_INVALID`となる。
* `stateLoad` callbackがbaseline restore callbackの後に実行され、復元済みclosure stateを観測する。
* 先行イベントのキュー待機時間が1500msのcallback実行期限へ算入されない。
* baseline hook実行中にnon-blocking MCPが同じclosure stateへ並行実行されない。
* restore hookから許可された速度変更を要求すると、全フック成功後にspeed 4が反映される。
* restore hookからState load/save、baseline操作、実行進行、書込み、script MCP呼び出しが拒否される。
* `batch`内部の禁止コマンドを見逃さない。
* 同名のbaseline参加スクリプトが複数ある場合、保存段階で失敗する。
* 検証後にscript instanceが交換された場合、Native State load前に失敗する。
* Native State load後の二つ目のrestore hook失敗が、部分復元専用エラー、停止状態、適用済み一覧を返す。
* Acorn compile errorが正しいユーザー行とexcerptを返す。
* top-level runtime、tick/stateLoad/memory callback、persistent MCP handler、baseline save hook、baseline restore hookのthrowが正しいユーザー行を返す。
* `await mcp.call()`の失敗が内部reply handlerではなくユーザーの呼出行を返す。
* baseline名の上限を超えた場合に切り詰めず拒否する。
* 大きなpersistent script JSONを複数baselineへ保存・復元してもlocalStorage容量へ依存しない。

## 検証条件

* 過去レビュー済みという理由で既存コードや既存テストをスキップしない。
* 新規テストだけを通して終了せず、全テストを実行する。
* 現在のローカル実行では`esbuild`未配置により`boundary-regressions.test.mjs`と`merge-blockers.test.mjs`が起動できていない。残りは72件成功しているが、これは全テスト成功ではない。
* 依存が揃った環境またはGitHub Actionsで、起動できなかった2スイートを含む全テスト結果を確認する。
* テスト失敗を既存不具合扱いで除外しない。

## 完了条件

* ベースライン操作の循環が経路に依存せず即時拒否される。
* 保存は停止した一つの整合した時点を保存する。
* 復元前検証後に参加スクリプトが入れ替わらない。
* `stateLoad`は永続スクリプト復元後に通知される。
* restore hookで速度変更など明示的に許可した副作用だけを安全に適用できる。
* 復元途中の失敗が部分復元として明示され、エミュレーターが停止する。
* compile、runtime、callback、MCP、baseline hookのすべてでユーザーソース行が伝達される。
* 全テストが成功する。
