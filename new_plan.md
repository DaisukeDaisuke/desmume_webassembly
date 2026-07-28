## 判定

**現状はマージ不可です。** 確定済みだったフレームキュー化、compact tupleの事前検証、`runUntil`返却値の補完などは実装されていますが、実用途を止める不具合が残っています。

## マージブロッカー

### [P1] `waitForStateLoad`／`waitForFileTransaction`が待機対象のロード自身にキャンセルされる

`waitForStateLoad`と`waitForFileTransaction`は`operationManager.run()`上で待機しています。一方、公開されたState／ROMロードは`cancelAndWait("state-load")`などを呼ぶため、ロードイベントが発行される前に待機operationがキャンセルされます。
最小再現でも次の結果になりました。

```text
waitForStateLoad was cancelled
reason: state-load
```

このままでは、別のMCP操作やファイル選択によるState適用完了を待てません。
修正方針:

* State/file待機を通常の排他的operationとは別のwatcherとして管理する。
* または、ロード開始時の`cancelAndWait`から、そのロードを待っているwatch operationだけを除外する。
* `waitForFileTransaction({idle:true})`はbeginではなくendまで生存させる。

### [P1] serial待機が直前に完了したイベントを取りこぼす

`src/serial-event-service.js:20-38`と`src/pause-event-service.js`の`waitForEvent()`は、登録後に発生したイベントしか確認しません。`latest`を保存しているのに、待機開始時に検査していません。
そのため、次の順序で永久待機またはtimeoutになります。

```text
1. 呼び出し側がafterSerialを取得
2. Stateロードが完了してserialが進む
3. waitForStateLoad({afterSerial})を開始
4. すでに完了したイベントを取得できない
```

最小再現でも、serial 1をpublishした後に`afterSerial:0`で待つとresolveせず、abortになりました。
修正方針:

```js
function waitForEvent({ afterSerial = serial, predicate = () => true, signal } = {}) {
    if (latest && latest.serial > afterSerial && predicate(latest)) {
        return Promise.resolve(latest);
    }
    // その後にlistenerを登録
}
```

ただし、latest確認とlistener登録の間にもpublishされないよう、同一同期処理内で順序を保証してください。`waitForPause`にも同じ修正が必要です。

### [P1] `recordInput({replace:true})`の保存失敗で既存recordingまで全削除される

新データを既存と同じkeyへ順番に書き込み、完了前に失敗すると`finally`でmeta、data、Stateをすべて削除しています。
実際に既存recordingを用意し、metadata書き込みだけ失敗させたところ、旧recordingを含む全keyが消えました。
さらに、State付きrecordingを`captureState:false`で正常に置換すると、旧State keyは削除されず孤立します。
修正方針:

* 一意なtemporary keyへ新しいdataとStateを書く。
* 全書き込みとhash計算が成功した後、metadataの参照先を最後に切り替える。
* commit成功後だけ旧data／Stateを削除する。
* 失敗時はtemporary keyだけを削除する。
  IndexedDB transactionを使えるなら、metadata、data、Stateを同一transactionへ入れる方が確実です。

### [P1] State／ROMロード中も長時間入力commandが継続する

`runInputHold`、`runInputTap`、`runTouchHold`は`waitForInputWindow`へoperation signalを渡しておらず、pause eventだけを監視しています。
Stateロードの`pauseForFileLoad()`は内部状態を直接pauseへ変えますが、通常のpause eventを発行しません。また、これらの入力command自体はoperation managerで管理されていません。recording中は明示的に同時実行が許可されています。
最小再現では、長押し開始後にStateロード相当のpauseへ変更しても、

```text
pause後もAが押されたまま
約80ms後まで解放されない
commandはok:trueで終了
```

となりました。
このため、ROM／Stateの切り替え後に旧sessionの入力処理がキーを再度押す可能性もあります。
修正方針:

* 長時間入力を追跡可能なinput taskとして管理する。
* file transaction begin時に全input taskをabortし、settlementを待ってからロードする。
* recording中に実行した入力commandにはrecord operationのsignalを関連付ける。
* file transaction、ROM generation、State load serialの変化も入力待機の中断条件にする。

### [P1] WebMCPを1回使うだけでROM未ロードでもruntimeが読み込まれる

bootstrap側の`desmume.list`と`desmume.call`は、commandを確認する前に必ず`ensureEmulatorLoaded()`を呼びます。
したがって、ページ表示後にCodexが最初に行いがちな、

```js
desmume.list()
desmume.call({ command: "status" })
```

だけで`emulator.js`がimportされます。ROMロード時まで遅延するという主目的を実質的に打ち消しています。
`bootstrapApi.call()`にはruntime不要commandを処理する実装がすでにあるため、WebMCP側がそれを迂回している形です。
修正方針:

```js
execute: async (input) => {
    const parsed = parseWebMcpInput(input);
    return webMcpContent(
        await bootstrapApi.call(parsed.command, parsed.params || {})
    );
}
```

* `desmume.list`は`bootstrapApi.list()`を使う。
* `status`、`getOperation`、`cancelOperation`、input状態、保存データ一覧ではimportしない。
* ROMロードcommandだけが`ensureEmulatorLoaded()`へ進む。
* ROM未ロードのデバッガcommandはruntimeをロードせず`ROM_NOT_LOADED`を返す。

### [P1] analysis baselineがPC/CPSR検証前に一度runningへ復元される

`loadState`側には`metadata.holdPaused`が実装されていますが、analysis baselineの復元呼び出しではそのmetadataを渡していません。
baseline復元側は`loadState`が返った後に改めてpauseし、PC/CPSRを検証しています。
開始時がrunningだった場合、`loadState`内の`restoreAfterFileLoad(runState)`で一度runningへ戻した後、外側で再pauseする順序です。これは「PC/CPSR確認前に再開しない」という契約を満たしていません。
修正はbaseline用の内部呼び出しへ追加するだけです。

```js
withInternalMetadata(params, {
    analysisBaselineSlotToken,
    fileTransactionToken: token,
    holdPaused: true
})
```

PC/CPSRと設定の検証がすべて成功した後にだけ、baselineの保存状態へ復帰させてください。

## 重要な契約不一致

### [P2] `replayInput`の`pauseAfter:false`が機能しない

Stateを読み込まない場合は再生開始前に必ずpauseし、Stateを読み込む場合も`holdPaused:true`です。終了時の処理は、`pauseAfter !== false`ならpauseするだけで、falseの場合にresumeしていません。
最小再現結果:

```text
pauseAfter:false
pause呼び出し: 1回
resume呼び出し: 0回
```

したがって、falseでもpausedのままです。
また、成功結果に要求されていた`paused`と`running`もありません。
修正方針:

* `pauseAfter:false`なら再生完了後に明示的にresumeする。
* または開始状態を保存し、「falseなら開始状態を復元する」と契約を変更する。
* 成功結果へ実際の`paused`／`running`を追加する。

### [P2] 検証を省略しても`pcVerified:true`を返す

現在は次の論理式です。

```js
const pcVerified = params.verifyStart === false || actualComparison;
```

そのため`verifyStart:false`では、比較していないのに`pcVerified:true`になります。
最小再現でも、意図的にPC/CPSRを不一致にした状態で、

```json
{
  "verifyStart": false,
  "pcVerified": true
}
```

となりました。
`verificationSkipped:true`を別fieldにするか、未検証時は`pcVerified:false`または`null`にしてください。

### [P2] runtimeローダーにhard timeoutがない

`ensureEmulatorLoaded()`はdynamic importのPromiseをそのまま共有しており、timeoutがありません。
requestが完了も失敗もしない場合、

* `runtimeLoadPromise`が永久に残る
* 次回ROMロードも同じPromiseを待つ
* UIが`loading emulator`のまま
* 再試行不能
  となります。
  必要なのは単なる`Promise.race`だけではなく、遅れて完了した旧attemptが現在のruntimeとして採用されないためのattempt IDも含むローダーです。

```js
const attempt = ++runtimeLoadAttempts;
const module = await Promise.race([importPromise, timeoutPromise]);
if (attempt !== activeAttempt) throw cancelledError();
```

## テスト状況

添付差分は元ZIPへ正常に適用できました。
`npm test`の結果は次のとおりです。

```text
pass: 53
fail: 2
```

失敗した2ファイル:

```text
tests/boundary-regressions.test.mjs
tests/merge-blockers.test.mjs
```

どちらもテスト失敗ではなく、ローカルに`esbuild`が存在しないため起動できませんでした。追加installやネット接続は行っていません。
今回追加された`tests/new-plan-services.test.mjs`は、主に次の6件だけを検証しています。

* pause serialの基本filter
* ordered frame drainの順序
* queue overflow
* input sequenceの事前validation
* breakpoint owner一括削除
* 初期canvas layout
  上で挙げたState待機、file待機、recording置換、replay option、WebMCP遅延ロード、ROM／Stateロード中のinput cancellationはテストされていません。

## 総括

主要4修正のうち、`waitForScreenChange`の順序付きqueueと`runInputSequence`の事前validationは概ね正しく実装されています。一方で、新規の待機API、record/replay、遅延ローダーには実利用を阻害する不具合があります。
特に先に直すべき順序は次です。

1. State/file待機の自己キャンセルとserial取りこぼし
2. recording置換の破壊的保存
3. ROM／Stateロード時のinput task取消
4. WebMCP経由の意図しないruntimeロード
5. baseline検証前の一時resume
6. replayの状態契約とloader timeout
