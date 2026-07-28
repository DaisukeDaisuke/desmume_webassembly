## 判定

**まだマージ不可です。**
前回の3件について、子入力taskのsettlement後に最終neutralを追加する処理、同名baseline保存の直列化、`pointerleave`でのtouch解放は反映されています。  
ただし、実際のエミュレーション経路で2件のP1が残っています。

## [P1] `recordInput({frames})`がnativeのフレームバッチ分だけ超過する

`waitForRecordingBoundary`はframe eventの`frame`を使わず、各通知時に`getFrame()`を参照しています。
さらに、境界到達後も現在値の`getFrame()`を`boundaryFrame`として保存しています。
実際のemulation loopは複数フレームをnative側でまとめて実行した後、完了通知を1フレームずつ発行します。その時点では`getFrame()`がバッチの最終フレームまで進んでいます。
最小再現:

```text
開始frame: 100
要求: frames: 5
native batch完了後のgetFrame(): 112
完了通知: frame 101～112
保存結果:
  totalFrames: 12
```

つまり`recordInput({frames:5})`が12フレームの記録として成功します。速度が高いほど、最大でnative batch幅まで超過します。
追加テストは`frame`をちょうど100から700へ変更してlistenerを1回だけ呼んでいるため、複数フレームを一括実行する実経路を再現していません。
単にeventの`frame`を結果へ使うだけでは不十分です。nativeはすでに要求数を超えて実行済みだからです。正しく直すには、frame-based recording中はemulation loopの1回の実行数を、

```js
Math.min(normalBatchFrames, recordingTargetFrame - currentFrame)
```

のように制限し、最終batchが残りフレーム数を超えないようにする必要があります。
必須テスト:

* 1回のnative batchが12フレームの状態で`frames:5`を開始する。
* nativeへ渡す実行数が5へ制限される。
* `totalFrames`が5になる。
* State、入力event、実際の最終PCが5フレーム後の状態と一致する。

## [P1] baselineの保存と削除はまだ競合する

今回追加されたmutexは`saveAnalysisBaseline`同士だけを直列化しています。
`deleteAnalysisBaseline`はそのmutexを通らず、読み取ったStateを削除した後、現在のmetadataを無条件で消します。
次の順序を再現しました。

```text
1. deleteAnalysisBaselineが旧metadataを読む
2. 旧Stateの削除処理を一時停止
3. saveAnalysisBaselineが新Stateと新metadataを正常commit
4. deleteAnalysisBaselineを再開
5. delete側がanalysisBaselinesとlocalStorageを削除
```

両commandは`ok:true`で完了しますが、結果は次の状態です。

```text
metadata: なし
新しいState: IndexedDBに孤立
```

同名save同士のテストは追加されていますが、saveとdeleteの並列実行は対象外です。
`deleteAnalysisBaseline`も同じ`withAnalysisBaselineSaveLock(name, ...)`で囲み、lock取得後にmetadataを読み直してください。できれば同じ名前に対するsave、delete、restoreを同一のbaseline lockへ統一する方が安全です。

## 修正確認済み

* 子入力taskのcleanup中に進んだframeを、そのまま終了frameへ加算する前回の問題は、通常の単一frame通知では修正されています。
* 最終neutral inputが固定offsetへ追加されるようになっています。
* temporary baseline slotへserialが追加されました。
* 同名のsave同士は直列化されています。
* `pointerup`、`pointercancel`、`lostpointercapture`、`pointerleave`が中央の`setTouchState()`を通ります。

## テスト結果

```text
node --test tests/new-plan-services.test.mjs
21 pass / 0 fail
```

```text
npm test
68 pass / 2 fail
```

失敗した2件は今回も実装上のassert失敗ではなく、`esbuild`が配置されていないため次のテストファイルを起動できなかったものです。

```text
tests/boundary-regressions.test.mjs
tests/merge-blockers.test.mjs
```

全`src` JavaScriptファイルの`node --check`は成功しました。`check:js`、dependency bundle検査、license検査は`esbuild`未配置のため実行不能でした。
