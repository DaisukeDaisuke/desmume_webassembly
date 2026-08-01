# Codex追加修正指示：永続スクリプトのベースライン保存・復元再レビュー

## 目的

Lunaによる修正後の実装を再レビューした結果、残っている通常利用上の不整合を修正する。
過去にレビュー済みであることを理由にスキップしてはならない。
サンドボックス境界、攻撃手段、プロトタイプ汚染は今回の対象外とする。

## 判定

前回指摘した次の事項は概ね実装されている。

* ベースライン操作のグローバル再入防止
* コールバック開始後からの1500ms期限計測
* 保存済み参加者と現在参加者の一致確認
* 固定したscript instanceによる復元計画
* 復元時の速度、描画、音声などの遅延適用
* Native State適用後の部分復元エラー
* Acorn構文エラーとcallback errorの行情報生成
  ただし、原子的な保存・復元を破るP0が残っているため、現状のままではマージ不可。

## P0-1：ベースラインフック完了後に通常イベントキューを再開してはならない

対象：

* `src/script-service.js`
* `src/workers/persistent-script.worker.js`
* 必要なら`src/workers/persistent-script-supervisor.worker.js`
  現在の`finishBaselineHookCall()`は、フック結果を受信すると次の処理を行っている。

```js
script.eventBusy = false;
pumpScriptEvents(script);
```

この処理はpending Promiseをresolveまたはrejectするより前に実行される。
そのため、次の不整合が発生する。

* save hookがclosure stateをJSONへ変換した直後に、キュー内のtickや通常イベントがclosure stateを変更できる。
* そのイベントはNative State取得より前に実行される可能性がある。
* 複数スクリプトの保存中、一つ目のスクリプトだけ保存後の状態へ進み、二つ目は保存前の状態を保持できる。
* restore hookが一つ完了した直後に通常イベントが実行され、残りのスクリプトが未復元の状態を観測できる。
* 復元用の遅延効果が適用される前に通常イベントが実行される。
  修正方針：
* ベースライン操作専用の排他的なbarrierを導入する。
* barrierは各scriptについて、少なくとも`operationId`、`save|restore`、`active`を保持する。
* barrier取得後は通常のevent、blocking MCP、non-blocking MCPを新たに開始しない。
* 既に実行中の通常処理がある場合は、開始前にboundedな完了待ちを行うか、ベースライン操作を`BUSY`で失敗させる。
* 通常イベントは破棄せず、barrier解除後までキュー内に保持してよい。
* baseline hookだけを排他的な内部処理として開始する。
* `finishBaselineHookCall()`は結果Promiseをsettleしても、barrier有効中は`pumpScriptEvents()`を呼ばない。
* saveでは、全hook、Native State、CPU state、script JSON、manifestのcommitが完了するまでbarrierを解除しない。
* restoreでは、全hook、遅延効果、CPU検証、trace設定が完了するまでbarrierを解除しない。
* 失敗時もエミュレーターをpauseした後にbarrierを解除する。
* 全MCPを無条件拒否してはならない。baseline hook自身が行う許可済み読み取りコマンドは引き続き使用可能にする。

## P0-2：タイマーcallbackもベースラインbarrierへ統合する

永続スクリプトへ公開されている`setTimeout`と`setInterval`は、現在の共通work queueを経由せずcallbackを実行できる。
通常イベントだけを停止しても、タイマーcallbackがclosure stateを変更すれば保存JSONと実際のclosure stateが一致しない。
修正方針：

* 永続スクリプトへ公開するtimerを管理対象のwrapperへ変更する。
* timer満了時にcallbackを直接実行せず、永続スクリプトの共通work queueへ投入する。
* baseline barrier中に満了したtimerは、barrier解除後まで実行しない。
* intervalはbarrier中の満了回数を無制限に蓄積しない。少なくとも一回へcoalesceするか、既存の明示的な上限を設ける。
* timer callbackもイベント、blocking MCP、baseline hookと同じ直列化契約へ含める。

## P0-3：部分復元の例外境界をNative State適用前まで広げる

対象：

* `src/commands/context-commands.js`
* `src/commands/state-commands.js`
  現在の部分復元用`try`は、次の処理より後から始まっている。
* `await call("loadState", ...)`
* `native.pause(true)`
* `getRegisters("arm9")`
* `getRegisters("arm7")`
  `loadState`内部ではNative State適用後にも、trace同期、frame描画、状態更新などが失敗する可能性がある。
  この区間で失敗するとNative Stateは既に変更されているのに、通常の`NATIVE_ERROR`または別のエラーとして返り、`STATE_PARTIALLY_RESTORED`にならない。
  修正方針：
* Native State適用処理を含む外側全体を`try`へ入れる。
* `nativeStateApplied`を明示的なbooleanとして管理する。
* `loadState`内部でNative State適用後に失敗した場合も、呼び出し元が適用済みと判定できるdetailsを付ける。
* Native State適用前の検証失敗は元の`STATE_INVALID`などを維持する。
* Native State適用後のpause、レジスタ取得、PC/CPSR検証、hook復元、遅延効果、trace設定、最終状態適用のいずれかが失敗した場合は`STATE_PARTIALLY_RESTORED`へ変換する。
* 部分復元時は必ずpauseを維持する。
* `remainingScripts`と`restoredScripts`を正確に返す。

## P1-1：`stateLoad`イベントをベースライン操作解放後に通知する

現在の`dispatchScriptEvent("stateLoad", ...)`は次の状態で実行される。

* `state.fileTransactionActive === true`
* `state.analysisBaselineOperation !== null`
* baseline barrierが今後追加される場合はbarrierも有効
  この状態でstateLoad callbackがMCPを呼ぶと、正常なコマンドまで`BUSY`または`COMMAND_NOT_ALLOWED`になる可能性がある。
  修正方針：
* Native State load内部のstateLoad通知抑止は維持する。
* restore処理本体ではstateLoadをdispatchせず、通知予定のpayloadだけを保持する。
* `fileTransactionService.run()`が終了した後に通知する。
* `withBaselineOperation()`が`analysisBaselineOperation`を解除した後に通知する。
* 全scriptのbaseline barrierを解除した後に通知する。
* 一回のrestoreにつきstateLoadは一度だけ通知する。
* stateLoad callbackから通常許可されるコマンドを呼んでも、ベースライン操作中という理由で拒否されないことを確認する。

## P1-2：baseline hookの許可リストから待機コマンドを除外する

現在の`BASELINE_HOOK_READ_ONLY_COMMANDS`には次が含まれている。

* `waitForFileTransaction`
* `waitForStateLoad`
  これらは読み取りコマンドではない。
  `waitForFileTransaction`の既定動作は現在のfile transactionが終了するまで待つため、hookが終了を待ち、file transactionはhook終了を待つ循環待機になる。
  `waitForStateLoad`も、save hook内や現在serial以降を指定したrestore hook内では、ベースライン処理完了後にしか成立しない待機になる。
  修正方針：
* 両コマンドをbaseline hook許可リストから除外する。
* hook内から呼ばれた場合は待機を開始せず、即座に`COMMAND_NOT_ALLOWED`を返す。
* timeoutによって偶然終了させる設計にしてはならない。
* 厳密な読み取り専用リストとして再確認する。
* `resetMemorySearch`は検索状態を変更するため除外する。
* `copyCallStackMarkdown`と`copyCallStackCsv`はclipboardへ副作用を持つため、hook内で必要性がなければ除外する。
* `searchMemory`の検索candidate状態を後続呼び出しが利用する設計なら、純粋な読み取りとして扱わず除外または専用の非保存検索へ分離する。

## P1-3：遅延復元効果をbaseline hook由来の要求だけに限定する

現在は`analysisBaselineOperation.phase === "restore-hooks"`であれば、呼び出し元を確認せず次のコマンドを`deferredEffects`へ追加する。

* `setSpeed`
* `setRenderEnabled`
* `setAudio`
* `setScale`
* `setRotation`
  このため、restore hookとは無関係な外部MCP呼び出しや別処理からの要求も、タイミングが一致すれば復元効果として受理される。
  修正方針：
* sandboxからのMCP requestへ、現在実行中のbaseline hookを識別する内部情報を追加する。
* 少なくとも`operationId`、`scriptId`、`scriptInstanceId`、`baselineHookCallId`、`save|restore`を内部経路で保持する。
* 公開paramsへ予約フィールドとして混入させず、既存のinternal metadata機構を使用する。
* dispatcherは、現在のrestore operationと内部identityが完全一致する要求だけを遅延効果として受理する。
* 外部WebMCP、eval、通常イベントcallback、別scriptから同じコマンドが呼ばれた場合は`BUSY`を返す。
* save hookからの効果要求は引き続き拒否する。
* 遅延キューへ追加する前にcommand固有のparams検証を行う。
* 無効な`setSpeed`などを一旦成功扱いにし、全hook終了後の適用時に初めて失敗させてはならない。
* hookは無効な要求に対する`INVALID_ARGUMENT`をその場で受け取れるようにする。

## P1-4：storage version 1では必ずIndexedDBのscript JSONを読む

現在の`loadPersistentBaselineState()`は、baseline objectに非列挙の`persistentScripts`が残っていれば、それを返してIndexedDBのsizeとSHA-256検証を省略する。
保存直後の同一セッションではmemory cacheを読み、ページ再読込後はIndexedDBを読むため、同じbaselineでもセッションによって検証経路が異なる。
修正方針：

* `persistentScriptsStorageVersion === 0`の場合だけinline JSONを読む。
* `persistentScriptsStorageVersion === 1`の場合は、memory objectに`persistentScripts`が存在しても必ずIndexedDBを読む。
* 新規保存後に`state.analysisBaselines`へ格納する値も、localStorageへ保存したものと同じmanifest-only objectにする。
* 非列挙のinline cacheへ依存しない。
* 同一セッション中にIndexedDBのscript slotが欠損、size不一致、hash不一致になった場合も`STATE_INVALID`になることをテストする。

## P1-5：保存する実行状態は実際の停止境界から取得する

`saveAnalysisBaseline()`はfile transactionのcommit前に`emulatorActivity()`を取得し、その値をbaseline metadataへ保存している。
commit待機中は`pause`が許可されているため、実際にNative Stateを保存した時点のrun stateと、metadataの`running/paused`が異なる可能性がある。
修正方針：

* baselineへ保存する`running`と`paused`には、`pauseForFileLoad()`が返した`runState`を使用する。
* commit前に取得した`activity`をmetadataへ使用しない。
* commit待機中に明示pauseされた場合、そのbaselineを復元しても自動resumeしないことをテストする。

## P2-1：callback errorの構造化情報を取得可能にする

callback errorはmain threadへ届き、`script.lastError`へ格納されるようになったが、`scriptSummary()`や`getScript`の返却には含まれていない。
現状では構造化した`line`、`column`、`sourceName`、`sourceExcerpt`を外部から取得できず、文字列化されたconsole出力に依存する。
修正方針：

* `getScript`または専用コマンドから、boundedな`lastError`を返す。
* 最低でも`phase`、`errorName`、`line`、`column`、`sourceName`、`sourceExcerpt`を含める。
* 新しいcallback errorを受信したときだけ更新する。
* script再起動時には古いinstanceのerrorを引き継がない。
* callback error、persistent MCP error、baseline save hook error、baseline restore hook error、`await mcp.call()`失敗について、ユーザーソース行を確認するテストを追加する。

## P2-2：parserによる同一ソースの二重解析を削除する

`parser.worker.js`では`assertSandboxSource(message.code)`が連続して二回呼ばれている。
構文判定結果は変わらず、Acornによる解析とAST走査だけが二重に実行される。
一回だけ実行するよう修正する。

## 必須回帰テスト

次を追加する。

1. save hook完了時に通常イベントがqueue済みでも、Native State取得と全script JSON取得が終わるまで実行されない。
2. 一つ目のrestore hook完了時に通常イベントがqueue済みでも、全restore hookと遅延効果が完了するまで実行されない。
3. baseline barrier中に満了したtimeoutとinterval callbackが、barrier解除後までclosure stateを変更しない。
4. baseline hook開始時に通常イベントまたはblocking MCPが実行中なら、明確なquiescence規則に従って待機または`BUSY`となる。
5. `loadState`がNative State適用後のframe描画またはtrace同期で失敗すると`STATE_PARTIALLY_RESTORED`になる。
6. Native State適用前のhash不一致は`STATE_INVALID`のままである。
7. stateLoad callbackから通常コマンドを呼んでも、file transactionまたはbaseline operationを理由に拒否されない。
8. baseline hookから`waitForFileTransaction`を呼ぶと即座に`COMMAND_NOT_ALLOWED`になる。
9. baseline hookから成立しない`waitForStateLoad`を呼んでもtimeout待ちにならない。
10. restore hook以外から同時に呼ばれた`setSpeed`はdeferred effectへ混入しない。
11. restore hookから無効な`setSpeed`を要求すると、その場で`INVALID_ARGUMENT`になる。
12. storage version 1のbaselineは、同一セッションでもIndexedDBの欠損またはhash不一致を検出する。
13. commit中の明示pauseがbaselineの復元時run policyへ反映される。
14. callback errorの構造化された行、列、source名、excerptを`getScript`相当から取得できる。
15. `await mcp.call()`の失敗が内部reply handlerではなくユーザーの呼出行を返す。

## 検証

* ローカルの`node --check`では変更対象JavaScriptの構文エラーは確認されなかった。
* ローカルの`npm test`は75件中73件が成功した。
* `boundary-regressions.test.mjs`と`merge-blockers.test.mjs`は、実装失敗ではなく`esbuild`未配置によりテストファイル自体が起動しなかった。
* したがって、ローカルでは全テスト成功を確認できていない。
* 依存が揃った環境で上記2スイートを含む全テストを実行する。
* `handoff.md`に記載された141/141成功だけを根拠にせず、今回追加する回帰テストも含めて再実行する。

## 完了条件

* 保存JSON、Native State、CPU stateが一つの排他的停止境界を表す。
* 復元中に通常イベント、timer、公開MCPが部分復元状態を観測しない。
* Native State適用後のすべての失敗が部分復元として明示される。
* stateLoadは全トランザクションとbaseline barrier解放後に一度だけ通知される。
* restore hook由来の許可済み副作用だけが遅延適用される。
* baseline hook内で自己完了を待つwaitコマンドを開始できない。
* storage version 1では常に永続化済みscript JSONのintegrityが検証される。
* callback、MCP、baseline hookのユーザーソース位置を構造化データとして取得できる。
* 依存を揃えた全テストが成功する。
