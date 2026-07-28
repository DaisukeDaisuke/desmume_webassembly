うん、`recordInput`と`replayInput`はあった方がいいです。`runInputSequence`は人間や既存APIの操作を記録する機能ではなく、手書きした入力列を実行する機能なので用途が別です。Stateと入力記録をひも付ければ、開始状態のずれを排除した再現実験にも使えます。レビューで確定した4件の主要修正、read/write分離、baselineのPC/CPSR検証も削らず統合しました。

# DeSmuME Web Debuggerの不足修正・API追加・入力記録再生の実装指示

## 目的

現行のDeSmuME Web Debuggerに残る主要バグを修正し、不足している操作・待機・デバッグAPIを追加する。さらに、実際のDS入力を記録する`recordInput`と、必要に応じてStateを同じコマンド内で読み込んで再生する`replayInput`を実装する。
これは再レビューだけを行うタスクではない。コード、テスト、API説明、生成バンドルまで更新すること。

## 最重要ルール

* 以下に記載した主要バグ、API追加、仕様変更を、独自判断で削除、統合、先送り、優先対象外へ変更しない。
* タスクが大きいことを理由に、最初の数件だけ実装して残りを消さない。
* 実装不能な項目がある場合も指示書やTODOから削除せず、実装不能な具体的根拠を最終報告へ残す。
* ユーザーが意図的に削除した既存差分を復元しない。
* 既存APIを削除、改名、非互換化しない。新APIは原則として追加で実装する。
* `runInputSequence`のcompact tuple形式を維持する。フルネームobject形式へ変換しない。
* `waitForMemoryChange`は実装しない。CPUによるreadとwriteを分離した`runUntilMemoryRead`と`runUntilMemoryWrite`を実装する。
* build-time bundle済みのAcornおよびssim.jsをruntime CDN方式へ戻さない。
* 過去の復元仕様だけを根拠として、現在のpause復元契約を勝手に変更しない。
* input、pause、timeout、breakpoint、State loadの失敗を理由に`take_screenshot`へフォールバックしない。
* 画面状態の機械判定には`captureFrame`、`compareFrame`、`waitForScreenChange`、今回追加する画面待機APIを使う。
* 外部Web検索は使用しない。添付された現行コード、現行API文書、テスト、レビュー文書だけを根拠にする。
* UTF-8として読む。書き込みには`apply_patch`を使う。

## 作業前に読むファイル

* `AGENTS.md`
* `system.md`
* `webassembly/API_CURRENT.md`
* 今回変更する`src/`以下の関連ファイルとテスト
* `public/desmume.js`、`public/branches`、`public/emulators.json`は読まない。

## 1. `waitForScreenChange`のフレーム取りこぼしを修正する

現在の`finished || comparing || frames % sampleEvery`によるreturnでは、非同期比較中に完成した比較対象フレームが捨てられ、`stableFrames`が実際には連続していないフレームで成立する。
次の契約で修正する。

* `sampleEveryFrames`の対象となったcompleted frameは、通知時点でraw pixelsを独立した`Uint32Array`へコピーする。
* `{frame, serial, pixels}`を順序付きqueueへ追加する。
* 比較処理は1本のdrain loopだけで直列実行する。
* baselineは開始時に取得したframe Aへ固定する。途中のframeを新しいbaselineにしない。
* `stableFrames`はqueueへ入った連続サンプルの比較結果だけで数える。
* `frameService.comparePixels()`は現在画面を再取得するため、queue内のpixels比較には使用しない。
* `compareCapturedPixels(baselinePixels, currentPixels, params)`相当を追加する。
* `comparePixels()`と`compareFrame()`は可能なら同じ低レベル比較処理を再利用する。
* queueには明示的な上限を設ける。
* 上限超過時にサンプルを無言で捨てたり、最新frameだけへ追いついたりしない。
* 上限超過はstructured errorとして終了し、stable countを誤成立させない。
* 終了、timeout、cancel、breakpoint、script pause時にはlistener、queue、drain処理を確実に解放する。
  必須テスト:
* B=変更、C=未変更、D=変更で、Bの比較中にCとDが完成しても`stableFrames:2`が成功しない。
* B=変更、C=変更では、非同期比較でもB、Cの順番で処理されて成功する。
* queue上限超過が明示エラーになる。
* timeoutまたはcancel後に遅れて完了した比較が結果を上書きしない。

## 2. `runInputSequence`の事前validationを完全化する

compact tupleは維持したまま、sequence全体を実行前に検証する。
対象opcode:

* `["t", buttons, count?]`
* `["s", buttons, durationMs]`
* `["h", buttons, durationMs]`
* `["hf", buttons, frames]`
* `["w", durationMs]`
* `["wf", frames]`
* `["x", x, y, durationMs?]`
  検証条件:
* sequenceは空でない配列。
* 各stepは配列。
* opcodeごとのtuple要素数を固定する。
* button文字列は1個以上の既知buttonを含む。
* `count`は1以上の整数で既存上限以下。
* `durationMs`、`holdMs`、`gapMs`は0以上の有限数。
* duration合計は600000ms以下。
* frame数は1以上の整数で`stepFrames`の既存上限以下。
* touchのxは0..255、yは0..191の整数。
* `params.tap`もtuple長、hold、gapを検証する。
* `NaN`、Infinity、負数、小数、範囲外、過大値を`INVALID_ARGUMENT`にする。
* 不正値を`Number()`へ渡した結果に実行挙動を任せない。
* sequence全体の検証完了前にlocalStorageへ保存しない。
* sequence全体の検証完了前にbutton、touch、frame、timerを変更しない。
* 保存済みsequenceを読み込む場合も再検証する。
* compact tupleをフルネームobjectへ正規化しない。
  必須テスト:
* 最後のstepだけが不正なsequenceで、input mutationが0件、storage writeが0件。
* `NaN`、Infinity、負数、小数、上限超過、範囲外touchを個別に検証。
* 不正な保存済みsequenceも実行されない。
* 正常な既存compact sequenceとの互換性を維持する。

## 3. 実時間入力中のpauseを即時検出する

`w`、`t`、`s`、`h`、`x`および単独入力commandの待機中にbreakpoint等でpauseしても、timer満了までbuttonまたはtouchが残る問題を修正する。

* 共通の`waitForInputWindow()`相当を実装する。
* timer、operation abort、pause通知を競合させる。
* pollingで`getPauseDetails()`を繰り返す方式ではなく、停止通知を購読する。
* 通常breakpoint、memory breakpoint、special breakpoint、persistent scriptの明示pause、native faultを検出する。
* manual pauseは既存cancel経路と統合してよい。
* pause通知を受けたらtimer満了を待たず`INPUT_UNAVAILABLE`として終了する。
* detailsには既存語彙を使い、可能な範囲で`paused`、`running`、`pauseKind`、`breakType`、`cpu`、`address`、`pc`を含める。
* `runInputSequence`だけでなく、`runInputHold`、`runInputTap`、`runTouchHold`にも共通実装を適用する。
* `finally`でbuttonとtouchを即時解放する。
* `hf`と`wf`のcompleted frame検証を維持する。
  必須テスト:
* 長いhold中にbreakpointを発生させ、timerを待たずrejectし、buttonが解放される。
* touch hold中でも同様にtouchが解放される。
* tapのhold中、gap中、spam中、wait中をそれぞれ検証する。
* native faultとscript pauseでも入力が残らない。

## 4. `runUntil`の成功結果を補完する

`runUntil({bp,hits})`の成功結果へ次を追加する。

* `pc`
* `pauseKind`
* eventに存在する場合だけ`breakType`
* 既存の`bp`
* 既存の`hits`
* 既存の`frames`
  `runUntil({pc})`も可能な限り同じ共通結果形式にし、少なくとも`pc`と`pauseKind`を返す。
  `pauseKind`は既存の停止detailsと同じ語彙を使い、新しい同義語を増やさない。
  必須テスト:
* bp指定時に`pc`が`"0x..."`形式で返る。
* `pauseKind`が返る。
* memory breakpoint等で`breakType`が存在する場合だけ返る。
* PC指定形式の既存結果を壊さない。

## 5. operation確認・取消APIを公開する

次を実装する。

* `getOperation`
* `cancelOperation`
* `status.operation`
  契約:
* `getOperation`は現在のoperation ID、name、開始情報など、`operationManager.current()`の公開可能な情報を返す。
* operationがなければ`operation:null`。
* `cancelOperation`は現在のoperationだけを取消し、cleanup完了まで待つ。
* operationがなければ`ok:true, cancelled:false`。
* operationがあれば`ok:true, cancelled:true`と取消対象を返す。
* `cancelOperation`自体はactive operationが存在しても呼び出せる回復用commandにする。
* cancel後はtimer、listener、一時breakpoint owner、button、touchが残らない。

## 6. 汎用pause待機APIを追加する

`waitForPause`を実装する。
例:
`waitForPause({timeoutMs:30000, afterSerial, kinds:["executeBreakpoint","memoryBreakpoint","specialBreakpoint"]})`
契約:

* `timeoutMs`必須、1..600000。
* manual pause、execute breakpoint、memory breakpoint、special breakpoint、persistent script pause、native faultを共通イベントとして扱えるようにする。
* stale eventを返さないようserialを持つ。
* kinds指定時は対象外のpauseを無言で成功扱いしない。
* 結果には`paused`、`running`、`pauseKind`、`serial`、`frame`を含める。
* 利用可能な場合は`breakType`、`cpu`、`address`、`pc`、`scriptId`を追加する。
* 全停止経路から共通pause serviceへpublishする。

## 7. State・file transaction完了待機APIを追加する

最低限、次を追加する。

* `waitForStateLoad`
* `waitForFileTransaction`
  `waitForStateLoad`例:
  `waitForStateLoad({afterSerial:4, timeoutMs:30000})`
  結果:
* `stateLoadSerial`
* `fileTransactionSerial`
* `fileTransactionActive`
* `paused`
* `running`
* `frame`
  `waitForFileTransaction`例:
  `waitForFileTransaction({afterSerial:11, timeoutMs:30000, idle:true})`
  契約:
* pollingを利用者へ要求しない。
* upload_fileによるファイル選択完了と、State適用完了を区別する。
* stale serialを成功として返さない。
* timeoutとcancel時にlistenerを残さない。

## 8. frame一致・安定待機APIを追加する

次を追加する。

* `waitForFrameMatch`
* `waitForScreenStable`
  `waitForFrameMatch`は保存済みsnapshotへ一致するまで待つ。
  `waitForScreenStable`は連続frame間の差分が指定threshold未満の状態が`stableFrames`回続くまで待つ。
  共通条件:
* `timeoutMs`必須。
* algorithm、screen、region、ignoreRects等は既存比較APIと共通化する。
* `waitForScreenChange`と同じ順序付きqueue処理を再利用する。
* 非同期比較中の対象frameを捨てない。
* breakpoint、script pause、native faultをstructured errorとして返す。
* screenshotは使用しない。
* 閾値、使用するアルゴリズムを受け入れ、比較アルゴリズムを再利用する。

## 9. memory read/write実行待機APIを追加する

`waitForMemoryChange`は追加せず、次を別APIとして実装する。

* `runUntilMemoryRead`
* `runUntilMemoryWrite`
  例:
  `runUntilMemoryRead({cpu:"arm9", address:"0x02000020", hits:3, timeoutMs:30000})`
  `runUntilMemoryWrite({cpu:"arm9", address:"0x02000020", hits:3, timeoutMs:30000})`
  契約:
* `timeoutMs`必須。
* `hits`は1以上。省略時1。
* 1回目から`hits-1`回目までは対象命令から安全に抜けて自動継続する。
* `hits`回目ではpauseしたまま返す。
* 結果には`cpu`、`address`、`pc`、`value`、`size`、`hits`、`pauseKind:"memoryBreakpoint"`、`breakType:"read"|"write"`、`frame`を含める。
* 一時breakpoint ownerを使用し、既存user/script ownerを削除、上書きしない。
* success、timeout、cancel、errorの全経路で一時ownerだけを削除する。
* readとwriteを曖昧なcondition引数へ統合しない。

### native debug accessの除外

上記変更について、Webフロントエンド由来のmemoryアクセスをhitとして数えない。

* `MMU_AT_DEBUG`によるread/writeはnative MMU hook側で除外する。
* JS側だけの「AIが読んでいる間は無視する」フラグで代用しない。
* `memoryReadByte/Word/Dword`
* `memoryWriteByte/Word/Dword`
* `dumpMemory`
* `searchMemory`
* UI memory viewer
* persistent scriptのmemory read/write
* memory freeze
* disassemblyおよびcall stack生成のデバッグread
  以上がhit数を増やさず、pauseも起こさないことをnative統合テストで確認する。
  一方、エミュレート中のARM命令による同じアドレスへのアクセスは正確に1回として数える。

## 10. analysis baselineのPC/CPSR一致を保証する

`saveAnalysisBaseline`と`restoreAnalysisBaseline`を更新する。
保存時:

* ARM9のPCとCPSR
* ARM7のPCとCPSR
* format version
  をbaselineへ保存する。
  State生成時点とのずれを避けるため、`native.saveStateBytes()`の直後かつ最初の`await`より前にARM9/ARM7のPCとCPSRを取得する。
  復元時:

1. Stateをロードする。
2. pauseを維持する。
3. ARM9/ARM7のPCとCPSRを取得する。
4. baselineと比較する。
5. 不一致ならpauseしたまま`STATE_INVALID`を返す。
6. 一致した場合だけ、baselineに保存されたrunning/pause状態へ戻す。
   成功結果:

* `pcVerified:true`
* ARM9/ARM7のPCとCPSR
  旧baseline:
* format versionを更新する。
* PCメタデータがない旧形式を暗黙に`pcVerified:true`へしない。
* 通常モードで`pcVerified:false`として返すか、厳密モードでは再保存を要求する。

## 11. input状態確認・強制解放APIを追加する

次を追加する。

* `getInputState`
* `releaseInput`
  `getInputState`は現在のkey bitmaskまたはbutton一覧と、touchのactive、x、yを返す。
  `releaseInput`は全buttonとtouchを解除する。
  `releaseInput`はpause中、BUSY中、input error後でも使用可能な回復用commandとし、`requireInputRunning()`を通さない。

## 12. persistent scriptのState event登録helperを公開する

内部に存在する`stateLoad`と`stateSave`イベントをpersistent scriptから登録できるようにする。
最低限:

* `emu_onstateload(callback, options)`
* `emu_onstatesave(callback, options)`
  既存の命名方針に合わせて`emu.onStateLoad`と`emu.onStateSave`もaliasとして提供してよい。
  イベントbus、Worker経路、既存のsandbox制約は維持する。

## 13. breakpoint一括削除APIを追加する

`clearBreakpoints`を実装する。

* 既定ではuser所有だけを削除する。
* nativeの`clearAllBreakpoints()`だけを直接呼ばない。
* owner store経由で削除し、owner reconciliationを維持する。
* script所有やoperation所有を通常動作で削除しない。
* `origin:"all"`を提供する場合は危険な明示指定として扱う。
* 結果に削除したIDと残存breakpointを返す。

## 14. 保存データ管理APIを追加する

次を追加する。

* `listStateSlots`
* `deleteStateSlot`
* `listSaveSlots`
* `deleteSaveSlot`
* `listAnalysisBaselines`
* `deleteAnalysisBaseline`
* IndexedDBのkey一覧取得とdelete helper
  削除時は通常State、Save、analysis baseline、後述のinput recordingをprefixで区別する。
  analysis baseline削除時はmetadataと内部State slotを両方削除する。

## 15. `recordInput`を追加する

`runInputSequence`とは別機能として、UI操作およびAPI経由で実際に発生したDS入力を記録する。
例:
`recordInput({id:"menu-route", frames:600, timeoutMs:30000, captureState:true})`
または:
`recordInput({id:"menu-route", durationMs:10000, timeoutMs:15000, captureState:true})`
パラメータ:

* `id`: 必須。
* `timeoutMs`: 必須、1..600000。記録処理全体のhard timeout。
* `frames`または`durationMs`: どちらか一方だけ必須。
* `frames`: 記録するcompleted emulator frame数。
* `durationMs`: 記録する実時間。
* `replace`: 既存IDを置き換える場合だけtrue。
* `captureState`: 記録開始地点のStateを入力記録へ関連付ける。既定false。
* `resume`: manual pauseから記録開始する場合だけtrueを許可する。
  契約:
* `recordInput`はoperation managerで管理するlong-running operationにする。
* `timeoutMs`を省略した呼び出しは`INVALID_ARGUMENT`。
* breakpoint、script pause、native fault、State load、ROM変更、cancelで記録を終了し、成功扱いにしない。
* 記録成功前にstorageへ完成データとして公開しない。
* timeout、cancel、error時に中途半端な記録やStateを残さない。
* 全イベントと関連Stateの保存に成功してからmetadataをcommitする。

### 記録対象

DOMのkeydownだけを直接記録する実装にしない。
入力の全経路が通る中央のinput mutation層で記録する。
対象:

* キーボード入力
* 画面button
* touch入力
* `setInput`
* 単独のtap、hold、touch command
* その他、中央の`setKey`または`setTouchState`を通る入力
  `updateTouch`が`state.touch`を直接変更している場合は、中央の`setTouchState`を通すよう整理する。

### 記録形式

wall-clockだけではなくcompleted emulator frameを基準に記録する。
各入力イベントは、開始地点からのframe offsetと同一frame内の順序を保持する。
edgeだけではなく、その時点の完全な入力状態を保存する。
内部compact形式の例:
`["i", frameOffset, keyMask, touchActive, x, y]`
条件:

* 同じ入力状態が連続する場合は重複保存しない。
* 同じframe offsetに複数イベントがある場合は順序を維持する。
* 記録開始時の入力状態をoffset 0として保存する。
* 記録終了時にはneutral inputを最終状態として追加し、実機側のbuttonとtouchも解放する。
* event数と保存サイズに上限を設ける。
* 上限超過は明示的なstructured errorとし、古いeventを無言で捨てない。

### State同時保存

`captureState:true`の場合:

1. cleanな処理境界で一時pauseする。
2. `saveStateBytes()`を実行する。
3. 最初の`await`より前にARM9/ARM7のPCとCPSRを取得する。
4. ROM identity、State size、SHA-256、CPU状態をmetadataへ保存する。
5. 記録開始serialと初期input状態を確定する。
6. 開始前がrunningなら記録を開始してresumeする。
   State bytesはlocalStorageへ保存しない。IndexedDBへ専用prefixで保存する。

## 16. `replayInput`を追加する

例:
`replayInput({id:"menu-route", timeoutMs:30000})`
既存State slotから開始する場合:
`replayInput({id:"menu-route", timeoutMs:30000, stateSlot:"before-menu"})`
パラメータ:

* `id`: 必須。
* `timeoutMs`: 必須、1..600000。
* `loadState:true`: recordingに関連付けられたStateを読み込む。
* `stateSlot`: 指定State slotを読み込む。
* `loadState`と`stateSlot`は同時指定不可。
* `verifyStart`: 記録開始時のARM9/ARM7 PCとCPSRを検証する。既定true。
* `pauseAfter`: 再生成功後にpauseしたまま返す。既定true。
  契約:
* `replayInput`はoperation managerで管理するlong-running operationにする。
* recording全体、ROM identity、State metadata、event形式をinput mutation前に検証する。
* ROM不一致は`STATE_INVALID`とし、input mutationを0件にする。
* `loadState:true`なのに関連Stateがなければ`STATE_NOT_LOADED`。
* State hash、size、PC、CPSRの不一致はpauseしたまま`STATE_INVALID`。
* `stateSlot`を読み込んだ場合も、`verifyStart:true`なら記録開始PC/CPSRと比較する。
* Stateを読み込まない場合も、`verifyStart:true`なら現在のPC/CPSRを記録開始値と比較する。
* State loadと入力再生を1回の`replayInput`呼び出し内で実行する。
* public `loadState`の通常cancel経路をそのまま呼び、実行中の`replayInput`自身をcancelさせない。
* internal metadata tokenまたは低レベルState serviceを使い、State loadをreplay operationへ統合する。
* Stateロード中と最初の入力適用前は必ずpauseを維持する。
* State load後のscreen invalidation契約を維持する。最初のcompleted frameによって通常どおりvalidへ戻す。

### 再生方法

* wall-clock timerでキーイベントを再現しない。
* 記録されたframe offsetに従って`stepFrames`または同等の正確なframe進行を使う。
* offset 0のイベントを最初に適用する。
* 次のイベントまで必要なframe数だけ進める。
* 同一offsetのイベントは記録順に適用する。
* eventは完全な入力状態なので、key maskとtouch状態をそのまま復元する。
* frame進行中にbreakpoint、script pause、native faultが発生したら即時終了する。
* requested frame数を完了できなかった場合は成功扱いにしない。
* success、timeout、cancel、errorの全経路でbuttonとtouchを解放する。
* success時は既定でpauseしたまま返す。
  成功結果には最低限次を含める。
* `id`
* `events`
* `frames`
* `stateLoaded`
* `stateSource`
* `pcVerified`
* `paused`
* `running`
* 最終frame

## 17. input recording管理APIを追加する

次を追加する。

* `listInputRecordings`
* `deleteInputRecording`
  `listInputRecordings`はState bytesやevent全件を返さず、次のmetadataだけを返す。
* ID
* format version
* 作成日時
* ROM identity
* event数
* 総frame数
* duration
* 関連Stateの有無
* State sizeとhash
  `deleteInputRecording`はmetadata、eventデータ、関連Stateをすべて削除する。
  新しいerror codeとして最低限次を追加する。
* `RECORDING_NOT_FOUND`
* `RECORDING_EXISTS`
  必要ならqueueまたはevent上限用の明確なerror codeも追加する。

## 18. long-running operationの排他関係

次を同じoperation lockへ追加する。

* `waitForBreak`
* `runUntil`
* `runUntilMemoryRead`
* `runUntilMemoryWrite`
* `runInputSequence`
* `recordInput`
* `replayInput`
* `waitForPause`
* `waitForStateLoad`
* `waitForFileTransaction`
* `waitForScreenChange`
* `waitForFrameMatch`
* `waitForScreenStable`
  競合時は待機せず`BUSY`を返す。
  ただし、`getOperation`、`cancelOperation`、`getInputState`、`releaseInput`などの回復用commandはBUSY中でも呼び出せるようにする。

## 19. 必須テスト

既存テストを削除、skip、弱体化して通さない。
追加テスト:

1. `waitForScreenChange`の非同期queue順序とoverflow。
2. `runInputSequence`の完全な事前validationとstorage atomicity。
3. 全実時間input commandのpause即時検出とrelease。
4. `runUntil({bp})`の`pc`、`pauseKind`、`breakType`。
5. `getOperation`、`cancelOperation`、`status.operation`。
6. `waitForPause`のserial、kind filter、各停止経路。
7. `waitForStateLoad`とfile transaction完了待機。
8. `waitForFrameMatch`と`waitForScreenStable`の非同期比較順序。
9. `runUntilMemoryRead`と`runUntilMemoryWrite`のhit count、一時owner cleanup、debug access除外。
10. analysis baselineのARM9/ARM7 PC/CPSR一致と不一致。
11. `getInputState`とpause中の`releaseInput`。
12. persistent scriptのState event helper。
13. ownerを壊さない`clearBreakpoints`。
14. slotおよびbaseline一覧・削除。
15. `recordInput`でtimeout必須。
16. keyboard、button、touch、API入力が中央mutation層から記録される。
17. 同一frame内のevent順序が維持される。
18. 同一input snapshotの重複が除かれる。
19. 記録失敗時にmetadata、event、関連Stateが部分保存されない。
20. `replayInput`が記録されたframe offsetどおり入力を適用する。
21. replay終了時、timeout時、cancel時、breakpoint時に入力がすべて解放される。
22. `loadState:true`で関連Stateを1コマンド内に読み込み、replay自身をcancelしない。
23. Stateロード後、最初の入力より前にPC/CPSR検証を行う。
24. ROM、State hash、PC/CPSR不一致時にinput mutationが0件。
25. `listInputRecordings`がState bytesとevent全件を返さない。
26. `deleteInputRecording`が関連Stateも削除する。

## 20. API文書と公開説明を更新する

最低限、次を更新する。

* `src/api-descriptions.js`または実際に説明を登録している箇所
* `webassembly/API_CURRENT.md`
* `webassembly/API_COMPATIBILITY_INVENTORY.md`
* 必要な`system.md`または利用指示
* stable error code一覧
* long-running operation一覧
* input sequenceとinput recordingの違い
* `recordInput`のtimeout必須条件
* `replayInput`の関連State読み込み方法
* replay成功後は既定でpauseすること
* debug memory accessがmemory breakpointへ数えられないこと
  `runInputSequence`をrecord/replayへ置き換えず、両方の用途を明記する。

## 21. 実装順

全項目を残したまま、次の順で実装する。

1. 共通pause event serviceとoperation回復API。
2. `waitForScreenChange`のqueue化とframe比較共通化。
3. input validationとpause即時検出。
4. `runUntil`結果補完。
5. `waitForPause`、State/file待機、frame待機。
6. memory read/write APIとnative debug access除外。
7. baseline PC/CPSR検証。
8. input、breakpoint、persistent script、slot管理API。
9. `recordInput`の中央mutation hookと保存形式。
10. `replayInput`のState統合、frame replay、検証。
11. 全テスト。
12. API文書。
13. `npm run build:js`で`public/app.js`を更新。

## 22. 検証コマンド

追加ソフトウェアをインストールせず、利用可能な環境で次を実行する。

* `npm test`
* `npm run check:js`
* `npm run check:dependency-bundles`
* `npm run check:licenses`
* `npm run build:js`
* build後に再度`npm test`
  依存関係が存在せず実行不能な場合は、許可なく`npm install`せず、実行不能だったコマンドと理由を報告する。

## 23. 最終報告

最終回答には次を含める。

* 変更したファイル名。
* 主要4バグがすべて修正されたこと。
* 追加APIごとの実装状況。
* `recordInput`と`replayInput`の実装状況。
* State同時読み込みとPC/CPSR検証の実装状況。
* 実行した検証コマンドと結果。
* 未実装または検証不能項目がある場合、その項目を削除せず具体的な阻害要因。
  行番号の列挙や全diffの貼り付けは不要。

このままCodexへ渡せる実装指示です。

`app.js`自体を丸ごと遅延化すると初期UIやcanvas初期化まで失われるため、UI bootstrapは即時ロードのまま残し、エミュレーター本体だけを分離してROMロード時に読み込む指示にします。既存のbuild工程も削除せず、分割bundleの生成へ拡張します。

## 24. エミュレーターコードをROMロード時まで遅延読み込みする

現在、約130KBのエミュレーター関連JavaScriptをページロード時に読み込んでいる。ROMを読み込まずUIや説明だけを利用する場合にも取得、parse、初期化されるため、エミュレーター本体をROMロード時まで遅延読み込みする。
ただし、現在の`app.js`にはUI初期化、canvas構築、イベント登録、WebMCP公開など、ページ表示直後から必要な処理も含まれている可能性がある。`app.js`全体を単純に遅延化してcanvas、ファイル入力、UI状態、デバッガUIを破壊しない。

### 分割方針

ページロード時に必要な処理と、ROM実行時だけ必要な処理を分離する。
即時ロード側:

* DOM取得とUI初期化
* canvas要素および画面レイアウトの構築
* ROM、Save、Stateのファイル入力イベント登録
* ロード状態、エラー、進捗表示
* WebMCP commandの登録に必要なbootstrap
* エミュレーター未ロード状態でも利用できるstatusと説明
* 遅延ローダー本体
  遅延ロード側:
* DeSmuME本体
* EmscriptenまたはWASM連携コード
* ROM実行に必要なWorker
* emulator instance生成
* CPU、MMU、framebuffer、audioなどのruntime初期化
* エミュレーター本体に直接依存するデバッガservice
* ROMロード後にしか利用できない重量コード
  `app.js`を完全に消したり遅延scriptへ置き換えたりせず、軽量なUI/bootstrap bundleとして残す。重量コードは別bundleへ分離する。
  名称は既存構成に合わせて決めてよいが、役割は明確に分離する。例:
* `public/app.js`: UI、bootstrap、lazy loader
* `public/emulator.js`: エミュレーターruntime
  必要ならWorker用bundleはさらに分離してよい。

### 遅延ローダー

同時呼び出し、失敗後の再試行、ROM再ロードを安全に扱う共有ローダーを実装する。
概念上は次の状態を持つ。

* `unloaded`
* `loading`
* `loaded`
* `failed`
  複数箇所から同時にロード要求が発生しても、同じPromiseを共有し、script、module、Worker、WASMを重複ロードしない。
  例:

```js
let emulatorLoadPromise = null;
let emulatorRuntime = null;
async function ensureEmulatorLoaded() {
    if (emulatorRuntime) return emulatorRuntime;
    if (emulatorLoadPromise) return emulatorLoadPromise;
    emulatorLoadPromise = loadEmulatorRuntime()
        .then((runtime) => {
            emulatorRuntime = runtime;
            return runtime;
        })
        .catch((error) => {
            emulatorLoadPromise = null;
            throw error;
        });
    return emulatorLoadPromise;
}
```

実際の実装では、グローバル変数へ暗黙に依存するscript挿入より、可能ならdynamic `import()`と明示的なexportを使用する。
既存bundleまたはEmscripten出力がmodule化できずscript挿入が必要な場合も、次を保証する。

* 同じ`src`のscriptを複数追加しない。
* `load`と`error`を待つ。
* timeoutを設ける。
* 失敗したscript要素を除去し、次回再試行を可能にする。
* 読み込み完了前にROMデータをruntimeへ渡さない。
* ページ遷移やoperation cancel後に遅れて完了したロードが、破棄済みROM操作を再開しない。

### ROMロードとの統合

ROMファイルの選択またはROMロードAPIが呼ばれた場合、次の順序で処理する。

1. ROM file transactionを開始する。
2. ROMファイルを検証する。
3. `ensureEmulatorLoaded()`を呼ぶ。
4. エミュレーターruntimeのロード完了を待つ。
5. runtime初期化完了を待つ。
6. 対象ROMロード操作が現在も有効かserialまたはoperation tokenで確認する。
7. ROM bytesをエミュレーターへ渡す。
8. canvas、audio、input、debugger serviceをruntimeへ接続する。
9. ROMロード完了をpublishする。
   遅延runtimeのロード中は、UIへ`loading-emulator`相当の状態を表示し、ROMロード完了として扱わない。
   runtimeロード失敗時:

* ROMロードを成功扱いにしない。
* `fileTransaction.active`を必ず解除する。
* structured errorを返す。
* UIへ再試行可能なエラーを表示する。
* 半端なemulator instanceを破棄する。
* 次回のROMロードでruntimeロードを再試行できる。

### ROM再ロード

同じページで2個目以降のROMを読み込む場合、エミュレーターコード自体は再取得、再評価、再importしない。
ROM再ロードでは次を区別する。

* runtime bundleのロード
* emulator instanceの生成
* 現在のROM session
  runtime bundleはページ内で一度だけロードする。
  emulator instanceを再利用できる場合:
* 現在ROMを停止する。
* active operationをcancelし、cleanup完了を待つ。
* buttonとtouchを解放する。
* audio、frame、pause、breakpoint、persistent script、State関連listenerを整理する。
* 前ROM固有のdebugger owner、snapshot、baseline、recording中operationを残さない。
* 新ROMを既存runtimeへロードする。
  instanceを安全に再利用できない場合:
* 古いinstanceとWorkerを明示的に破棄する。
* runtime bundleは再ロードせず、新しいinstanceだけを生成する。
* 古いWorker、audio node、RAF、timer、canvas listenerを残さない。
  ROM再ロードのためにページ全体をreloadする実装にはしない。

### UIとcanvasを破壊しない

canvas要素はページロード時のUI bootstrapで作成し、runtime遅延ロードのたびに作り直さない。
エミュレーターruntimeは既存canvasへattachする。
ROM未ロード時も:

* canvasまたはplaceholderが表示される。
* ファイル選択UIが利用できる。
* UI buttonが消えない。
* resize処理が機能する。
* statusが`emulatorLoaded:false`、`romLoaded:false`を区別して返せる。
  ROM再ロード時もcanvas DOM nodeを不要に置換しない。置換が必要な既存設計の場合は、登録済みlistener、WebGL context、framebuffer参照を確実に再接続する。

### APIと状態

`status`へ最低限、次を追加する。

* `emulatorLoaded`
* `emulatorLoading`
* `emulatorLoadError`またはエラーの有無
* `romLoaded`
  ROM未ロードかつruntime未ロードの状態で、runtime必須commandが呼ばれた場合は、commandの性質に応じて次のどちらかへ統一する。
* ROMロードcommand: runtimeを遅延ロードして続行する。
* デバッガ、CPU、memory、frame実行command: runtimeを勝手にロードせず、既存の`ROM_NOT_LOADED`または対応するstable errorを返す。
  単なる`status`、operation確認、保存データ一覧など、runtime不要のcommandからエミュレーターbundleをロードしない。

### WorkerとWASM

WorkerまたはWASMもROMロード時まで不要なら、エミュレーターJavaScriptと同時に遅延ロードする。
ただし、次を確認する。

* Worker URLが分割bundle後も正しく解決される。
* cache bustingやbuild hashがWorkerとmain bundleで一致する。
* COOP、COEP、`coi-serviceworker`等の既存初期化順を壊さない。
* `SharedArrayBuffer`利用条件をruntimeロード前に確認できる。
* Workerの初期化完了前にROM commandを送らない。
* ROM再ロード時に古いWorkerからの遅延messageを新しいsessionへ適用しない。
  Worker messageにはsession serialまたはinstance IDを付け、旧sessionのmessageを破棄する。

### キャッシュ

遅延化は「毎回ダウンロードする」ことを意味しない。

* 初回ROMロード時だけnetworkまたはbrowser cacheから取得する。
* 同一ページ内のROM再ロードでは再取得しない。
* service workerを利用している場合も、ページロード時に積極的fetchして遅延化を無効にしない。
* install時precacheを維持する場合、network取得は先に行われても、ページmain threadでのparse、評価、runtime初期化はROMロード時まで行わない。
  本当に初期転送量も減らす目的なら、emulator bundleを初期precache対象から外す。ただしoffline動作との仕様を確認し、無断でoffline対応を削除しない。

### build

既存の`npm run build:js`を維持しつつ、UI/bootstrap bundleとemulator runtime bundleを生成する。

* entry pointを分離する。
* UI側bundleがemulator実装を静的importし、結局同一bundleへ取り込まれないことを確認する。
* dynamic importのchunkが正しく出力されることを確認する。
* build後の`public/app.js`へemulator本体が残っていないことを、bundle内容またはmetafileで検証する。
* emulator bundleを読み込まなくても初期UIが起動することを確認する。
* dependency license、固定hash、Worker埋め込み等の既存検査を壊さない。
  「130KBのファイルを別名にしただけでHTMLから引き続き即時ロードする」変更は遅延化として認めない。

### 必須テスト

1. ページ初期表示時にemulator bundleがrequest、import、評価されない。
2. ROMを選択するまで`emulatorLoaded:false`である。
3. ROM選択時にemulator bundleが1回だけロードされる。
4. 同時に複数のROMロード要求が入ってもbundleのロード処理が1回だけ実行される。
5. runtimeロード完了後にだけROM bytesが渡される。
6. runtimeロード失敗時にfile transactionとoperationがcleanupされる。
7. 初回失敗後、次回ROMロードで再試行できる。
8. ROMを再ロードしてもemulator bundleを再取得、再評価しない。
9. ROM再ロード時に旧ROMのoperation、input、breakpoint owner、persistent script、listener、Worker messageが残らない。
10. 旧sessionの遅延Worker messageが新ROMへ適用されない。
11. runtime未ロードでもcanvas、ROM選択UI、resize、statusが正常に動作する。
12. ROMロード後も同じcanvasが利用され、不要なDOM置換が起きない。
13. runtime不要のAPIを呼んでもemulator bundleがロードされない。
14. runtime必須のデバッガAPIは、ROM未ロード時に既存のstable errorを返す。
15. StateまたはSaveファイルだけを選択した場合、既存契約どおりのエラーとなり、意図せずruntimeを半端に初期化しない。
16. `npm run build:js`後、UI bundleとemulator bundleが別ファイルとして生成される。
17. 初期HTMLがemulator bundleを通常の`script`として直接読み込んでいない。
18. build後の初期UI smoke testと、初回ROMロード、ROM再ロードの統合テストを追加する。

### 実装順への追加

この項目は、既存APIと主要バグの修正を削除せず、共通serviceの境界が固まった後に実装する。
推奨位置:

1. 主要バグと共通operation、pause、input、State serviceを修正する。
2. ROM sessionとemulator instanceのcleanup境界を明確化する。
3. UI/bootstrapとemulator runtimeのentry pointを分離する。
4. 遅延ローダーを実装する。
5. 初回ROMロードとROM再ロードを遅延runtimeへ接続する。
6. Worker、WASM、service worker、build出力を調整する。
7. 遅延ロードとROM再ロードの統合テストを追加する。
8. 最後にbundle sizeと初期requestを確認する。

### 最終報告への追加

最終回答には次も含める。

* ページロード時に残るUI/bootstrap bundleのサイズ。
* 遅延化されたemulator bundleのサイズ。
* 初回表示時にemulator bundleが読み込まれないことの確認方法と結果。
* 初回ROMロード時のロード結果。
* ROM再ロード時にbundleが再評価されないことの確認結果。
* runtimeロード失敗後の再試行結果。
* canvas、UI、Worker、operation、inputのcleanup確認結果。

