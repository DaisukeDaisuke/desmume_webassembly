## 判定

**まだマージ不可です。**
前回残っていた修正のうち、runtimeの遅延ロード再試行、WebMCPのエラー分類、親operation単位の入力task取消、baselineの通常時の原子的置換は反映されています。専用テストも19件すべて通りました。  
ただし、2件のP1と1件のP2が残っています。

## [P1] `recordInput`の終了フレームが入力taskの後処理分だけ延びる

現在は記録境界へ到達した後、先にmutation購読を解除し、子入力taskの取消・settlementを待ってから`totalFrames`を取得しています。

```js
await waitForRecordingBoundary(...);
unsubscribe();
await cancelInputTasksForOperation(operation.signal);
releaseInput();
const totalFrames = getFrame() - startedFrame;
```

この順序には2つの問題があります。

* 子taskの終了処理中に進んだframeまで`totalFrames`へ入る。
* 購読解除後に入力を解放するため、最後のneutral inputがeventsへ記録されない。
  最小再現では、記録境界をframe 5、子taskのsettlement終了をframe 8にすると、保存結果は次になりました。

```text
totalFrames: 8
events:
  neutral
  A押下
  最終neutralなし
```

つまり、指定した記録範囲より3frame長く再生され、その追加区間では最後の入力状態が維持されます。
修正は、記録境界を子taskの後処理より前に固定する必要があります。

```js
await waitForRecordingBoundary(...);
const boundaryFrame = getFrame();
const totalFrames = Math.max(0, boundaryFrame - startedFrame);
unsubscribe();
await cancelInputTasksForOperation(operation.signal);
releaseInput();
appendAt(totalFrames, neutralSnapshot);
```

`appendAt()`相当で、現在の`getFrame()`ではなく固定済みoffsetへneutral eventを追加してください。同一offset内では既存の入力eventより後になるよう順序を維持します。
必須テスト:

* settlement中にframeが進んでも`totalFrames`が変わらない。
* 最後のeventがneutralになる。
* `frames:600`の保存結果がcleanup時間によって601以上にならない。

## [P1] analysis baselineのtemporary slotが並列保存で衝突する

temporary slotはbaseline名と`Date.now()`だけで生成されています。

```js
const slot =
    `${ANALYSIS_BASELINE_SLOT_PREFIX}${name}:temporary:${Date.now().toString(36)}`;
```

同じbaseline名を同一ミリ秒に並列保存すると、両方が同じslotを使います。`saveAnalysisBaseline`はoperation lockやfile transactionで直列化されていないため、WebMCPからの並列呼び出しで実際に発生します。
最小再現では、2件を並列実行し、

* 1件目のmetadata保存は成功
* 2件目のmetadata保存は失敗
  としたところ、失敗側のcleanupが共有temporary slotを削除しました。

```text
1件目: ok:true
2件目: metadata write failure
最終metadata: 1件目を参照
参照先State: 削除済み
```

通常の逐次置換に対するテストは追加されていますが、並列同名保存は検証されていません。
修正には両方必要です。

* temporary keyへ単調増加serialまたは十分な一意値を加える。
* 同じbaseline名の保存をmutexなどで直列化する。

```js
const slot = `${prefix}${name}:temporary:${Date.now().toString(36)}-${++temporarySerial}`;
```

一意化だけでも破壊は防げますが、両方成功した並列保存では、metadata競合に負けた側のStateが孤立します。同名保存の直列化まで行うのが安全です。

## [P2] touch releaseの`pointerleave`経路が未実装

中央mutation経路へ変更されたのは、

* `pointerup`
* `pointercancel`
* `lostpointercapture`
  の3種類です。`pointerleave`は登録されていません。
  前回の修正条件には、DS画面外へ出た場合も同じrelease helperを通すことが含まれていました。

```js
screenShell.addEventListener("pointerleave", releaseTouch);
```

pointer capture中の移動は`pointermove`から範囲外判定される場合もありますが、capture前の異常経路やイベント欠落時を含めて、明示的なrelease経路を残すべきです。現在の専用テストも`pointerup`、`pointercancel`、`lostpointercapture`しか呼んでいません。

## 修正確認済み

次は適切に直っています。

* runtime moduleはattemptごとに別URLで取得し、timeout済みmoduleのinitializerを実行しない。
* WebMCPのJSON parse errorとcommand実行errorが分離された。
* `cancelAndWaitForParent()`が追加され、親recordingに属する入力taskのsettlementを待つ。
* analysis baselineはmetadataのcommit後に旧Stateを削除する逐次処理へ変更された。
* `pointerup`、`pointercancel`、`lostpointercapture`は`setTouchState()`を通る。

## テスト結果

```text
node --test tests/new-plan-services.test.mjs
19 pass / 0 fail
```

```text
npm test
66 pass / 2 fail
```

失敗した2件は今回も実装テストの失敗ではなく、ローカル環境に`esbuild`が存在しないため、次のテストファイル自体を起動できなかったものです。

```text
tests/boundary-regressions.test.mjs
tests/merge-blockers.test.mjs
```

全`src/*.js`、`src/commands/*.js`、`src/ui/*.js`に対する`node --check`は成功しました。`check:js`、dependency bundle検査、license検査、buildは同じく`esbuild`未配置のため検証できていません。
