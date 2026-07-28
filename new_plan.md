## 判定

**まだマージ不可です。**
前回指摘した9件のうち、State/file待機、serial取りこぼし、recording置換、file transaction中の長時間入力、WebMCPによる不要なruntimeロード、baseline検証前resume、`pauseAfter:false`、`pcVerified`誤表示の8件は修正を確認しました。専用テスト14件もすべて通っています。   
ただし、入力記録とruntime loaderに新しいマージブロッカーが残っています。

## [P1] `recordInput`中の入力commandが正常終了後も生存する

対象:

* `src/emulator-runtime.js:483-484`
* `src/input-task-manager.js:8-34`
* `src/operation-manager.js:109-136`
  `runInputHold`などには`recordInput`のoperation signalが渡されるようになりましたが、そのsignalがabortされるのはcancelまたはtimeout時だけです。`recordInput`が正常終了した場合、operation signalはabortされません。
  `inputTaskManager`も親signalのabortだけを監視し、親operationの正常終了は検出していません。
  次の順序で実害が出ます。

```text
1. recordInputを開始
2. waitBeforeMs付きrunInputHoldを同時に開始
3. runInputHoldがキーを押す前にrecordInputが正常終了
4. operation cleanupで一度入力が解放される
5. その後runInputHoldが待機を終えてキーを押す
```

最小再現結果:

```text
release
record-returned
pressed-after-record
```

つまり記録終了後に入力が発生し、さらに次のoperationと重なる可能性があります。
修正方法:

* `recordInput`終了時に、そのrecordingを親とするinput taskをabortし、settlementまで待つ。
* 単に`releaseInput()`するだけでは不十分。
* `inputTaskManager`へparent単位の`cancelAndWait(parentSignal|ownerId)`を追加するのが安全。
  必須テスト:

```text
recordInputの正常終了時にwaitBefore中のrunInputHoldを中断する
recordInput終了後にsetKey(true)が一度も呼ばれない
子input taskのsettlement前にrecordInputが成功を返さない
```

## [P1] UIのtouch releaseが記録されない

対象:

* `src/ui/ui-controller.js:262-265`
  現在の実装:

```js
ui.screenShell.addEventListener("pointerdown", (e) => {
    ui.screenShell.setPointerCapture(e.pointerId);
    updateTouch(e, true);
});
ui.screenShell.addEventListener("pointermove", (e) => {
    if (state.touch.active) updateTouch(e, true);
});
ui.screenShell.addEventListener("pointerup", () => {
    state.touch.active = false;
});
ui.screenShell.addEventListener("pointercancel", () => {
    state.touch.active = false;
});
```

`pointerdown`と`pointermove`は`setTouchState()`を通りますが、`pointerup`と`pointercancel`は`state.touch`を直接変更しています。
そのため`subscribeInputMutations()`へtouch releaseが通知されません。
最小再現では、mutation listenerが受け取ったのは次の1件だけでした。

```js
{ touchActive: true, x: 40, y: 80 }
```

内部状態はrelease済みでも、recording上は押されたままです。記録終了時の`releaseInput()`までrelease eventが作られないため、replayでは本来より長時間touchし続けます。
修正:

```js
ui.screenShell.addEventListener("pointerup", () => {
    setTouchState(false, 0, 0);
});
ui.screenShell.addEventListener("pointercancel", () => {
    setTouchState(false, 0, 0);
});
```

DS画面外へpointerが移動した場合やpointer capture喪失時も、同じ中央mutation経路で解放してください。

## [P1] runtime timeout後も古いdynamic importがruntimeを起動する

対象:

* `src/app.js:26-38`
* `src/runtime-loader.js:20-59`
  loaderは`Promise.race()`でtimeoutを返していますが、`import("./emulator.js")`自体はキャンセルされません。
  実際のdynamic importを遅延させて確認すると、次の状態になりました。

```text
loader.status():
  loaded: false
  loading: false
  error: "emulator runtime load timed out..."

実際:
  emulator moduleは後から実行済み
  runtime APIはglobalへ公開済み
```

つまりattempt IDは、import完了後にcandidateを採用しないだけです。モジュール自身が行うUI初期化、イベント登録、global API公開は防げません。
さらに、同じspecifierへのdynamic importは同じ保留中のmodule loadを共有します。現在のテストはattemptごとに独立したPromiseを返しているため、実ブラウザのdynamic importを再現していません。
実害:

* statusは`emulatorLoaded:false`なのにruntimeが動いている。
* bootstrapのROM change listenerが残る。
* runtime側も`src/ui/ui-controller.js:41`でROM change listenerを追加する。
* 次のROM選択時に2つのload handlerが同時に動く可能性がある。
* 永久に保留されたmodule importへ、同じURLで再試行しても新しい取得にならない。
  正しく直すには、module評価とruntime初期化を分離する必要があります。

```js
// emulator.js
export function initializeEmulatorRuntime() {
    // UI登録、window.DesmumeMCP公開、Worker初期化など
}
```

loader側:

```js
const module = await import("./emulator.js");
if (attempt !== activeAttempt) return;
const api = await module.initializeEmulatorRuntime();
```

ただしimport自体が永久保留する場合の再取得も必要なので、再試行時は別URLまたはキャンセル可能なscript loaderを使う設計が必要です。「同じdynamic importをもう一度呼ぶ」だけではhard retryになりません。

## [P1] analysis baselineの置換保存がまだ非原子的

対象:

* `src/commands/context-commands.js:158-199`
  現在は既存baselineのState slotへ先に新しいbytesを書き、その後でSHA-256を計算してmetadataを書いています。

```js
await idbPut(slot, stateBytes);
const baseline = {
    stateSha256: await sha256Hex(stateBytes),
    ...
};
writeAnalysisBaseline(name, baseline);
```

Stateの上書きが先であることは実装差分からも確認できます。
`replace:true`でhash計算やmetadata保存が失敗すると、

* 旧metadataは残る
* State bytesだけ新しいものへ置き換わる
* 旧baselineのhashとStateが一致しなくなる
* 既存baselineまで復元不能になる
  という状態になります。
  最小再現:

```text
保存前State: [1]
新State:     [9, 9]
hash計算:    failure

結果:
State slot:  [9, 9]
metadata:    旧size・旧hashのまま
```

`recordInput`と同じようにtemporary State slotへ保存し、hash計算成功後にmetadataを最後に切り替える必要があります。commit後に旧slotを削除してください。

## [P2] Bootstrap WebMCPが実行時エラーをすべて「JSON不正」にする

対象:

* `src/bootstrap-webmcp.js:7-17`
  現在のwrapperはparseだけでなくhandler実行も同じ`try`内にあります。

```js
try {
    return webMcpContent(await handler(parseInput(input)));
} catch (error) {
    return webMcpContent(fail(
        "INVALID_ARGUMENT",
        "WebMCP input is not valid JSON",
        ...
    ));
}
```

そのため、たとえばIndexedDB取得失敗でも次の応答になります。

```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "WebMCP input is not valid JSON",
    "details": {
      "message": "IndexedDB unavailable"
    }
  }
}
```

JSON parseだけを個別にcatchし、handler側のエラーは元のstable errorまたは`INTERNAL_ERROR`として返すべきです。

## テスト結果

```text
node --test tests/new-plan-services.test.mjs
14 pass / 0 fail
```

```text
npm test
61 pass / 2 fail
```

失敗した2件は今回も`esbuild`未配置によるテストファイル起動失敗です。追加installやネット接続は行っていません。

## 結論

前回の修正内容そのものは大部分が正しく反映されています。ただし、現在も次の3領域は完成していません。

1. `recordInput`の終了境界とtouch releaseの正確性
2. timeout後のruntime module初期化・再試行制御
3. analysis baseline置換時のデータ保全
   特に最初の2件は通常のrecord/replayとROMロードを壊すため、マージ前の修正が必要です。
