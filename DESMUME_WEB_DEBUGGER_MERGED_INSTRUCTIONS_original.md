# DeSmuME Webデバッガ AI操作拡張・JavaScript分割・配信 統合実装指示書
## 0. この統合版の位置付け
この文書は、次の4段階の指示を統合した最終指示書である。

1. AI操作拡張の初期実装指示
2. エラー処理、breakpoint所有権、画像差分library方針の追加・修正指示
3. JavaScript責務分割の追加実装指示
4. `src/`管理、単一bundle配信、build・CI方針の追加指示

競合する記述がある場合は、番号が大きい指示を優先する。さらに、この文書作成時に追加された次の指示を最優先とする。

* `public/coi-serviceworker.js`は`public/app.js`へbundleせず、独立したファイルとして保持する。
* `coi-serviceworker.js`は主に、任意JavaScript実行を含むWebデバッガをCross-Origin Isolation下へ置き、安全性を高める防御層として使う。
* persistent script、`desmume.eval`、`desmume.runScript`などの隔離Workerは、原則としてWorkerソースをbuild時にJavaScript文字列へ変換して`public/app.js`へ埋め込み、`Blob` URLから起動する。GitHub Pages上の追加requestを増やさない。
* 画像比較などの外部algorithm libraryは、固定versionのjsDelivrから必要時にロードしてよい。自作moduleの配信にはjsDelivrを使わない。
* 外部libraryをruntime CDNからロードする場合も、license義務は消えない。固定version、許可リスト、integrity検証、license記録、障害分離を必須とする。
* この指示書に明記されていない既存仕様を、暗黙に削除してはならない。現行`API.md`、`public/index.html`のUI、使用中buildの`app.js`を棚卸しし、明示的な削除指示がない機能はすべて維持する。
* 既存UIは作り直さず再利用する。既存DOM ID、button、input、template、keyboard操作、説明領域、eventの結果を維持し、module分割後も同じ利用手順を再現する。
* 現行`app.js`のcompact出力処理を維持する。結果を多重に`JSON.stringify()`してescape済みJSON文字列をさらにJSONへ入れる形式へ退行させない。
* stack traceとcall stackは初期解析を支える保護対象である。今回のJavaScript分割を理由にC++側実装を変更せず、既存の賢いmulti-frame検出、lane管理、公開時の内部frame除外を完全維持する。


この統合版で明示的に上書きされた内容以外は、元の指示を失効させない。

## 1. 目的
DeSmuME WebAssembly版Webデバッガへ、AIが長時間の解析操作を低トークン、再現可能、安全かつ回復可能な形で実行できるAPIを追加する。同時に、巨大化したJavaScriptを責務別に分割しつつ、GitHub Pagesとlocalhostでは少数の配信assetだけを読み込む構成へ移行する。

主な追加・変更対象は次のとおり。

* `waitForBreak`
* `runUntil`
* ID再利用可能な`runInputSequence`
* `captureFrame`
* `compareFrame`
* `waitForScreenChange`
* Stateロード直後の不正画面をAI・UIから隠す仕組み
* 長時間操作同士の競合を防ぐ排他制御
* breakpointの論理owner管理
* WebMCP、`window.DesmumeMCP`、Worker RPCの正常error形式統一
* JavaScriptの`src/`分割と`public/app.js`への単一bundle化
* Workerソースの文字列埋め込みと`Blob`起動
* optional algorithm libraryの固定version CDN loader
* `public/coi-serviceworker.js`の独立維持
* `setSaveType`の削除

現行`API.md`、UI、使用中buildに存在しないcommandを、設計検討名目で新設または文書へ追加しない。SPSR書き込みは別調査とし、この作業で推測実装しない。

## 2. 正本と既存実装の扱い
移行前の使用中buildでは、既存`app.js`を次の挙動の正本として扱う。

* command登録
* 引数、戻り値、default値
* pause、resumeの副作用
* ROM、Save、State処理
* breakpoint同期
* persistent script
* canvas描画
* native fault処理
* Worker RPC

分割後は、これらの正本を対応する`src/`moduleへ移す。`public/app.js`は生成物であり、正本ではない。

`wasm-port.cpp`は次のnative処理の正本として扱う。

* frame counter
* breakpoint
* last break
* CPU step
* native framebuffer
* register
* memory read/write
* call stack
* State load
* native fault時のpauseと`execute=false`

既存の挙動を推測で置き換えない。関連処理を読み、既存helperを再利用する。現行`app.js`でWorkerソースを文字列として`Blob`化している設計は、分割後も維持する。

stack trace、call stack、control-flow lane、synthetic frame判定に関するC++は今回の変更対象外とする。`wasm-port.cpp`、および`old/desmume`側の関連hookを編集せず、JavaScript側は既存native JSONを同じ意味で受け取る。public APIでは従来どおりsynthetic、observer、補助用internal frameを除外し、生の内部frame配列を外部へ公開しない。

## 3. 作業規則
実装前に必ず`API.md`を更新する。順序は次のとおり。

1. 公開APIの仕様を書く。
2. error条件とerror codeを書く。
3. fixed baselineの挙動を書く。
4. 差分algorithmの定義を書く。
5. Worker、外部algorithm loader、license方針を書く。
6. acceptance testを書く。
7. その後に`src/`、必要なら`wasm-port.cpp`を変更する。

`API.md`と実装が矛盾した場合は作業未完了とする。

人間またはAIが編集するtext、source、configファイルは`apply_patch`で変更する。PowerShellのリダイレクトでsource本文を生成しない。自動生成documentは生成元を変更してから再生成し、自動生成fileを直接編集しない。

既存APIを不用意にrenameしない。既存の`runInputTap`、`runInputHold`、`stepFrames`などは削除しない。新APIは既存APIの上位操作として追加する。

分割前に、少なくとも次の互換性inventoryを作る。

* `API.md`に記載された全command、shortcut、引数、default、戻り値
* `window.DesmumeMCP.list()`と`window.DesmumeShortcuts`で公開される項目(window.DesmumeShortcutsの公開場所は変更してよい)
* `public/index.html`に存在するbutton、input、select、template、status領域、keyboard操作、ローカルストレージ保存
* UI event handlerが呼ぶcommandと、成功・失敗時の表示結果
* stack trace、call stack、persistent script、memory search、recent file、analysis baselineなど、今回の追加機能とは直接関係しない既存機能

各Phaseの終了時にinventoryとの差分を確認する。この指示書に個別説明がないことを削除理由にしてはならない。明示的な削除対象を除き、最終的に現行`API.md`と既存UI buttonから到達できる機能を再現する。

全面書き換えを一度に行わない。既存`app.js`を一度空にしてから作り直す方法は禁止する。段階的にmoduleへ移し、各段階で既存testを通す。

Windows用`build.cmd`は作成しない。JavaScript buildは`package.json`のscript、WASM buildは既存の`webassembly/build.sh`と`webassembly/build_safe_heap.sh`を使用する。
代わりにreadme.mdにビルド手順を適切に書く。

## 4. JavaScript sourceと配信の基本方針
JavaScriptの開発用sourceは`public/`へ置かない。すべて`src/`以下へ置く。

既存sourceを移動するときは、OSのcopyまたはmove機能と`apply_patch`を使い、巨大な本文をchat、PowerShell here-string、生成promptへ再掲して作り直さない。内容の反復によるtoken浪費とescape破損を避ける。

```text
src/
  app.js
  state.js
  error-codes.js
  native-bridge.js
  mcp-responder.js
  command-registry.js
  command-context.js
  operation-manager.js
  breakpoint-service.js
  breakpoint-owner-store.js
  script-service.js
  frame-service.js
  input-service.js
  state-service.js
  rom-service.js
  save-service.js
  emulation-loop.js
  webmcp.js
  algorithm-loader.js
  commands/
  frame-diff/
  workers/
  ui/
```

GitHub Pages、localhostの双方で、ブラウザーが読み込む自作application JavaScriptは原則として次の1ファイルだけとする。

```text
public/app.js
```

`public/app.js`は生成物である。人間またはAIが直接編集してはならない。変更は必ず`src/`以下へ行い、buildによって`public/app.js`を生成する。

`src/`をPHPやPagesのdocument rootに含めない。`public/index.html`から`src/*.js`を直接importしない。

```html
<!-- 禁止 -->
<script type="module" src="../src/app.js"></script>
```

source上は責務別に分割し、HTTP配信上は単一bundleへまとめる。

```text
src/app.js
  -> services
  -> commands
  -> workers as source strings
  -> esbuild
  -> public/app.js
```

自作moduleをjsDelivrのcombine URLやGitHub rawから配信しない。privateまたは未pushのsourceを検証できず、localとproductionの経路も分かれるためである。

## 5. `public/coi-serviceworker.js`の独立運用
`public/coi-serviceworker.js`は`public/app.js`とは独立したthird-party runtime assetとして保持する。配置はroot scopeを確保できる次のpathとする。

```text
public/coi-serviceworker.js
```

次を禁止する。

* esbuild bundleへ含める。
* `src/app.js`へ文字列として埋め込む。
* generic Terser loopでminifyする。
* file名をhash付きassetへ変更してscopeを変える。
* headerのMIT license表示を削除する。
* 動作確認なしに内容を独自改変する。

`index.html`からは独立scriptとして読み込む。

```html
<script src="coi-serviceworker.js"></script>
<script src="app.js?v=BUILD_VERSION"></script>
```

`coi-serviceworker.js`の目的は、GitHub Pagesのようにresponse headerを自由に設定できない環境でも、COOP、COEPを付与し、`crossOriginIsolated`を成立させることである。これにより、SharedArrayBufferやWASM関連機能だけでなく、任意JavaScript実行を含むデバッガのcross-origin境界を強化する。

ただし、Cross-Origin Isolationは任意コード自体をsandbox化する機能ではない。次の防御を別途必須とする。

* 任意コードはmain windowで直接実行せず、専用Worker内で実行する。
* WorkerへDOM、`window`、ROM bytes、State bytes、frame pixelの直接参照を渡さない。
* main threadとの通信は許可済みRPCだけに限定する。
* Workerから任意URL fetchを許可しない。必要な外部algorithm loaderとは経路を分離する。
* Worker停止時に全pending RPCを失敗結果へ解決し、`Blob` URLをrevokeする。
* timeout時にWorkerをterminateし、operation lockと入力状態をcleanupする。

`desmume.eval`と`desmume.runScript`からDOMや`window`へアクセスしても利用できないことを仕様化する。`document`、`window`などが未定義で発生した`ReferenceError`はsandboxの想定動作であり、`SCRIPT_RUNTIME_ERROR`として位置情報付きで返す。sandboxを回避するためにmain window上で再実行しない。

本指示書と同時に渡された`coi-serviceworker v0.1.7`の内容を正本として`public/coi-serviceworker.js`へ配置する。

## 6. Worker sourceの配信方針
persistent script、`desmume.eval`、`desmume.runScript`、必要に応じたalgorithm隔離処理のWorker sourceは、開発時には`src/workers/`へ独立させる。

```text
src/workers/
  persistent-script-worker.js
  eval-worker.js
  algorithm-worker.js
```

productionでは、これらを別fileとして配信するのではなく、build時に文字列へ変換して`public/app.js`へ埋め込む。実行時は次の形を基本とする。

```js
const blob = new Blob([workerSource], {
  type: "text/javascript"
});
const workerUrl = URL.createObjectURL(blob);
const worker = new Worker(workerUrl);
```

Worker停止時には`worker.terminate()`後に`URL.revokeObjectURL(workerUrl)`を呼ぶ。Workerをrestartするたびに古いURLを残さない。

Worker sourceをentry point内へ巨大なtemplate literalとして手書きし続けない。esbuild plugin、text loader、専用build helperなどで`src/workers/*.js`をUTF-8文字列として取り込む。Worker source内のsyntax checkをbuild時に行う。

この方式の目的は次である。

* GitHub Pages上のrequest数を減らす。
* Worker sourceを`public/`へ個別配信しない。
* localとPagesで同じ起動経路にする。
* source mapなしのproductionでmodule構造を直接配信しない。
* 任意コード実行Workerの初期化をmain bundle versionと一致させる。

例外として、Workerが極端に大きくなり、main bundleの初期downloadやparseを明確に悪化させる場合だけ、独立したhash付きWorker assetを許可する。その場合は次を必須とする。

* request増加とbundle削減の実測値を`API.md`または設計記録へ残す。
* file名へcontent hashを含める。
* `public/`へ必要なWorker assetだけを置く。
* localとPagesで同じpathを使う。
* Worker assetをgeneric runtime CDNへ置かない。
* Pages artifact検証へfile存在checkを追加する。

## 7. 外部algorithm libraryとlicense
外部libraryは、自作moduleとは別に扱う。自作sourceをjsDelivrへ置くことは禁止するが、画像比較などのoptional algorithm libraryは、固定versionのjsDelivrから必要時にロードしてよい。

runtime CDN方式は、旧指示にあった「外部libraryをすべてbundleする」という方針を上書きする。ただし、すべてをCDNへ移すのではなく、algorithm単位のoptional dependencyに限定する。

推奨構成は次のとおり。

```text
src/frame-diff/pixelmatch.js
src/frame-diff/ssim.js
src/algorithm-loader.js
```

`frame-service.js`や`src/app.js`からCDN URLを直接扱わない。外部libraryのURL、version、hash、license metadataは`algorithm-loader.js`または専用manifestへ閉じ込める。

```js
const ExternalAlgorithms = Object.freeze({
  pixelmatch: {
    version: "7.2.0",
    url: "https://cdn.jsdelivr.net/npm/pixelmatch@7.2.0/index.min.js",
    sha256: "EXPECTED_SHA256_BASE64",
    license: "VERIFY_FROM_PACKAGE_LICENSE",
    homepage: "VERIFY_FROM_PACKAGE_METADATA"
  },
  ssim: {
    version: "3.5.0",
    url: "https://cdn.jsdelivr.net/npm/ssim.js@3.5.0/dist/ssim.web.min.js",
    sha256: "EXPECTED_SHA256_BASE64",
    license: "VERIFY_FROM_PACKAGE_LICENSE",
    homepage: "VERIFY_FROM_PACKAGE_METADATA"
  }
});
```

上記URLを許可リスト候補とする。hash、license、copyright、配布entryの実体は採用時に固定し、確認できない場合はloadしない。`@latest`、`@^7`、`@7`などの範囲指定は禁止する。jsDelivrの変換endpointを使う場合も、完全version固定とresponse hash固定を行う。
ローカルにクローン済みである。これらを絶対に検索対象に含めてはならない。

外部library loaderは次を保証する。

1. URLはsource内の許可リストからのみ選ぶ。
2. callerが任意URLを渡せない。
3. HTTPS以外を拒否する。
4. download timeoutを持つ。
5. CORS、COEP、CSP環境で実際に読み込めることをtestする。
6. response bytesまたはsource textのSHA-256を計算し、expected hashと一致した場合だけ実行する。
7. hash不一致では実行せず、`ALGORITHM_INTEGRITY_FAILED`を返す。
8. load失敗でdebugger全体を起動不能にしない。
9. library codeは可能ならalgorithm専用Worker内で実行する。
10. main window globalへlibrary objectを置かない。
11. algorithm load結果をversionとhash単位でcacheしてよいが、無期限の壊れたcacheを使わない。
12. offline時は該当algorithmだけを使用不能にし、自作algorithmは継続利用可能にする。

正常error例：

```js
{
  ok: false,
  error: {
    code: "ALGORITHM_UNAVAILABLE",
    message: "pixelmatch is unavailable",
    recoverable: true,
    details: {
      algorithm: "px",
      version: "7.2.0"
    }
  }
}
```

licenseはruntime CDNへ移しても無関係にはならない。次を必須とする。

* 採用versionのpackage `LICENSE`、`NOTICE`、package metadataを確認する。
* license名だけでなく、copyright表示とnotice義務を確認する。
* runtime dependencyごとにversion、URL、hash、license、copyright、source URLを記録する。
* `THIRD_PARTY_NOTICES.md`をrepositoryで管理する。
* Pages配布物にもnoticeが必要なlicenseの場合は、`public/THIRD_PARTY_NOTICES.txt`などを生成して含める。
* `coi-serviceworker.js`のMIT headerを保持する。
* build-only dependencyとruntime dependencyを区別する。
* copyleft、network copyleft、用途制限、field-of-use制限、独自条項があるlibraryは、明示的な採用判断なしに追加しない。
* license不明、license file欠落、package metadataとrepository license不一致の場合は採用を保留する。

MIT、BSD、ISC、Apache-2.0などであっても、versionごとに実ファイルを確認する。固定version CDNはsupply-chainと配信の再現性を改善するが、license義務を代替しない。

`package.json`へ入れるdependencyは、bundleするruntime dependencyまたはbuild dependencyだけとする。CDN専用algorithm libraryをnpm dependencyとして重複登録する必要はないが、versionとlicense metadataは別manifestで固定する。

## 8. module構成と責務
最低限、次の境界を独立moduleとして持つ。

```text
mcp-responder.js
error-codes.js
native-bridge.js
command-registry.js
operation-manager.js
breakpoint-owner-store.js
breakpoint-service.js
script-service.js
frame-service.js
input-service.js
webmcp.js
```

推奨構成は次のとおり。

```text
src/
  app.js
  state.js
  error-codes.js
  native-bridge.js
  mcp-responder.js
  command-registry.js
  command-context.js
  operation-manager.js
  webmcp.js
  emulation-loop.js
  rom-service.js
  save-service.js
  state-service.js
  input-service.js
  breakpoint-service.js
  breakpoint-owner-store.js
  script-service.js
  frame-service.js
  algorithm-loader.js
  external-algorithms.js
  frame-diff/
    index.js
    common.js
    pixelmatch.js
    histogram.js
    block.js
    edge.js
    ssim.js
  commands/
    system-commands.js
    file-commands.js
    input-commands.js
    memory-commands.js
    debugger-commands.js
    script-commands.js
    frame-commands.js
    wait-commands.js
  workers/
    persistent-script-worker.js
    eval-worker.js
    algorithm-worker.js
  ui/
    ui-elements.js
    ui-controller.js
    screen-visibility.js
    debugger-view.js
    script-view.js
```

すべてを最初から細かく分けすぎない。単に行数で分割せず、公開command、内部state、native wrapper、UI更新の依存方向を整理する。

## 9. entry point
単一entry pointは`src/app.js`とする。`src/app.js`は次だけを担当する。

1. DOM ready確認
2. module初期化
3. service生成
4. native初期化
5. WebMCP登録
6. UI event登録
7. main loop開始
8. top-level error表示

具体的なcommand実装を`src/app.js`へ残さない。

```js
import { createAppState } from "./state.js";
import { createNativeBridge } from "./native-bridge.js";
import { createMcpResponder } from "./mcp-responder.js";
import { createCommandRegistry } from "./command-registry.js";
import { registerWebMcp } from "./webmcp.js";
import { bindUi } from "./ui/ui-controller.js";
import { startEmulationLoop } from "./emulation-loop.js";

async function main() {
  const state = createAppState();
  const native = createNativeBridge(state);
  const responder = createMcpResponder({ state, native });
  const commands = createCommandRegistry({
    state,
    native,
    responder
  });

  await native.initialize();
  registerWebMcp({ commands, responder });
  bindUi({ state, commands });
  startEmulationLoop({ state, native });
}

void main();
```

実際の初期化順は現行`app.js`を確認して維持する。この例をそのままコピーして既存依存を壊してはならない。

## 10. 依存方向
依存方向は次とする。

```text
app
  -> webmcp
  -> ui
  -> command registry
      -> command handlers
          -> services
              -> native bridge
```

禁止する逆方向依存の例：

```text
native bridge -> UI
frame algorithm -> WebMCP
breakpoint store -> command registry
mcp responder -> frame service
worker source -> DOM
```

event通知が必要な場合はcallback、EventTarget、明示的subscriptionを使用する。global importによる循環依存を作らない。

各commandへ巨大なglobal stateを直接渡さず、必要なserviceだけをcontextへまとめる。

```js
const context = {
  responder,
  native,
  operationManager,
  breakpointService,
  scriptService,
  frameService,
  inputService,
  stateService,
  algorithmLoader,
  logger
};
```

## 11. global state
`window.DesmumeMCP`以外へ内部serviceを大量に公開しない。globalへ公開する必要があるAPIだけを明示的に設定する。

```js
window.DesmumeMCP = publicApi;
```

debug buildだけで次を公開してよい。

```js
window.__desmumeDebug = {
  stateSummary,
  listOperations,
  listBreakpointOwners
};
```

ROM bytes、State bytes、frame pixels、memory dump、Worker source、外部library objectをwindow globalへ公開しない。

現行のone-letter shortcutは互換性対象とする。main window上の`window.a()`～`window.Z()`は維持し、`desmume.eval`のWorker内では`window`へ依存せず、同じshortcut mappingを許可済み`mcp.call()`へ変換するWorker-local helperとして提供する。shortcutの引数順、default、戻り値を変えない。
なお現状ワーカーから呼び出せないが、これは対処する。

## 12. エラー処理の絶対原則
WebMCPまたは`window.DesmumeMCP`から呼ばれる操作は、errorを理由としてWebAssembly emulator instanceを破棄、再生成、page reload、resetしてはならない。

ROM未読込、State未読込、対象breakpointなし、screen invalid、timeout、operation競合、不正な引数、optional algorithm未ロードなど、事前に想定可能な失敗はC++例外またはJavaScript例外として扱わない。通常のcommand結果として返す。

```js
{
  ok: false,
  error: {
    code: "ROM_NOT_LOADED",
    message: "ROM is not loaded",
    recoverable: true
  }
}
```

成功結果は次の形式を基本とする。

```js
{
  ok: true,
  ...result
}
```

既存APIとの互換性上、成功結果へ直ちに`ok:true`を追加できない場合でも、失敗結果は必ず`ok:false`の定義済み形式へ統一する。

想定可能な失敗に対して、次を使用してはならない。

```js
throw new Error("ROM is not loaded");
Promise.reject(new Error("timeout"));
```

すべての正常errorは`mcp-responder.js`の共通helperを通す。

```js
function ok(data = {}) {
  if (Object.prototype.hasOwnProperty.call(data, "ok")) {
    return fail("INTERNAL_ERROR", "Result data must not override ok");
  }
  return {
    ok: true,
    ...data
  };
}

function fail(code, message, details = undefined) {
  return {
    ok: false,
    error: {
      code,
      message,
      recoverable: true,
      ...(details === undefined ? {} : { details })
    }
  };
}
```

command実装が直接`{ok:false,error:...}`を重複して書くことを禁止する。

## 13. error code
error codeは`src/error-codes.js`へ一元化し、文字列を各所へ直接書かない。

```js
export const ErrorCode = Object.freeze({
  WASM_NOT_READY: "WASM_NOT_READY",
  ROM_NOT_LOADED: "ROM_NOT_LOADED",
  STATE_NOT_LOADED: "STATE_NOT_LOADED",
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  UNKNOWN_COMMAND: "UNKNOWN_COMMAND",
  TIMEOUT: "TIMEOUT",
  BUSY: "BUSY",
  CANCELLED: "CANCELLED",
  SCREEN_INVALID: "SCREEN_INVALID",
  NO_WAITABLE_BREAKPOINTS: "NO_WAITABLE_BREAKPOINTS",
  BREAKPOINT_NOT_FOUND: "BREAKPOINT_NOT_FOUND",
  BREAKPOINT_NOT_WAITABLE: "BREAKPOINT_NOT_WAITABLE",
  BREAKPOINT_INTERRUPTED: "BREAKPOINT_INTERRUPTED",
  SCRIPT_PAUSED: "SCRIPT_PAUSED",
  SCRIPT_SOURCE_INVALID: "SCRIPT_SOURCE_INVALID",
  SCRIPT_COMPILE_ERROR: "SCRIPT_COMPILE_ERROR",
  SCRIPT_RUNTIME_ERROR: "SCRIPT_RUNTIME_ERROR",
  WORKER_START_FAILED: "WORKER_START_FAILED",
  WORKER_CRASHED: "WORKER_CRASHED",
  WORKER_PROTOCOL_ERROR: "WORKER_PROTOCOL_ERROR",
  SEQUENCE_NOT_FOUND: "SEQUENCE_NOT_FOUND",
  SEQUENCE_EXISTS: "SEQUENCE_EXISTS",
  FRAME_SNAPSHOT_NOT_FOUND: "FRAME_SNAPSHOT_NOT_FOUND",
  FRAME_SNAPSHOT_EXISTS: "FRAME_SNAPSHOT_EXISTS",
  ALGORITHM_UNAVAILABLE: "ALGORITHM_UNAVAILABLE",
  ALGORITHM_INTEGRITY_FAILED: "ALGORITHM_INTEGRITY_FAILED",
  NATIVE_ERROR: "NATIVE_ERROR",
  NATIVE_FAULT: "NATIVE_FAULT",
  INTERNAL_ERROR: "INTERNAL_ERROR"
});
```

同じ失敗に複数のcodeを使わない。messageの文面ではなくcodeで機械判定できるようにする。

### 13.1 任意JavaScriptとWorker errorの分類
`desmume.eval`、`desmume.runScript`、`injectScript`、persistent scriptは、入力、compile、runtime、Worker lifecycle、RPC protocolの失敗を区別する。これらはユーザー入力または隔離実行環境で想定可能な失敗であり、原則として`INTERNAL_ERROR`へ潰さない。

| error code | 条件                                                                                             |
| --- |--------------------------------------------------------------------------------------------------|
| `SCRIPT_SOURCE_INVALID` | sourceが文字列でない、空、上限超過、必須field欠落など、Worker生成前に判定できる入力不正          |
| `SCRIPT_COMPILE_ERROR` | quote、escape、括弧、template literalなどの誤りでparseまたはcompileできない                      |
| `SCRIPT_RUNTIME_ERROR` | compile後に`ReferenceError`、`TypeError`などが発生した。エラー内容と場所を正確に解析AIに伝える。 |
| `WORKER_START_FAILED` | `Blob`作成、Worker constructor、bootstrap、初期handshakeが完了しない                             |
| `WORKER_CRASHED` | 起動済みWorkerが`error`、`messageerror`、予期しない終了で失われた                                |
| `WORKER_PROTOCOL_ERROR` | Worker messageのshape、request ID、RPC名、payloadが不正または未許可                              |

`hogehoge`のような文字列はJavaScriptとして構文上有効であるため、「コードではない」とheuristic判定して拒否しない。実行して`ReferenceError: hogehoge is not defined`になった場合は`SCRIPT_RUNTIME_ERROR`とする。

compile errorでは、どこが壊れているかを修正できる情報を返す。

```js
{
  ok: false,
  error: {
    code: "SCRIPT_COMPILE_ERROR",
    message: "Script could not be compiled",
    recoverable: true,
    details: {
      phase: "compile",
      errorName: "SyntaxError",
      line: 12,
      column: 27,
      sourceName: "eval-worker-user-script.js",
      sourceExcerpt: "return `value=${result};"
    }
  }
}
```

`line`、`column`は取得可能な場合に返す。Worker wrapperによってlineがずれる場合は、user source開始lineを補正する。`sourceExcerpt`は該当行付近だけを短く返し、script全文、ROM、Save、State、memory内容を含めない。browserが位置を返さない場合も、`errorName`と短いmessageは保持する。

runtime errorでは、少なくとも`errorName`、message、可能ならuser source基準のline、column、短いstack先頭だけを`details`へ入れる。通常MCP textへ巨大なstackを出さず、完全なstackはlocal debug logだけに残す。

script compile/runtime error、Worker start failure、Worker crashでは、そのWorker、pending RPC、operation lock、timer、Blob URLだけをcleanupする。WASM instance、ROM buffer、user breakpoint、analysis baseline、ほかのpersistent scriptを破棄しない。scriptが明示的にemulatorをpauseした場合を除き、単なるcompile errorを理由にemulator lifecycleを変更しない。

## 14. `mcp-responder.js`
`mcp-responder.js`はすべての公開command結果を統一する。

担当するもの：

* `ok:true`結果生成
* `ok:false`結果生成
* error code正規化
* native result code変換
* timeout結果
* cancellation結果
* unexpected exceptionの捕捉
* WebMCP向けcontent整形
* compact text生成

担当しないもの：

* emulator操作
* breakpoint操作
* frame比較
* input操作
* UI更新

```js
export function createMcpResponder({
  logger,
  pauseSafely
}) {
  return {
    ok,
    fail,
    fromNative,
    runSafely,
    toWebMcpContent,
    normalizeResult
  };
}
```

`runSafely`は最後の安全網としてのみ使う。

```js
async function runSafely(commandName, task) {
  try {
    const result = await task();
    return normalizeResult(result);
  } catch (error) {
    logger.error(commandName, error);
    pauseSafely();
    return fail(
      ErrorCode.INTERNAL_ERROR,
      `${commandName} failed internally`
    );
  }
}
```

ROM未読込、timeout、引数不正を例外へしてから`runSafely`で捕捉する設計は禁止する。

内部stack traceはlocal debug logへだけ記録する。通常のMCP出力へ巨大なstack traceを返さない。

予期しない失敗時も次を行ってはならない。

* page reload
* WASM module再生成
* ROM自動reload
* State自動復元
* browser storage消去
* breakpoint全消去

安全のためpauseすることは許可する。

## 15. C++側errorと`native-bridge.js`
C++側の不可能操作は例外を投げず、定義済みresult codeを返す。

```cpp
enum WasmResult {
  WASM_OK = 0,
  WASM_ERR_ROM_NOT_LOADED = -1,
  WASM_ERR_INVALID_ARGUMENT = -2,
  WASM_ERR_STATE_INVALID = -3,
  WASM_ERR_BUFFER_TOO_SMALL = -4,
  WASM_ERR_INTERNAL = -99
};
```

ROM未読込など通常起こり得る状態に`WASM_ERR_INTERNAL`を使わない。C++のcatch節は最後の安全網として残すが、C++例外をJavaScript境界へ伝播させない。

native fault発生時も、可能な限りWASM moduleとROM bufferを保持する。`paused=true`、`execute=false`として停止し、`status`、`reset`、`reloadRom`、diagnostic操作を引き続き呼べるようにする。

WASM exportの直接呼び出しは`native-bridge.js`へ集約する。

担当するもの：

* `cwrap`
* native pointer取得
* native result code解釈
* native string JSON parse
* native fault検出
* typed array view生成
* native function存在確認

command層から`state.fns.xxx`を直接呼ばない。

```js
const result = native.captureFrameBuffer();
if (!result.ok) return result;
```

command側へ生の`-1`、`-2`、`-99`を渡さない。`cwrap`呼び出しで予期しない例外が起きた場合はbridge内で捕捉し、`NATIVE_FAULT`へ変換する。WASM moduleを再生成しない。

## 16. command registry
command名とhandlerは`command-registry.js`で管理し、巨大な`switch`を作らない。

```js
registry.register("status", systemCommands.status);
registry.register("waitForBreak", waitCommands.waitForBreak);
registry.register("waitForScreenChange", waitCommands.waitForScreenChange);
```

実行例：

```js
async function execute(name, params = {}) {
  const handler = handlers.get(name);
  if (!handler) {
    return responder.fail(
      ErrorCode.UNKNOWN_COMMAND,
      `Unknown command: ${name}`
    );
  }
  return responder.runSafely(
    name,
    () => handler(params)
  );
}
```

command descriptionとschemaはhandlerから分離して管理してよいが、巨大な`apiDescriptions` objectと実handlerが離れすぎないようにする。推奨はcommand定義とdescriptionを同じmoduleに置くことである。

## 17. WebMCP境界
`webmcp.js`はWebMCP tool登録だけを担当する。

* `desmume.list`
* `desmume.call`
* `desmume.eval`
* `desmume.runScript`

command実装を持たない。

```js
execute: async (input) => {
  const parsed = parseInput(input);
  if (!parsed.ok) {
    return responder.toWebMcpContent(parsed);
  }
  const result = await commands.execute(
    parsed.command,
    parsed.params
  );
  return responder.toWebMcpContent(result);
}
```

`desmume.call`、`desmume.eval`、`desmume.runScript`でerror形式を統一する。`desmume.call`だけ例外を伝播し、`desmume.eval`だけJSON文字列へ変換する状態を残さない。

`desmume.eval`内の`mcp.call()`も、想定可能なerrorではPromiseをrejectしない。

```js
const result = await mcp.call("waitForBreak", {
  timeoutMs: 30000
});
if (!result.ok) return result;
```

eval script自身のsyntax error、runtime error、Worker起動失敗、Worker crash、Worker RPC不正は最外周で捕捉し、13.1の専用errorへ変換する。これらを一律`INTERNAL_ERROR`へしない。Worker timeoutもtransport rejectではなく通常error resultとする。

壊れたinputをページ内で正常errorへ変換できる範囲では`INVALID_ARGUMENT`へ変換する。Chrome DevTools MCPがページへ到達する前に拒否した壊れたJSONは対象外である。

## 18. WebMCP transportとcompact表示
アプリケーションが定義した失敗は、Chrome DevTools MCPの`execute_webmcp_tool`上でもWebMCP tool実行成功として返す。

期待する外側の状態：

```text
WebMCP status: success
WebMCP errorText: empty
output: ok=falseを含む通常結果
```

`isError:true`は、transport失敗、page消失、tool未登録など、applicationが正常応答できなかった場合に限定する。

`toWebMcpContent()`はtransport形式だけを担当する。

```js
function toWebMcpContent(result) {
  return {
    content: [
      {
        type: "text",
        text: formatCompactResult(result)
      }
    ],
    structuredContent: result
  };
}
```

通常結果は短くする。

```text
ok=true
pc=0x021e54fc
hits=10
```

```text
ok=false
error.code=TIMEOUT
error.message=waitForBreak timed out
```

`details`は必要最小限だけ出す。debug mode以外でstack trace、全breakpoint一覧、全script一覧、全tile scoreを返さない。

現行`app.js`にあるtoken節約用のcompact formatterを正本として扱う。module分割時は、既存のfield選別、数値やaddressの短縮、配列件数制限、長文省略、error要約を先にそのまま移し、同等性testを通してから整理する。`formatCompactResult`相当を単純な`JSON.stringify(result)`へ置き換えない。

`structuredContent`はobjectのまま返し、`content[0].text`だけをcompact textにする。JSON文字列をresult fieldへ入れ、そのobject全体を再びJSON化する多重JSONを禁止する。`desmume.call`、`desmume.eval`、`desmume.runScript`、message transport、one-letter shortcutで同じcompact方針を維持する。

## 19. 長時間operationの排他制御
次のcommandは同時に1つだけ実行できる。

* `waitForBreak`
* `runUntil`
* `runInputSequence`
* `waitForScreenChange`

JS stateへ、少なくとも次を追加する。

```js
activeOperation: null,
operationSerial: 0,
breakSerial: 0,
completedFrameSerial: 0,
screenValid: false,
framesSinceStateLoad: 0,
stateLoadSerial: 0,
frameSnapshots: new Map(),
inputSequences: new Map()
```

`activeOperation`は次の情報を持つ。

```js
{
  id,
  name,
  startedAt,
  abortController
}
```

別の長時間operationが実行中の場合、待機せず即座に`BUSY`を返す。

```js
{
  ok: false,
  error: {
    code: "BUSY",
    message: "Active operation is waitForScreenChange",
    recoverable: true
  }
}
```

長時間operation内で重複した`setInterval`を複数作らない。可能な限り、既存frame loopとbreak通知からPromiseを解決する。

## 20. `operation-manager.js`
長時間operationの排他制御、timeout、cancel、cleanupを一元管理する。各commandが独自に`activeOperation`を操作してはならない。

```js
return operationManager.run({
  name: "waitForBreak",
  timeoutMs,
  task: async (operation) => {
    // operation.signal、operation.idを使用する
  },
  cleanup: async () => {
    await inputService.releaseAll();
  }
});
```

operation manager自身はtransport例外を投げず、正常error resultを返す。

cleanupは成功、timeout、cancel、internal failureのすべてで一度だけ実行する。

```js
let cleaned = false;
async function cleanupOnce() {
  if (cleaned) return;
  cleaned = true;
  // timer、listener、temporary owner、inputを解除する
}
```

終了時は必要に応じて次を行う。

* timer解除
* event listener解除
* temporary breakpoint解除
* temporary watchpoint解除
* `activeOperation`解除
* 全button release
* touch release
* Worker terminate
* Blob URL revoke
* 必要に応じてpause

## 21. timeout
次のcommandでは`timeoutMs`を必須にする。

* `waitForBreak`
* `runUntil`
* `waitForScreenChange`

`timeoutMs`を省略した場合は即時`INVALID_ARGUMENT`を返す。0以下、非数、上限超過も`INVALID_ARGUMENT`とする。上限は実装上安全な値を決めて`API.md`へ記載する。推奨上限は10分だが、WebMCP runner側timeoutとの整合を確認する。

初期指示にあった「timeout時はErrorをthrowする」は撤回する。timeoutは通常の失敗結果として返す。

```js
{
  ok: false,
  error: {
    code: "TIMEOUT",
    message: "waitForBreak timed out",
    recoverable: true,
    details: {
      timeoutMs: 30000
    }
  }
}
```

timeout時は次を保証する。

* emulatorはpause
* operation lock解除
* timer解除
* listener解除
* temporary breakpoint解除
* temporary watchpoint解除
* 全button release
* touch release
* fixed baseline snapshotは保持
* WebAssembly instanceは保持
* ROM bufferは保持
* 次のcommandを直ちに実行可能

`Promise.race()`だけでtimeoutを実装し、裏側のtaskを動かし続けてはならない。AbortController、operation token、Worker terminateなどで実処理も停止する。

## 22. cancellation
長時間operation中に、ユーザーまたは別commandが明示的に次を実行した場合、現在operationを安全に中断する。

* pause
* reset
* reloadRom
* ROM load
* State load
* Save loadによるreset
* page unload
* user cancel

cancellation reasonは次の正規形を使用する。

```text
pause
state-load
rom-load
reset
page-unload
user-cancel
```

通常error例：

```js
{
  ok: false,
  error: {
    code: "CANCELLED",
    message: "waitForScreenChange was cancelled",
    recoverable: true,
    details: {
      reason: "state-load"
    }
  }
}
```

State loadやreset自体は、現在operationを安全にcancelした後で続行してよい。通常のmutating commandをoperation中に呼んだ場合は、明示的な中断command以外を`BUSY`で拒否する。無断で並行実行してはならない。

## 23. breakpointの所有権
同一CPU、種類、addressのbreakpointを単一項目として置換してはならない。native側では同じsiteを1件にまとめてよいが、JavaScript側では論理ownerを複数保持する。

```js
{
  key: "arm9:exec:021e54fc",
  cpu: "arm9",
  type: "exec",
  address: 0x021e54fc,
  owners: [
    {
      id: 12,
      origin: "user"
    },
    {
      id: 31,
      origin: "script",
      scriptId: 4,
      triggerId: 8
    },
    {
      id: 42,
      origin: "operation",
      operationId: 7
    }
  ]
}
```

originは少なくとも次を持つ。

```text
user
script
operation
```

ownerを1件削除しても、ほかのownerが残る場合はnative breakpointを解除しない。native breakpointはownerが0件になった場合だけ解除する。

persistent scriptが通常breakpointと同じsiteへtriggerを追加しても、通常breakpointのID、所有権、待機対象性を失わせてはならない。

## 24. `breakpoint-owner-store.js`
同一siteの複数ownerを管理し、native breakpointと論理breakpointを分離する。

```js
function breakpointSiteKey({ cpu, type, address }) {
  return `${cpu}:${type}:${address >>> 0}`;
}
```

owner構造：

```js
{
  id,
  origin: "user" | "script" | "operation",
  scriptId,
  triggerId,
  operationId,
  enabled
}
```

最低限のAPI：

```text
addOwner(site, owner)
removeOwner(site, ownerId)
getSite(siteKey)
getOwners(siteKey)
classifySite(siteKey)
hasWaitableBreakpoints(options)
findBreakpointById(id)
```

owner数が0から1になった時だけnative breakpointを追加する。owner数が1から0になった時だけnative breakpointを削除する。同一siteへowner追加するたびにnativeへ重複登録しない。

既存breakpoint UIでは、userまたはMCPから明示的に追加されたbreakpointを表示し、persistent script内部だけのownerはdefaultでfilterする。mixed ownerのsiteはuser-visibleとして表示する。script ownerの詳細はdebug表示または専用script viewでだけ確認できるようにし、通常一覧を高頻度triggerで埋めない。

## 25. breakpoint分類
break発生時にsiteを次へ分類する。

```text
script-only:
  有効ownerがすべてorigin=script
user-visible:
  origin=userが1件以上ある
operation:
  origin=operationが1件以上ある
mixed:
  scriptとuserまたはoperationの両方がある
```

mixedはscript-onlyとして扱わない。通常breakpointとpersistent script triggerが同じaddressにある場合、待機commandから見れば通常breakpointとして扱う。同時にpersistent script callbackも実行する。

## 26. break event
nativeの`lastBreak`だけで新旧を判定しない。単調増加するserialを追加する。

```text
nativeBreakSerial:
  すべてのnative breakで増加
```

`breakpoint-service.js`は次のeventを生成する。

```js
{
  serial: 182,
  cpu: "arm9",
  type: "exec",
  address: 0x021e54fc,
  size: 4,
  value: 0,
  pc: 0x021e54fc,
  cpsr: 0x6000001f,
  owners: {
    user: [12],
    script: [31],
    operation: []
  },
  scriptOnly: false,
  userVisible: true,
  operationOwned: false
}
```

待機commandはevent serialとowner分類を使い、`paused`だけで成功判定しない。native `lastBreak`を各commandが直接pollしない。

breakpoint serviceはfilter付きsubscriptionを提供する。

```js
breakpointService.waitForEvent({
  afterSerial,
  scriptBreakpoints: "ignore",
  signal
});
```

script-only判定、mixed owner判定、待機対象判定を各wait commandへ重複実装しない。

## 27. script-only breakpointの扱い
次の待機系commandはdefaultでscript-only breakpointを完全に無視する。

* `waitForBreak`
* `runUntil`
* `waitForScreenChange`

default：

```js
{
  scriptBreakpoints: "ignore"
}
```

必要な場合だけ次で含める。

```js
{
  scriptBreakpoints: "include"
}
```

script-only breakpointがhitしても、defaultでは次を行わない。

* 待機成功にしない
* hit回数を増やさない
* 結果へ返さない
* fixed frame baselineを更新しない
* screen comparisonの連続成功回数をresetしない
* timeout時計をresetしない

persistent script callbackは従来どおり実行する。callback終了後は安全にbreakpointから抜け、待機operationを継続する。

script-only breakpoint hitそのものは無視するが、callbackが明示的に`pause`を実行した場合、その意図を待機commandが上書きしてはならない。

```js
{
  ok: false,
  error: {
    code: "SCRIPT_PAUSED",
    message: "A persistent script explicitly paused the emulator",
    recoverable: true,
    details: {
      scriptId: 4
    }
  }
}
```

自動的にresumeしてscriptの明示pauseを無効化しない。

## 28. script-only read/write breakpoint
現在の自動再開がexec専用なら、read/writeを含めて検証する。script-only read/write breakpointでも待機operationが停止し続けてはならない。ただし、access命令を二重実行してはならない。

次を実測してから実装する。

* breakpoint hook時点で命令は完了済みか
* PCはaccess命令自身か次命令か
* write side effectは完了済みか
* read先registerは更新済みか
* `next_instruction`はどこを指すか
* 一命令stepすると同じwriteを再実行しないか

実測結果に応じ、次のいずれかを実装する。

```text
A. 命令完了済みなら、そのままresume
B. 命令未完了なら、対象watchpointだけ一時解除して残りを実行
C. 安全に判別できない場合はnative側へnon-stopping observerを追加
```

推測でread/write命令を再実行しない。

## 29. `script-service.js`
`script-service.js`は次を担当する。

* persistent script lifecycle
* trigger owner登録
* callback実行
* script print
* script explicit pause検出
* trigger cleanup
* Worker生成、terminate、Blob URL revoke

script serviceはnative breakpointを直接操作せず、breakpoint serviceへscript ownerを登録する。

複数のpersistent scriptは同時稼働を許可し、script ID、trigger owner、print buffer、Worker lifecycleを個別管理する。1つのscriptのcompile error、runtime error、stop、restart、queue backlogを理由に、ほかのscriptを停止または再生成しない。

script callback中のpauseは、通常のscript-only breakpoint自動再開と区別する。

```js
{
  explicitlyPaused: true,
  scriptId
}
```

wait commandへ`SCRIPT_PAUSED`として通知する。

## 30. Stateロード後の画面有効性
Stateロード直後は、native実行状態と画面取得用framebufferが一致しない場合がある。Stateをロードしただけでは、screenshot、frame capture、frame compare、screen wait用のframeを有効とみなしてはならない。`captureFrameBuffer()`が成功しただけでもAPI用frameを有効とみなしてはならない。

API用frameの有効性と、ユーザーへ最後に表示したcanvasを分離する。`screenValid === false`は画面取得APIが現在frameを信用できないことを表し、既に表示済みの最後の正常frameまで消す指示ではない。

`state-service.js`は次を担当する。

* save state
* load state
* analysis baseline
* recent state reload
* State bytes import
* State URL load
* State load前のoperation cancellation
* State load成功後のframe invalidation

State load処理はUI、WebMCP、baseline restore、recent file reloadから共通serviceを通す。

Stateロード後に少なくとも1回、正常なemulator frameが完了し、native frame counterが増えたことを必要条件とする。

次の処理がStateをロードした場合、必ず画面を無効化する。

* `loadState`
* `loadStateBytes`
* `loadStateUrl`
* `importStateFile`
* `reloadRecentFile`でStateをロードした場合
* `restoreAnalysisBaseline`
* その他、内部的にsavestateを復元する処理

State load成功後に次を設定する。

```js
state.screenValid = false;
state.framesSinceStateLoad = 0;
state.stateLoadSerial++;
```

Stateロード失敗時に現在画面を不必要にinvalid化しない。順序は、既存operationを安全にcancelしてからStateをロードし、成功後にscreenをinvalid化する。

## 31. 画面を有効にする条件
Stateロード後に`runFrame`または`runFrames`が実際に1 frame完了し、native frame counterが増えた場合だけ有効化する。

```js
state.framesSinceStateLoad++;
state.completedFrameSerial++;
state.screenValid = true;
```

次の場合はAPI用frameを有効化しない。

* breakpointによりframe完了前に停止
* native fault
* ROM未ロード
* pause中でframeが進んでいない
* CPU命令の`step`だけを実行した
* `captureFrameBuffer()`だけを呼んだ
* canvasへ最後の画像を再描画しただけ

native frame counterの増加を確認する。現在のnative実装が、同じexec breakpointへ即座に再trapした場合にframe counterを増やさない挙動を利用してよい。

breakpointへhitしたこと自体をframe完了として数えず、frame counterを加算しない。counterは実際のframe完了だけを表し、debug停止回数、CPU step回数、break event数を混ぜない。

ただし、breakpointでframe完了前に停止した場合も、UI canvasは直前に正常描画できたframeを保持して表示する。breakpoint hitを理由にcanvasをblank、hide、clearしてはならない。これにより、ユーザーは停止中も直前のゲーム画面を目視できる。API用frameは引き続きinvalidのままとし、古い表示frameを新しいcapture結果として返さない。

## 32. UIでのscreen invalid表示
`screenValid === false`の間は、invalidなnative framebufferをcanvasへ上書きしない。既に最後の正常frameが表示されている場合は、そのcanvasをそのまま表示する。初回起動などで正常frameが一度もない場合だけ、既存のplaceholderまたはstatus領域を再利用する。screen invalid専用の新しいpanelや起動時DOMを追加しない。

UIは仕様書ではない。`screenValid`、frame serial、state load generation、native framebufferなどの内部状態をUIへ逐語的に表示しない。説明は、AIまたはユーザーが何を期待できるか、どのcontrolを操作するか、次に何をすべきかに限定する。

必要な案内文は既存status領域へ短く表示する。例：

```text
画面を更新するには実行を再開してください。
```

breakpoint停止中は、直前の正常frameを見られることを優先し、この案内のためにcanvasを隠さない。

UIから次の機能を一時的に非表示または無効化する。

* screenshot
* frame capture
* frame compare
* screen change wait

WebMCP側では単に非表示にせず、必ず通常errorを返す。

```js
{
  ok: false,
  error: {
    code: "SCREEN_INVALID",
    message: "Run at least one complete frame after loading State",
    recoverable: true
  }
}
```

画面invalid時にerrorとするAPI：

* `captureFrame`
* `compareFrame`
* `waitForScreenChange`
* `takeScreenshot`
* 範囲preview生成
* その他、現在framebufferを正しい現在画面として扱う操作

## 33. `frame-service.js`と`emulation-loop.js`
`frame-service.js`は次を担当する。

* `screenValid`
* State load世代
* completed frame serial
* native framebuffer capture
* JS側frame copy
* snapshot保存
* comparison
* screen change wait
* canvas visibility通知

UI描画と比較ロジックを分離する。State serviceはframe serviceへ通知する。

```js
frameService.invalidateAfterStateLoad();
```

`emulation-loop.js`はrequestAnimationFrame、speed budget、`runFrame`、render更新、audio、frame完了通知、break検出を担当する。frame comparisonやwait conditionを直接実装しない。

```js
const before = native.getFrameCount();
const result = native.runFrame(...);
const after = native.getFrameCount();

if (result.ok && after > before) {
  frameService.onFrameCompleted({
    frame: after
  });
}
```

`waitForScreenChange`はこの通知を購読し、独自に`runFrame()`を呼ばない。

## 34. `waitForBreak`
公開API：

```js
waitForBreak({
  timeoutMs: 30000,
  scriptBreakpoints: "ignore"
})
```

`timeoutMs`は必須。`scriptBreakpoints`はdefaultで`ignore`のため通常呼び出しでは省略してよい。

defaultの`waitForBreak`は、script-onlyを除いた有効breakpointが1件以上必要である。0件ならresumeせず、直ちに返す。

```js
{
  ok: false,
  error: {
    code: "NO_WAITABLE_BREAKPOINTS",
    message: "No non-script breakpoints are enabled",
    recoverable: true
  }
}
```

数える対象：

* user exec breakpoint
* user read breakpoint
* user write breakpoint
* user special breakpoint

数えない対象：

* script-only breakpoint
* 停止中scriptのtrigger
* 無効breakpoint
* operation用temporary breakpoint

`scriptBreakpoints:"include"`の場合はscript breakpointも事前条件へ含めてよい。

動作：

1. operation lockを取得する。
2. 現在のbreak serialを記録する。
3. 現在停止しているbreakpointから安全に抜ける。
4. resumeする。
5. 新しいbreak event serialを待つ。
6. defaultではscript-only eventを無視してcallback後に継続する。
7. user-visibleまたは対象eventでpauseする。
8. compact結果を返す。

古い`lastBreak.hit`を新しいbreakと誤認しない。`clearBreakStatus`だけに依存しない。

通常結果：

```json
{
  "ok": true,
  "cpu": "arm9",
  "type": "exec",
  "address": "0x021e54fc",
  "pc": "0x021e54fc"
}
```

`verbose:true`の場合だけ、`cpsr`、`size`、`value`、`breakSerial`、`frame`、owner分類を追加してよい。

### 34.1 現在のbreakpointから抜ける処理
現在PCにexec breakpointがある場合、既存step処理と同様に、そのbreakpointの該当owner/siteだけを一命令分一時解除してから復元する。

必要なら内部helperを追加する。

```text
resumePastCurrentBreak
```

処理：

1. 現在hitしたsiteだけ一時的にnativeから解除する。
2. 現在命令を1命令実行する。
3. native breakpointを復元する。
4. 他のbreakpointがhitした場合はそのbreakを保持する。
5. 問題なければresumeする。

全breakpointをまとめて解除してはならない。read/write breakpointは第28節の実測結果に基づいて処理する。

## 35. `runUntil`
`runUntil`は条件成立まで実行し、成立した時点でpauseする。1回の呼び出しで指定できる終了条件は原則1種類に限定する。複雑な複合条件は具体的な必要性が出るまで実装しない。

### 35.1 PC到達
```js
runUntil({
  timeoutMs: 30000,
  pc: "021e54fc"
})
```

内部的にoperation ownerのtemporary exec breakpointを使用してよい。既存breakpointと同じaddressの場合、重複登録や削除事故を起こさない。呼び出しが追加したownerだけを終了時に解除する。

`runUntil({pc})`は自身でtemporary breakpointを作るため、既存user breakpointが0件でも実行できる。

戻り値：

```json
{
  "ok": true,
  "pc": "0x021e54fc",
  "frames": 42
}
```

### 35.2 breakpoint hit回数
```js
runUntil({
  timeoutMs: 30000,
  bp: 12,
  hits: 10,
  scriptBreakpoints: "ignore"
})
```

`bp`は既存論理breakpoint IDである。指定IDが存在しない場合は`BREAKPOINT_NOT_FOUND`を返す。script-only breakpointをdefault設定で指定した場合は`BREAKPOINT_NOT_WAITABLE`を返す。`scriptBreakpoints:"include"`なら対象にしてよい。

`hits`はこの`runUntil`開始後に発生した対象eventだけを数える。過去hit countを含めない。Stateロード時刻そのものを暗黙に記憶する必要はなく、呼び出し開始時点を0回目とする。

途中の1～9回目は、対象breakpointから安全に抜けて自動継続する。10回目でpauseし、結果を返す。

```json
{
  "ok": true,
  "bp": 12,
  "hits": 10,
  "pc": "0x021e54fc"
}
```

timeout resultには到達回数を含める。

```js
{
  ok: false,
  error: {
    code: "TIMEOUT",
    message: "runUntil timed out",
    recoverable: true,
    details: {
      timeoutMs: 30000,
      hits: 7,
      expectedHits: 10
    }
  }
}
```

### 35.3 `valueChanged`
`valueChanged`条件は採用候補とするが、初回実装の必須対象から外してよい。不正確なframe polling実装を入れて完了扱いにしてはならない。

正確な実装には次が必要である。

* 初期値取得
* write breakpoint
* 同値書き込み除外
* current write instructionからの安全な継続
* old valueとnew valueの比較
* temporary watchpointの確実な復元
* 一瞬だけ変わって同frame内で戻る値の検出

API候補：

```js
runUntil({
  timeoutMs: 30000,
  changed: ["020f8e68", 4]
})
```

現在の主目的を`bp + hits`で満たせる場合は、先にそちらを完成させる。`valueChanged`をframe単位のmemory readだけで代用しない。

## 36. `runInputSequence`
複数の入力操作を一つのcommandで再現可能に実行する。同じsequenceをIDで保存し、以後はIDだけで再利用できるようにする。stepは短いtuple形式にする。

初回登録と実行：

```js
runInputSequence({
  id: "menu-open",
  seq: [
    ["t", "A", 2],
    ["w", 300],
    ["s", "A", 5000],
    ["hf", "Up", 2]
  ]
})
```

ID再利用：

```js
runInputSequence({
  id: "menu-open"
})
```

同じIDへ異なる`seq`を渡す場合は`replace:true`を必須にする。

```js
runInputSequence({
  id: "menu-open",
  replace: true,
  seq: [
    ["t", "A", 1]
  ]
})
```

既存IDがある状態で`replace:true`なしに異なるsequenceを渡した場合は`SEQUENCE_EXISTS`を返す。IDだけを指定して未登録の場合は`SEQUENCE_NOT_FOUND`を返す。

### 36.1 compact opcode
最低限、次を実装する。

```text
["t", button, count]
["s", button, durationMs]
["h", button, durationMs]
["hf", button, frames]
["w", durationMs]
["wf", frames]
["x", x, y, durationMs]
```

意味：

| Opcode | 意味 |
| --- | --- |
| `t` | tapを指定回数実行 |
| `s` | 指定時間、連打し続ける |
| `h` | 指定時間、押し続ける |
| `hf` | 指定frame数、押し続ける |
| `w` | 実時間待機 |
| `wf` | emulator frame待機 |
| `x` | 指定座標を指定時間touch |

`count`を省略した`t`は1回とする。

```js
["s", "A", 5000]
```

複数button：

```js
["h", "Up+A", 500]
["hf", "Left+B", 2]
```

button文字列を`+`で分割する。未知buttonは開始前validationでerrorにする。sequence全体を事前validationし、途中まで実行してから未知buttonへ到達しないようにする。

### 36.2 tap timing
tapのhold、gap defaultは既存`runInputTap`と整合させる。sequence全体へ一度だけ指定できる。

```js
runInputSequence({
  id: "menu-open",
  tap: [40, 50],
  seq: [
    ["t", "A", 2]
  ]
})
```

`tap[0]`は`holdMs`、`tap[1]`は`gapMs`である。

### 36.3 保存
保存先はversion付きlocalStorageとする。

```text
desmume-input-sequences-v1
```

保存内容にはversionを含める。壊れたJSONや未知versionは無視または明示的errorとし、勝手に実行しない。

storage schemaを初めて更新する場合は、専用version markerを確認し、旧input-sequence keyだけを一度clearまたはmigrationする。`localStorage.clear()`でほかの設定、recent file、baseline、UI preferenceまで消してはならない。

管理APIを追加してよい。

```text
listInputSequences
deleteInputSequence
```

### 36.4 実行終了時
成功、timeout、breakpoint、native fault、cancelのすべてで必ず次を行う。

* 全DS buttonをrelease
* touchをrelease
* temporary listener解除
* operation lock解除

入力が押しっぱなしのまま残ってはならない。成功時は原則として呼び出し前のpause状態へ戻す。呼び出し前がpauseなら実行後もpause、runningなら実行後もrunningとする。error時は安全のためpauseする。

## 37. `input-service.js`
`input-service.js`は次を担当する。

* button press、release
* touch
* tap
* spam
* frame hold
* sequence保存
* sequence validation
* sequence execution
* release all

`runInputSequence` handler内へ入力実行詳細を書かない。

```js
async function releaseAll() {
  releaseAllButtons();
  releaseTouch();
}
```

compact opcodeのparse、validation、executionを分離する。

```js
parseSequence(raw)
validateSequence(sequence)
executeSequence(sequence, operation)
```

## 38. raw frame capture
比較用frameはcanvas screenshotから取得しない。PNG encode、decodeを通さない。DOM screenshotを使わない。nativeの`captureFrameBuffer()`で表示bufferを更新し、WASM heapからJS側へcopyする。

native framebufferへのviewをMapへ直接保存してはならない。native bufferは後続frameで書き換えられる。必ず新しい`Uint32Array`へcopyする。

```js
function captureCurrentFramePixels() {
  const valid = frameService.requireValidScreen();
  if (!valid.ok) return valid;

  const captured = native.captureFrameBuffer();
  if (!captured.ok) return captured;

  const source = native.getFrameBufferView();
  return responder.ok({
    pixels: new Uint32Array(source)
  });
}
```

実際のpointer取得、byte offset、buffer layoutは現在の描画処理を確認し、既存実装と同じ方法を使う。上下画面の並びを推測しない。

## 39. `captureFrame`とsnapshot管理
公開API：

```js
captureFrame({
  id: "menu-base"
})
```

同じIDが存在する場合は`replace:true`を必須にする。

```js
captureFrame({
  id: "menu-base",
  replace: true
})
```

保存内容：

```js
{
  id,
  pixels,
  width: 256,
  height: 384,
  frame,
  stateLoadSerial,
  createdAt
}
```

最大保存数を決める。推奨は16枚。上限超過時に無断で重要snapshotを削除せず、errorまたは明示的LRU方針を`API.md`へ記載する。

同名IDの無断上書きは`FRAME_SNAPSHOT_EXISTS`、存在しないID参照は`FRAME_SNAPSHOT_NOT_FOUND`を返す。

管理API：

```text
listFrameSnapshots
deleteFrameSnapshot
```

## 40. 共通比較領域
`screen`は次を指定可能にする。

```js
screen: "top"
screen: "bottom"
screen: "both"
```

defaultは`both`。`top`、`bottom`指定時のregion座標は、そのscreen内の0～255、0～191とする。`both`の場合は0～255、0～383とする。

region形式：

```js
region: [x, y, width, height]
```

指定しない場合はscreen全体。範囲外、負数、0 sizeは`INVALID_ARGUMENT`とする。暗黙のclipで入力ミスを隠さない。

共通除外矩形：

```js
ignoreRects: [
  [0, 0, 32, 32],
  [180, 120, 60, 40]
]
```

動くicon、時計、常時animation領域などを除外する。`ignoreRects`の座標系はregion相対ではなく、選択screen内の絶対座標へ統一する。

## 41. frame差分algorithm共通仕様
少なくとも次のalgorithm IDを実装する。

```text
px
hist
blk
edge
```

追加候補：

```text
px-window
ssim-trim
```

公開APIでは短いIDを正規形とする。

```text
px        = pixel ratio
px-window = local pixel density
hist      = luminance histogram
blk       = robust block layout
edge      = robust edge layout
ssim-trim = tiled SSIM with top-tile trimming
```

全algorithmは0～100の`pct`を返す。ただし意味はalgorithmごとに異なる。

* `px`: 変化したpixelの割合
* `px-window`: 高密度差分windowの割合または最大密度を正規化した値
* `hist`: histogram距離を0～100へ正規化した値
* `blk`: trim後のblockのうち、変化したblockの割合
* `edge`: trim後のedge blockのうち、変化したblockの割合
* `ssim-trim`: trim後にthreshold以上となったtileの割合

algorithm間で同じthresholdを使い回してはならない。defaultと推奨範囲を`API.md`へalgorithm別に記載する。

native framebufferはopaque RGBとして扱う。alpha channelは比較対象外とする。

`compareFrame`は保存済みsnapshotを変更しない。`waitForScreenChange`は開始時frame Aを一度だけcaptureし、B、C、DをすべてAと比較する。Bを新baselineにしない。CをBと比較しない。DをCと比較しない。

## 42. frame-diff module interface
差分algorithmを`frame-service.js`へ直接書かない。共通interfaceを定義する。

```js
export async function compare({
  baseline,
  current,
  width,
  height,
  region,
  ignoreRects,
  options,
  signal
}) {
  return {
    ok: true,
    pct,
    debug
  };
}
```

registry：

```js
const algorithms = new Map([
  ["px", pixelDiff],
  ["px-window", pixelWindowDiff],
  ["hist", histogramDiff],
  ["blk", blockDiff],
  ["edge", edgeDiff],
  ["ssim-trim", ssimTrimDiff]
]);
```

未知algorithmは`INVALID_ARGUMENT`とする。CDN library loadingは対応algorithm moduleと`algorithm-loader.js`へ閉じ込める。pixelmatchやSSIM libraryが使えなくても、`hist`、`blk`、`edge`は使用可能にする。

## 43. `px`と`px-window`
`px`は静的UI、暗転、画面全体の明確な変化を検出する。animationには敏感である。

自作実装または固定versionのpixelmatchを使用してよい。pixelmatchを使う場合はraw typed array入力、perceptual color threshold、anti-alias除外、diff pixel countを利用する。

基本計算：

```text
dr = abs(rA - rB)
dg = abs(gA - gB)
db = abs(bA - bB)
delta = max(dr, dg, db)
```

`delta >= tolerance`なら変化pixelとする。

```text
pct = changedPixels / comparedPixels * 100
```

option：

```js
options: {
  tolerance: 8
}
```

`tolerance`は0～255。default値は`API.md`に記載する。

用途：

* 静的menu領域
* 黒画面から通常画面
* 完全に固定されたUI

モンスターanimationを含む広い領域ではdefaultにしない。

`px-window`はpixel差分maskからwindowed diff densityを計算する。散在するpixel noiseには強いが、モンスターのような局所的で密なanimationを自動的に無視するものではない。animation耐性の主algorithmとして扱わない。

## 44. `hist`
`hist`は自作する。対象物が同じ領域内で移動しても、色や明るさの構成が大きく変わらなければ差分を小さくする。menuの位置特定には弱い。

luminance：

```text
Y = (77 * R + 150 * G + 29 * B) >> 8
```

defaultは16 bins。各histogramを比較pixel数で正規化する。

```text
pA[i] = countA[i] / N
pB[i] = countB[i] / N
distance = 0.5 * sum(abs(pA[i] - pB[i]))
pct = distance * 100
```

option：

```js
options: {
  bins: 16
}
```

binsは8、16、32などの限定値にする。極端なbins数を受け付けない。

用途：

* scene change
* 暗転
* 全体的な色調変化
* 対象物が移動するが色構成は近い画面

## 45. `blk`
`blk`は自作する。menu位置や画面layoutの変化を検出しつつ、モンスターやparticleなど一部領域のanimationを無視する。今回のmenu位置特定では第一候補とする。

前処理：

1. RGBをluminanceへ変換する。
2. 必要なら小さいbox blurを適用する。
3. regionをtileへ分割する。
4. 各tileを小さい固定gridへdownsampleする。

推奨default：

* `tileSize: 16`
* `sampleGrid: 4`
* `blurRadius: 1`

tile差分：

```text
tileDiff = mean(abs(sampleA[i] - sampleB[i])) / 255
```

全tileの`tileDiff`を大きい順に並べ、上位一定割合を除外する。モンスター、effect、cursor animationなど、局所的に大きく変化したtileを外れ値として扱う。

```js
options: {
  tileSize: 16,
  sampleGrid: 4,
  blurRadius: 1,
  tileThresholdPct: 8,
  trimTopPct: 20
}
```

`trimTopPct:20`なら、差分が大きい上位20%のtileを判定対象から除外する。region内のほとんどがanimationで占められる場合は、regionを狭めるか`ignoreRects`を使う。

trim後に残ったtileのうち、次を満たすtileを変化tileとする。

```text
tileDiff * 100 >= tileThresholdPct
```

```text
pct = changedTilesAfterTrim / comparedTilesAfterTrim * 100
```

`trimTopPct`を高くしすぎると本物の変化を消すため、最大40%程度へ制限する。

## 46. `edge`
`edge`は自作する。色や明るさの変化より、線、枠、文字、menu形状、配置の変化を検出する。palette animation、明滅、色違いanimationの影響を減らす。

前処理：

1. luminance化する。
2. 1pixel程度のblurを適用する。
3. 横・縦gradientを計算する。

```text
gx = abs(Y[x+1] - Y[x-1])
gy = abs(Y[y+1] - Y[y-1])
edge = min(255, gx + gy)
```

Sobelを使ってもよいが、処理負荷と結果の安定性を比較する。

`blk`と同様にtileへ分割し、tile内edge mapの差分を計算する。

```text
tileEdgeDiff = mean(abs(edgeA[i] - edgeB[i])) / 255
```

```js
options: {
  tileSize: 16,
  blurRadius: 1,
  tileThresholdPct: 10,
  trimTopPct: 20
}
```

scoreは`blk`と同様、trim後の変化tile割合とする。

用途：

* menu枠の出現
* text box位置の変化
* UI layoutの切り替え
* 色だけ変化するanimationを無視したい場合

画面全体がscrollする場面では大きな差分になる。scrollを無視するalgorithmではない。

## 47. `ssim-trim`
SSIMを画面全体へ1回だけ適用しない。regionをtileへ分割し、tileごとのSSIM差分を計算する。

```text
tileDiff = (1 - ssim) * 100
```

差分が大きいtileを順位付けし、上位`trimTopPct`を除外する。

```js
algorithm: "ssim-trim",
options: {
  tileSize: 16,
  trimTopPct: 20,
  tileThresholdPct: 12
}
```

scoreは、trim後に`tileThresholdPct`以上となったtileの割合とする。

SSIM library候補は固定画像で検証して採否を決める。採用する場合は固定version CDN loader、hash、license manifestを使用する。library load失敗時は`ssim-trim`だけを`ALGORITHM_UNAVAILABLE`とする。

## 48. animation耐性の共通option
次を共通optionとして検討する。

```js
ignoreRects
trimTopPct
stableFrames
sampleEveryFrames
smallComponentMaxArea
alignMaxShift
```

`smallComponentMaxArea`はpixel差分maskの小さいconnected componentを除外する。`alignMaxShift`はcamera振動など数pixelの全体ずれを補正する。両optionはdefault無効とし、test結果なしに自動使用しない。

推奨用途：

| Algorithm | 主用途 |
| --- | --- |
| `px` | 完全に静的なUI領域 |
| `px-window` | 散在noiseを無視したい領域 |
| `hist` | scene、暗転、全体色構成 |
| `blk` | menu位置、局所animation混在 |
| `edge` | menu枠、文字、配置、色点滅混在 |
| `ssim-trim` | textureや明暗変化を許容しながら構造変化を見る場合 |

## 49. `compareFrame`
公開API：

```js
compareFrame({
  id: "menu-base",
  algorithm: "blk",
  thresholdPct: 18,
  screen: "bottom",
  region: [40, 20, 180, 120],
  ignoreRects: [],
  options: {
    tileSize: 16,
    tileThresholdPct: 8,
    trimTopPct: 20
  }
})
```

`thresholdPct`は比較結果の`changed`判定に使う。仕様を単純化するため、初期実装では`thresholdPct`を必須とする。

通常結果：

```json
{
  "ok": true,
  "changed": true,
  "pct": 21.34
}
```

`debug:true`の場合だけ次を追加してよい。

* comparedPixels
* comparedTiles
* trimmedTiles
* rawPct
* algorithm
* region
* thresholdPct
* externalLibraryVersion
* externalLibraryHash

保存済み`id`のpixelsを絶対に書き換えない。比較後も同じAを保持し、自動replaceしない。

## 50. `waitForScreenChange`
公開API：

```js
waitForScreenChange({
  timeoutMs: 5000,
  algorithm: "blk",
  thresholdPct: 18,
  screen: "bottom",
  region: [40, 20, 180, 120],
  ignoreRects: [],
  stableFrames: 2,
  sampleEveryFrames: 1,
  scriptBreakpoints: "ignore",
  options: {
    tileSize: 16,
    tileThresholdPct: 8,
    trimTopPct: 20
  }
})
```

必須：

* `timeoutMs`
* `algorithm`
* `thresholdPct`

省略可能：

* `screen`
* `region`
* `ignoreRects`
* `stableFrames`
* `sampleEveryFrames`
* `scriptBreakpoints`
* `options`

`waitForScreenChange`はbreakpointの存在を実行条件にしない。有効な通常breakpointが0件でも実行可能である。

### 50.1 fixed baseline
開始時に現在frame Aを一度だけJS側へcopyする。後続比較は必ず次のとおりとする。

```text
B vs A
C vs A
D vs A
E vs A
```

絶対に次のようにしない。

```text
B vs A
C vs B
D vs C
E vs D
```

Bが変化していてもbaselineをBへ更新しない。threshold未満のframeが来てもbaselineはAのままにする。script-only breakpointで停止・再開してもAを更新しない。一時停止時間が発生してもAを更新しない。algorithm、options、region、ignoreRectsは開始時に確定し、完了まで固定する。

fixed baseline規則は`API.md`の`waitForScreenChange`冒頭へ最重要仕様として記載する。

### 50.2 開始手順
1. operation lockを取得する。
2. screen validityを確認する。
3. 必要な外部algorithm libraryをloadし、version、hashを固定する。
4. 現在のemulatorをpauseする。
5. `captureFrameBuffer()`を呼ぶ。
6. AをJS `Uint32Array`へcopyする。
7. completed frame serialとbreak serialを記録する。
8. resumeする。
9. 新しい完了frameごとに比較する。
10. thresholdと`stableFrames`条件成立でpauseする。
11. compact結果を返す。

実行開始時にrunningだった場合も、一度pauseしてAを確定してからresumeする。A capture中にframeが進むraceを許さない。

### 50.3 frame取得
比較は正常に完了したemulator frameの後だけ行う。`setInterval`だけでnative bufferを読み続けない。既存frame loopのcompleted frame通知を購読する。

render無効時でも比較できるようにする。比較対象frameでは、完了後に`captureFrameBuffer()`を呼び、JSへcopyする。canvasへ描画する必要はない。UIを表示する必要もない。

### 50.4 `stableFrames`
`stableFrames`は、threshold以上の差分が連続して指定回数発生した場合だけ成功とする。

```text
thresholdPct = 18
stableFrames = 2

B vs A = 22%  count=1
C vs A = 24%  count=2 -> success
```

次の場合は成功しない。

```text
B vs A = 22%  count=1
C vs A = 5%   count=0
D vs A = 23%  count=1
```

baselineは常にAであり、countだけをresetする。

### 50.5 `sampleEveryFrames`
処理負荷を抑えるため、比較間隔を指定できる。

```js
sampleEveryFrames: 2
```

2 frameごとに比較する。比較しなかったframeでbaselineを更新してはならない。

### 50.6 breakpointとの相互作用
実行中にscript-only breakpointがhitした場合は、callback終了後に継続する。A、stable count、timeout時計を変更しない。

実行中にuser-visible breakpointがhitした場合はscreen change成功として扱わず、通常errorで終了する。

```js
{
  ok: false,
  error: {
    code: "BREAKPOINT_INTERRUPTED",
    message: "Screen wait was interrupted by a non-script breakpoint",
    recoverable: true,
    details: {
      breakpointId: 12,
      cpu: "arm9",
      type: "exec",
      address: "0x021e54fc"
    }
  }
}
```

この場合もbaseline Aは変更しない。

### 50.7 成功結果
```json
{
  "ok": true,
  "changed": true,
  "algorithm": "blk",
  "pct": 21.34,
  "frames": 7
}
```

`pct`は成功判定に使った最後のframeとAとの差分。`frames`はoperation開始後に完了したframe数。`sampledFrames`は`debug:true`時だけ返してよい。

### 50.8 timeout
timeout時はpauseし、通常errorを返す。観測した最大差分を含める。

```js
{
  ok: false,
  error: {
    code: "TIMEOUT",
    message: "waitForScreenChange timed out",
    recoverable: true,
    details: {
      timeoutMs: 5000,
      maxPct: 11.42
    }
  }
}
```

最大差分を出したframeをbaselineへ昇格させない。snapshotとして自動保存しない。

### 50.9 animationへの推奨
menu位置特定でモンスターanimationが存在する場合：

* `algorithm:"blk"`を第一候補とする。
* `trimTopPct`は15～25程度を試す。
* `stableFrames`を2以上にする。
* 可能ならmenu周辺へregionを限定する。
* 常時動く固定領域は`ignoreRects`へ入れる。

色変化だけが激しい場合は`edge`、scene全体の切替は`hist`、完全に静的な範囲は`px`を使う。

## 51. algorithm debug結果
通常API結果は短くするが、algorithm調整用に`debug:true`を用意する。

`blk`例：

```json
{
  "ok": true,
  "changed": false,
  "pct": 7.14,
  "rawPct": 24.0,
  "tiles": 70,
  "trimmed": 14,
  "changedTiles": 4
}
```

`rawPct`はtrim前、`pct`はtrim後とする。通常modeでは`rawPct`などを返さない。tileごとの全scoreは明示的な`debug:"tiles"`指定時だけ返す。

## 52. screenshot範囲保存の補助
Chrome DevTools MCPの`take_screenshot`は、page、viewport、UID指定elementは保存できるが、任意の画像座標矩形を直接crop指定できない。

必要なら次を追加する。

```js
prepareFrameRegion({
  screen: "bottom",
  region: [40, 20, 180, 120]
})
```

動作：

1. 現在の有効frameをJSへcopyする。
2. 指定範囲だけを専用canvasへ描画する。
3. `frame-region-preview`など固定IDのDOM elementへ表示する。
4. Chrome DevTools MCPから最新snapshotでUIDを取得する。
5. `take_screenshot(uid=...)`で任意pathへ保存する。

この機能は比較APIの必須部分ではなく、`compareFrame`または`waitForScreenChange`で判断できない場合の補助とする。

## 53. UI controller
UI eventからcommand registryを呼ぶ。UI独自実装とWebMCP実装を分けない。

```js
const result = await commands.execute(
  "loadState",
  params
);
renderCommandResult(result);
```

UIだけが別経路でnativeを直接操作してはならない。ただし、高頻度描画などcommand化が不適切な内部処理はserviceを直接呼んでよい。その境界をcommentまたはdocumentで示す。

既存`public/index.html`のUIを再利用する。既存DOM ID、button、input、select、template、keyboard binding、表示順、layout、status領域を可能な限り維持し、同じ機能の新panelや重複buttonを作らない。module分割ではevent handlerの所属を`ui/`へ移すだけにし、ユーザー操作手順を変えない。

一時的に非表示または無効化する既存controlは、可能な限り既存layout幅を保持し、表示切替でCLSを発生させない。canvasは31、32の規則どおり、breakpoint停止を理由に隠さない。

UI文言は内部設計の説明ではない。次だけを簡潔に伝える。

* ユーザーまたはAIが何を期待できるか
* どのcontrolを操作するか
* 操作すると何が起きるか
* 続行、復旧、再試行のために何をすべきか

owner map、serial、Worker lifecycle、frame validity判定、native result codeなどの詳細は`API.md`、developer log、`AGENTS.md`、`handoff.md`へ書き、UIへ長文で転記しない。

## 54. API.mdへ先に記載する要点
`API.md`はcommand名を見出しまたは安定したkeywordとして持ち、`rg`一回で該当commandの仕様、引数、default、成功結果、error code、副作用へ到達できる構成にする。巨大な一覧だけに仕様を埋め込まない。

### 54.1 fixed baseline
```text
waitForScreenChangeは開始時frame Aを固定baselineとして保持する。
後続のすべてのframeはAと比較する。
比較途中でbaselineを自動更新しない。
```

### 54.2 timeout
```text
waitForBreak、runUntil、waitForScreenChangeはtimeoutMs必須。
timeoutはthrowまたはPromise rejectではなくok:falseの通常error result。
timeout時はemulatorをpauseし、operation資源をcleanupする。
```

### 54.3 Stateロード後
```text
Stateロード直後はscreen invalid。
正常なframeが1回完了するまで、画面取得、比較、screenshotはok:false。
UIはinvalidなnative framebufferでcanvasを上書きせず、直前の正常frameを保持する。
breakpointでframe完了前に停止してもcanvasを隠さない。
```

### 54.4 algorithm表
| ID | 意味 | animation耐性 | 主用途 | dependency |
| --- | --- | ---: | --- | --- |
| `px` | pixel変化率 | 低い | 静的UI、暗転 | optional pixelmatchまたは自作 |
| `px-window` | windowed pixel密度 | 中程度 | 散在noise | optional pixelmatch |
| `hist` | luminance histogram距離 | 高い | scene、色構成 | 自作 |
| `blk` | trim付きblock layout | 高い | menu、モンスター混在 | 自作 |
| `edge` | trim付きedge layout | 高い | 枠、文字、配置 | 自作 |
| `ssim-trim` | trim付きtiled SSIM | 高い | texture、明暗変化 | optional fixed-version CDN library |

### 54.5 external algorithm
```text
外部algorithm libraryは固定version、固定URL、固定SHA-256、license metadataを持つ。
load失敗またはintegrity不一致は該当algorithmだけを使用不能にする。
debugger本体と自作algorithmは継続利用可能とする。
```

### 54.6 Worker
```text
persistent scriptとeval Workerのsourceはsrc/workersで管理し、build時にpublic/app.jsへ文字列として埋め込む。
runtimeではBlob URLから起動し、停止時にterminateとrevokeObjectURLを行う。
```

### 54.7 `coi-serviceworker.js`
```text
public/coi-serviceworker.jsは独立assetであり、app bundle、generic minify、Worker文字列化の対象外。
MIT headerを保持し、root scopeで登録する。
```

## 55. production bundle
production bundleはIIFE形式を基本とする。

```text
format: iife
platform: browser
bundle: true
minify: true
```

既存HTMLの読み込み方式を維持できる。

```html
<script src="app.js?v=BUILD_VERSION"></script>
```

`type="module"`への変更は必須ではない。source側ではES moduleの`import`と`export`を使用し、esbuildがIIFEへbundleする。

production build scriptを追加する。

```text
scripts/build-js.mjs
```

例：

```js
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/app.js"],
  outfile: "public/app.js",
  bundle: true,
  minify: true,
  platform: "browser",
  format: "iife",
  target: ["chrome120"],
  sourcemap: false,
  legalComments: "external",
  logLevel: "info"
});
```

実際にはWorker sourceを文字列として取り込むloaderまたはpluginを追加する。`legalComments:"external"`で生成されるnoticeだけに依存せず、runtime CDN dependencyを含む`THIRD_PARTY_NOTICES`を別途生成する。

targetは実際の対応browser方針に合わせる。根拠なしに古いbrowserへ広げない。

productionではsource mapを生成しない。次をPages artifactへ入れない。

```text
public/app.js.map
src/
node_modules/
scripts/
```

`public/coi-serviceworker.js`は例外としてPages artifactへ含める。

## 56. local development build
local testでもproductionと同じ`public/app.js`を読み込む。本番だけbundleし、localでは`src/`を直接module importする構成にしない。

local用watch script：

```text
scripts/watch-js.mjs
```

例：

```js
import * as esbuild from "esbuild";

const context = await esbuild.context({
  entryPoints: ["src/app.js"],
  outfile: "public/app.js",
  bundle: true,
  minify: false,
  platform: "browser",
  format: "iife",
  target: ["chrome120"],
  sourcemap: "inline",
  legalComments: "inline",
  logLevel: "info"
});

await context.watch();
console.log("Watching src/**/*.js");
```

localではinline source mapを使用してよい。inline source mapなら`.map`への追加HTTP requestは発生しない。production buildでは必ず無効化する。

## 57. `package.json`とlockfile
例：

```json
{
  "private": true,
  "scripts": {
    "build:js": "node scripts/build-js.mjs",
    "watch:js": "node scripts/watch-js.mjs",
    "check:js": "node scripts/check-js.mjs",
    "check:licenses": "node scripts/check-licenses.mjs",
    "build:notices": "node scripts/build-third-party-notices.mjs"
  },
  "devDependencies": {
    "esbuild": "固定したversion"
  }
}
```

pixelmatchやSSIMをruntime CDN専用にする場合は`dependencies`へ重複登録しない。bundle採用へ変更する場合だけ固定versionで追加する。

`package-lock.json`をrepositoryへcommitする。CIとlocalで同じ依存versionを使用する。CIでは原則として`npm ci`を使い、global installを避ける。

Emscripten生成`desmume.js`のminifyにTerserが必要なら、Terserも固定versionの`devDependencies`へ入れ、`npx terser`またはpackage scriptから実行する方が望ましい。現行workflowを最小変更するため一時的にglobal installを残す場合は、versionを固定し、後でlocal dependencyへ移す。

## 58. local test手順
初回：

```powershell
npm ci
npm run check:licenses
npm run build:js
```

継続開発：

```powershell
npm run watch:js
```

別terminalで既存PHP serverを起動する。

```powershell
C:\Users\owner\CLionProjects\deweb\start-test-server.ps1
```

browserが読み込むpathはPagesと同じにする。

```text
http://localhost:8766/coi-serviceworker.js
http://localhost:8766/app.js
```

localとPagesでHTMLのscript pathを切り替えない。

`coi-serviceworker.js`の更新testでは、既存service worker cacheとcontroller状態の影響を確認する。通常のapplication testでbrowser storageを無断消去してはならない。必要な場合は明示的なtest手順としてderegisterとreloadを行う。

## 59. `public/`の構成
目標：

```text
public/
  index.html
  app.js
  coi-serviceworker.js
  desmume.js
  desmume.wasm
  THIRD_PARTY_NOTICES.txt
  css/
  assets/
```

`THIRD_PARTY_NOTICES.txt`はlicense義務または運用方針に応じて含める。runtimeではfetchしなくてよい。

次を置かない。

```text
public/src/
public/commands/
public/frame-diff/
public/workers/
public/node_modules/
```

例外として独立Worker assetを採用した場合だけ、明示的なhash付きassetを置く。それ以外のWorkerは`public/app.js`内の文字列とする。

## 60. `build.sh`との責務
`webassembly/build.sh`はWASMとEmscripten生成物を担当する。

```text
desmume.wasm
desmume.js
その他native build artifact
```

npm、esbuildはWeb debugger application JavaScriptを担当する。

```text
src/**/*.js
  -> public/app.js
```

`public/coi-serviceworker.js`はvendored static assetとしてrepositoryで管理し、`webassembly/build.sh`やesbuildで生成しない。

`build.sh`内へ大量のnpm bundling logicを埋め込まない。GitHub Actionsおよびlocal scriptから次の順で呼ぶ。

```text
bash webassembly/build.sh
npm run check:licenses
npm run build:js
npm run build:notices
```

### 60.1 `webassembly/build_safe_heap.sh`
C++、WASM export、native bridge境界を変更した場合は、production用`webassembly/build.sh`も編集するが、実際には既存の`webassembly/build_safe_heap.sh`でもbuildする。`build_safe_heap.sh`は`ASSERTIONS=2`、`STACK_OVERFLOW_CHECK=2`、debug informationを有効にし、native crashやstack破損の調査に使用する。production buildを置き換えるscriptではない。

stack trace、call stackのC++実装は今回変更しないが、ほかのC++変更が間接的に壊していないことをsafe heap buildで確認する。safe heap build後は、少なくともROM load、pause/resume、step、breakpoint、stack trace、call stack、State load、続く`status`を実行する。

Codespace build手順は`AGENTS.md`の既存手順を維持する。現行の主要commandは次であり、Windows batchへ置き換えない。

```text
gh codespace ssh -c stunning-waffle-wrjpjx79xqpcvjq "cd /workspaces/desmume_webassembly && bash webassembly/build_safe_heap.sh"
```

Codespace名の確認、file transfer、build後の`public/desmume.js`取得、Codespace停止など、`AGENTS.md`にある運用規則を削除または簡略化しない。`build.cmd`は作成しない。

WASM buildは約5分かかる前提で、細切れに再buildせず、関連するC++変更と検証項目をまとめる。ただし未検証の大規模変更を一度に重ねず、safe heap buildで原因を切り分けられる単位を維持する。

## 61. GitHub Pages workflow
現在のworkflowは大枠を維持してよい。必要な変更：

* Node.js依存をinstallする。
* `npm ci`を実行する。
* license manifestを検証する。
* `npm run build:js`で`src/`から`public/app.js`を生成する。
* noticeを生成する。
* 生成済み`app.js`を後段のgeneric Terserで再圧縮しない。
* `coi-serviceworker.js`をminifyしない。
* Emscripten生成`desmume.js`だけ必要範囲でminifyする。
* Pages artifactへ`src/`、`node_modules/`、source mapを含めない。

推奨workflow：

```yaml
name: Build DeSmuME WebAssembly and Deploy Pages

on:
  workflow_dispatch:
  push:
    branches: ["main", "webassembly"]

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Checkout
        uses: actions/checkout@v7
        with:
          submodules: recursive

      - name: Install Emscripten
        run: |
          sudo apt-get update > /dev/null 2>&1
          sudo apt-get install -y emscripten > /dev/null 2>&1

      - name: Build WebAssembly
        env:
          OUTPUT_DIR: ${{ github.workspace }}/public
        run: |
          bash webassembly/build.sh

      - name: Install JavaScript dependencies
        run: |
          npm ci

      - name: Verify third-party licenses
        run: |
          npm run check:licenses

      - name: Bundle application JavaScript
        run: |
          npm run build:js

      - name: Build third-party notices
        run: |
          npm run build:notices

      - name: Minify Emscripten JavaScript
        run: |
          npm run minify:emscripten

      - name: Verify Pages output
        run: |
          test -f public/index.html
          test -f public/app.js
          test -f public/coi-serviceworker.js
          test -f public/desmume.js
          test -f public/desmume.wasm
          test ! -d public/src
          test ! -d public/workers
          test ! -f public/app.js.map
          grep -q "coi-serviceworker v0.1.7" public/coi-serviceworker.js
          find public -maxdepth 2 -type f -print

      - name: Setup Pages
        uses: actions/configure-pages@v6

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v5
        with:
          path: "public"

      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v5
```

現在と同じ1 job構成を維持してよい。GitHub公式のbuild、deploy分離は今回の必須条件ではない。

## 62. minify責務
次のgeneric処理はそのまま使用しない。

```bash
find public -maxdepth 1 -name "*.js" -print0 | while IFS= read -r -d '' f; do
  terser "$f" -o "$f" --compress --mangle
done
```

理由：

* `public/app.js`はesbuildで既にminify済みである。
* `public/coi-serviceworker.js`は独立vendored codeであり、headerと挙動を保持する。
* 二重minifyは問題切り分けを難しくする。
* Emscripten生成物とapplication bundleの最適化責務が混ざる。

対象が`desmume.js`だけなら、そのfileだけを明示的にminifyする。

```bash
terser public/desmume.js \
  -o public/desmume.js \
  --compress \
  --mangle
```

## 63. cache busting
`public/index.html`の`app.js` URLはbuild versionを付ける。

```html
<script src="app.js?v=20260717"></script>
```

手動更新を避ける場合、CIでcommit SHAの短縮値をHTMLへ埋め込む。ただし、PowerShellやsedでsource本文を雑に書き換えない。専用build scriptでplaceholderを置換する。

```html
<script src="app.js?v=__BUILD_ID__"></script>
```

`coi-serviceworker.js`はservice worker update mechanismがfile content changeを検出するため、URL queryを頻繁に変えない。current script URLとregistration scopeの挙動を壊さない。

## 64. bundle sizeとrequest budget
単一bundleを採用するが、巨大化を無視しない。CIでsizeを表示する。

```bash
wc -c public/app.js
gzip -c public/app.js | wc -c
wc -c public/coi-serviceworker.js
```

必要なら実測後に上限を設定する。根拠なく厳しい値を入れない。

Worker sourceを文字列としてbundleへ含めるため、そのsizeもmain bundleへ計上される。build reportでWorker sourceごとの概算sizeを表示してよい。

runtime requestの基本予算：

* `index.html`
* `coi-serviceworker.js`
* `app.js`
* `desmume.js`
* `desmume.wasm`
* CSS、必要asset
* 使用時だけ固定versionのoptional algorithm library

自作moduleやWorkerごとのrequestは発生させない。

dynamic importによる一般的なcode splittingは、追加requestを増やすため基本方針では使用しない。optional external algorithmだけを例外とする。

## 65. source map
local：

```text
inline source map可
```

Pages：

```text
source mapなし
```

productionで外部`.map`を生成、配信しない。ただしminify済み`app.js`自体はbrowserへ配信されるため、完全に秘密にはならない。

目的：

* moduleごとのsourceをPages assetとして配信しない。
* source file数を増やさない。
* source mapで元構造を直接公開しない。
* request数を抑える。

## 66. `.gitignore`
`public/app.js`をrepositoryへcommitしない方針なら追加する。

```gitignore
/public/app.js
/public/app.js.map
```

`public/coi-serviceworker.js`はrepositoryへcommitし、ignoreしない。

現在`public/app.js`をsourceとしてcommitしている場合、移行commitでは次を同時に行う。

1. 既存`public/app.js`を`src/`へ分割する。
2. build scriptを追加する。
3. package filesを追加する。
4. workflowを更新する。
5. `public/app.js`をgenerated扱いへ変更する。
6. `public/coi-serviceworker.js`を独立vendored assetとして確認する。

ローカルでbuildしていない状態でも、Pages workflowが必ず`public/app.js`を生成することを確認する。

## 67. API documentとnotice
`API.md`はsourceとしてrepository内で管理する。Pagesへ公開する必要がなければ`public/`へcopyしない。生成されたWebMCP command referenceをPages UIで使う場合だけ、必要な生成物を`public/`へ置く。

人間、AI向け内部documentとbrowserが必要とするassetを混同しない。

`THIRD_PARTY_NOTICES.md`はsource documentとしてrepositoryで管理する。必要に応じて`public/THIRD_PARTY_NOTICES.txt`を生成する。runtimeでnoticeをfetchしてapplication起動条件にしてはならない。

## 68. 段階的な移行手順
全面書き換えを一度に行わない。次の順で移行する。

### Phase A: responseとdispatch
* `API.md`を先に更新する。
* 現行`API.md`、`window.DesmumeMCP.list()`、shortcut、UI buttonとevent handlerの互換性inventoryを作る。
* `mcp-responder.js`を追加する。
* `error-codes.js`を追加する。
* `command-registry.js`を追加する。
* `webmcp.js`を追加する。
* 既存commandをregistry経由で呼べるようにする。
* 中身は一時的に旧`runCommand`へ委譲してよい。
* `desmume.call`、`desmume.eval`、`desmume.runScript`の正常errorを統一する。

### Phase B: source分割とbuild基盤
* 既存application sourceを`src/`へ移す。
* `src/app.js`をentry pointにする。
* esbuild production buildを追加する。
* local watch buildを追加する。
* Worker sourceを`src/workers/`へ移し、文字列としてbundleへ埋め込む。
* `public/app.js`をgenerated assetへ変更する。
* `public/coi-serviceworker.js`を独立assetとして維持する。
* generic minify対象から`app.js`と`coi-serviceworker.js`を除外する。
* 既存UI DOMを再利用し、同じ機能のbuttonやpanelを重複追加しない。
* 現行compact formatterを移植し、多重JSON化していないことをtestする。
* stack traceとcall stackのC++実装に差分がないことを確認する。

### Phase C: operation manager
* `operation-manager.js`を追加する。
* operation lockを一元化する。
* timeout、cancel、BUSYを統一する。
* completed frame通知を追加する。
* Stateロード後のscreen invalid処理を追加する。
* UI canvasをinvalid中に隠す。

### Phase D: breakpoint owner
* `breakpoint-owner-store.js`を追加する。
* `breakpoint-service.js`を追加する。
* user、script、operation ownerを分離する。
* native break serialとJS break event serialを整備する。
* script-only exec、read、write breakpointの継続を実測する。
* `waitForBreak`を実装する。

### Phase E: wait command
* `runUntil({pc})`を実装する。
* `runUntil({bp,hits})`を実装する。
* temporary breakpoint ownerを管理する。
* hit count testを追加する。
* `waitForScreenChange`のbreakpoint interrupt方針を実装する。

### Phase F: input service
* `input-service.js`を追加する。
* compact opcode parserを実装する。
* localStorage versioningを実装する。
* ID再利用と`replace:true`を実装する。
* N秒連打、複数button、frame holdを実装する。
* success、timeout、cancel、faultで入力cleanupする。

### Phase G: frame serviceと自作algorithm
* raw frameをJS側独立bufferへcopyする。
* snapshot管理を実装する。
* region、ignoreRectsを実装する。
* `hist`、`blk`、`edge`を自作する。
* 必要なら自作fallback `px`を実装する。
* animation耐性testを追加する。
* `compareFrame`を実装する。

### Phase H: external algorithm loader
* external algorithm manifestを追加する。
* 固定version URLを確定する。
* SHA-256を確定する。
* license、copyright、noticeを確認する。
* loader timeout、CORS、COEP、integrity failureを実装する。
* algorithm専用Worker隔離を実装する。
* CDN failure時にdebugger本体が継続することを確認する。

### Phase I: screen wait
* `waitForScreenChange`を実装する。
* fixed A baselineを実装する。
* `stableFrames`を実装する。
* `sampleEveryFrames`を実装する。
* timeout resultへ`maxPct`を含める。
* render無効時testを追加する。

### Phase J: cleanupとdocument
* ROM、Save、State、memory、script commandを順次serviceへ移す。
* `setSaveType`を削除する。
* command説明を更新する。
* 自動生成documentを再生成する。
* license noticeを生成する。
* Pages artifactを検証する。
* full regression testを実行する。
* `API.md`とUI互換性inventoryを再照合し、明示的な削除対象以外が全維持されていることを確認する。
* `webassembly/build_safe_heap.sh`を使う必要がある変更では、Codespace上のsafe heap buildとChrome DevTools MCP回帰試験を完了する。
* 最後に`AGENTS.md`を最新のsource構成、build、test、Worker、license手順へ更新する。ただし既存のCodespace build command、`webassembly/build_safe_heap.sh`使用手順、Codespace停止規則を維持し、`build.cmd`を追加しない。

各Phaseで既存testを通す。`app.js`を一度空にしてから作り直す方法は禁止する。

## 69. 一時互換層
移行期間中はadapterを許可する。

```js
async function legacyRunCommandAdapter(command, params) {
  return responder.runSafely(
    command,
    async () => {
      const result = await legacyRunCommand(
        command,
        params
      );
      return responder.normalizeResult(result);
    }
  );
}
```

ただし最終状態で、新commandがlegacy switchへ追加され続ける構造を残さない。

## 70. unit test
### 70.1 responder
* 成功結果
* 正常error
* unexpected exception
* native fault
* timeout
* details有無
* compact output
* `data.ok`上書き拒否

### 70.2 operation manager
* BUSY
* timeout
* cancel
* cleanup一度だけ
* timer残留なし
* listener残留なし
* 次operation実行可能
* Worker terminateとBlob URL revoke

### 70.3 breakpoint owner
* userのみ
* scriptのみ
* operationのみ
* mixed
* owner一件削除
* 最後のowner削除
* native登録回数
* user ownerをscript ownerが置換しない

### 70.4 frame service
* State load invalidation
* failed State loadではinvalid化しない
* completed frameによるvalidation
* CPU stepだけではvalidationしない
* breakpoint中断frameではvalidationしない
* baseline A固定
* algorithm registry
* snapshot replace
* raw buffer独立copy

### 70.5 input service
* sequence parse
* invalid opcode
* unknown button
* ID再利用
* `replace:true`
* localStorage version
* release all
* touch release

### 70.6 Worker
* persistent script Worker sourceがbundle内文字列である
* eval Worker sourceがbundle内文字列である
* productionでWorker file requestが発生しない
* sourceが文字列でない、空、上限超過の場合に`SCRIPT_SOURCE_INVALID`になる
* escape、quote、括弧の誤りで`SCRIPT_COMPILE_ERROR`になり、lineとcolumnを可能な限り返す
* `hogehoge`のような構文上有効なsourceが`SCRIPT_RUNTIME_ERROR`と`ReferenceError`になる
* bootstrap失敗が`WORKER_START_FAILED`になる
* 起動後の`error`、`messageerror`が`WORKER_CRASHED`になる
* malformed messageと未許可RPCが`WORKER_PROTOCOL_ERROR`になる
* timeoutでWorker terminate
* restartで古いBlob URLがrevokeされる
* WorkerからDOMへアクセスできない
* allowlist外RPCが拒否される
* compile/runtime error後も別Worker、WASM instance、breakpoint、baselineが維持される

### 70.7 algorithm loader
* exact version URLだけ許可
* arbitrary URL拒否
* SHA-256一致
* SHA-256不一致
* network timeout
* CORS failure
* COEP環境でのload
* offline failure
* CDN failure後も`hist`、`blk`、`edge`が動作
* library objectがwindow globalへ残らない

### 70.8 WebMCP
* `ok:false`でもtransport成功
* unknown command
* ROM未読込
* timeout
* internal error
* Worker syntax error
* Worker runtime error
* Worker start failure
* Worker crash
* Worker protocol error
* compact textがstructured contentの二重JSONになっていない
* 続く`status`成功

## 71. frame algorithm acceptance test
### 71.1 fixed baseline
人工frame A、B、Cを用意する。

* A: 基準
* B: Aから20%変化
* C: Aと同一

内部比較は次になること。

```text
B vs A = 20%
C vs A = 0%
```

`C vs B = 20%`として成功してはならない。

別test：

* B: Aから20%
* C: Aから25%
* D: Aから30%

すべてAとの比較であること。

### 71.2 animation耐性
人工画像でregionの10%だけに動くspriteを置く。`blk`で`trimTopPct:20`を指定した場合、threshold未満になること。同じ画像でregionの60%へmenu枠を追加した場合、threshold以上になること。sprite位置を複数回変更してもbaseline Aは変化しないこと。

### 71.3 histogram
同じ色数を保ったままsprite位置だけ移動した画像で、`hist`差分が小さいこと。画面全体を暗転した画像で差分が大きいこと。

### 71.4 edge
色だけ変更しlayoutを維持した画像で、`edge`差分が比較的小さいこと。menu枠位置を変更した画像で差分が大きいこと。

### 71.5 tiled SSIM
局所animationを一部tileへ集中させた画像で、`trimTopPct`により差分が抑制されること。広いmenu変化ではtrim後もthreshold以上になること。library未ロード時は`ALGORITHM_UNAVAILABLE`となり、ほかのalgorithmへ影響しないこと。

### 71.6 stableFrames
threshold超過、未満、超過の順では成功しない。threshold超過が指定回数連続した場合だけ成功する。

## 72. operation acceptance test
### 72.1 State画面
1. Stateロード直後に`screenValid === false`になる。
2. Stateロード時のinvalid framebufferでcanvasを上書きしない。
3. 直前の正常frameがある場合はcanvasが表示されたままになる。
4. `captureFrame`が`SCREEN_INVALID`になる。
5. `waitForScreenChange`が`SCREEN_INVALID`になる。
6. CPU命令stepだけではAPI用frameが有効化されない。
7. breakpointでframe完了前に止まった場合もAPI用frameは有効化されないが、canvasは直前の正常frameを表示し続ける。
8. UIに`screenValid`やframe serialなどの内部状態を長文表示しない。
9. 正常frame完了後にAPI用frameが有効化される。
10. canvasが新しい正常frameへ更新される。
11. 比較APIが成功する。

### 72.2 timeout
* `waitForBreak` timeoutで`ok:false`になる。
* `runUntil` timeoutで`ok:false`になる。
* `waitForScreenChange` timeoutで`ok:false`になる。
* `error.code=TIMEOUT`になる。
* timeout後にpauseする。
* listenerが残らない。
* operation lockが解除される。
* temporary ownerが残らない。
* 入力が残らない。
* 次operationが正常に実行できる。

### 72.3 breakpoint hits
Stateロード後、対象breakpointを10回通る操作を行う。`runUntil({bp,hits:10})`が10回目で停止すること。過去hitを含めないこと。1～9回目で自動継続できること。temporary解除中に別breakpointがhitした場合、そのbreakを失わないこと。

### 72.4 input sequence
* 新規ID登録と実行
* IDだけで再実行
* browser reload後もlocalStorageから再利用
* 同一IDの無断上書きを拒否
* `replace:true`で更新
* 5秒連打
* 複数button
* frame hold
* error時に全button release
* touch release
* 実行前pause状態を成功時に復元

### 72.5 排他制御
`waitForScreenChange`中に`runUntil`を開始し、`BUSY`になること。二重resume、二重frame比較、二重timerが発生しないこと。State loadで現在operationが`CANCELLED`になり、新Stateロードが完了すること。

## 73. Chrome DevTools MCP回帰試験
実際のChrome DevTools MCPから実行する。

### 73.1 ROM未読込
`desmume.call`で`getRegisters`を実行する。

期待：

```text
外側のWebMCP実行は正常終了
output内はok=false
error.code=ROM_NOT_LOADED
errorTextは空
pageは生存
WASM instanceは同一
続くstatusが成功
```

### 73.2 breakpointなし
```js
waitForBreak({ timeoutMs: 1000 })
```

期待：

```text
ok=false
error.code=NO_WAITABLE_BREAKPOINTS
resumeされない
frameが進まない
```

### 73.3 timeout
通常breakpointを到達不能な場所へ設定して実行する。

期待：

```text
ok=false
error.code=TIMEOUT
emulatorはpause
breakpointは保持
WASM instanceは同一
次のstatusが成功
次のstepが成功
```

### 73.4 script-only breakpoint
script-only exec breakpointを高頻度地点へ登録し、通常breakpointを別地点へ登録して`waitForBreak`を実行する。

期待：

```text
script-only hitでは完了しない
script callbackは実行される
通常breakpointで完了する
```

### 73.5 script-onlyしかない
script-only breakpointだけを登録する。

期待：

```text
default waitForBreakはNO_WAITABLE_BREAKPOINTS
scriptBreakpoints:"include"指定時だけ待機開始
```

### 73.6 mixed owner
同じsiteへuser breakpointとscript triggerを登録する。

期待：

```text
user breakpointが消えない
IDが維持される
script callbackも実行される
待機commandはそのhitを通常breakpointとして認識する
```

### 73.7 JavaScript内部error
test buildだけに意図的な内部失敗commandを追加する。

期待：

```text
ok=false
error.code=INTERNAL_ERROR
WebMCP transportは生存
WASM instanceは生存
続くstatusが成功
```

本番buildにはtest commandを残さない。

### 73.8 C++内部error
test buildでnative functionへ不正条件を与え、catchまたはresult code経路を確認する。

期待：

```text
page crashなし
WASM abortなし
ok=false
error.code=NATIVE_ERRORまたはNATIVE_FAULT
statusまたはreloadRomが呼べる
```

### 73.9 external algorithm failure
固定URLをtest用に失敗させるか、hashを意図的に不一致にする。

期待：

```text
ok=false
error.code=ALGORITHM_UNAVAILABLEまたはALGORITHM_INTEGRITY_FAILED
desmume.call transportは成功
debugger本体は生存
hist、blk、edgeが成功
続くstatusが成功
```

### 73.10 Worker timeout
`desmume.eval`で終了しないscriptを実行する。

期待：

```text
ok=false
error.code=TIMEOUT
Workerはterminate
Blob URLはrevoke
WASM instanceは同一
続くevalまたはstatusが成功
```

### 73.11 invalid script source
文字列以外、空文字、上限超過sourceを`desmume.eval`、`desmume.runScript`、persistent scriptへ渡す。

期待：

```text
ok=false
error.code=SCRIPT_SOURCE_INVALID
Workerは生成されない
WASM instanceは同一
続くevalまたはstatusが成功
```

### 73.12 script compile error
quoteまたはtemplate literalのescapeを意図的に壊したsourceを渡す。

期待：

```text
ok=false
error.code=SCRIPT_COMPILE_ERROR
error.details.errorName=SyntaxError
取得可能ならline、column、短いsourceExcerptがある
script全文や巨大stackを返さない
失敗WorkerとBlob URLだけcleanupされる
WASM instance、breakpoint、baselineは維持される
```

### 73.14 Worker lifecycleとprotocol error
test buildでWorker bootstrap失敗、起動後error、`messageerror`、malformed RPC message、allowlist外RPCをそれぞれ発生させる。

期待：

```text
bootstrap失敗はWORKER_START_FAILED
起動後errorまたはmessageerrorはWORKER_CRASHED
malformed messageまたは未許可RPCはWORKER_PROTOCOL_ERROR
pending RPCが通常error resultで解決される
operation lock、timer、Worker、Blob URLが残らない
ほかのpersistent scriptとWASM instanceは維持される
```

### 73.15 compact output互換性
現行buildと分割後buildで、代表的な成功、失敗、call stack、memory dump、script print結果を比較する。

期待：

```text
content textは既存と同等のcompact表現
structuredContentはobject
JSON文字列をさらにJSON化したescape列がない
巨大配列、script全文、内部frame、巨大stackが通常textへ出ない
one-letter shortcut、call、eval、runScriptで同じ方針
```

### 73.16 stack traceとcall stack保全
既存の代表的な解析Stateでstack traceとcall stackを取得し、分割前後を比較する。

期待：

```text
C++側関連fileに差分がない
multi-frame検出とlane選択が同じ
公開frameの順序、caller、callee、SP、CPSR、ISAが同じ
synthetic、observer、補助internal frameがpublic結果へ出ない
既存shortcutとUI buttonが同じ結果を表示する
```

## 74. Pagesとsecurity acceptance test
* Pages起動時に`src/*.js` requestがない。
* 自作moduleごとのrequestがない。
* persistent script Worker file requestがない。
* eval Worker file requestがない。
* `public/coi-serviceworker.js`は独立requestである。
* `coi-serviceworker.js`のMIT headerが残っている。
* `coi-serviceworker.js`がgeneric minifyされていない。
* `crossOriginIsolated`の期待値をsecure contextで確認する。
* service worker未対応またはprivate mode時に、説明可能なlogを出し、無限reloadしない。
* optional algorithm loadがCOEP環境で成功する。
* allowlist外URLをWorker、WebMCPから指定できない。
* `THIRD_PARTY_NOTICES`が採用versionと一致する。
* source mapがPagesへない。
* `src/`と`node_modules/`がPages artifactへない。

## 75. 今回の非対象
次は今回無理に実装しない。

* reverse step
* 全命令trace
* OCR
* 自動menu認識
* AIによる画像意味理解
* baselineの自動追従
* B、C、Dへの自動baseline更新
* 不正確なframe polling版`valueChanged`
* SPSRの推測書き込み
* cheat API全面公開
* 汎用画像認識libraryの導入
* 外部APIへのframe送信
* 自作sourceのruntime CDN配信
* Worker sourceの無条件な別file配信

## 76. `setSaveType`
現在の`setSaveType`は削除する。

削除対象：

* command登録
* API description
* UI
* handler
* documentation
* test

native側の`emuSetOpt(1, type)`が実際に何もしていないなら、成功を装うcommandを残さない。既存firmware language処理とは分離して考える。

## 77. SPSR
SPSRは別調査とする。

確認事項：

* 現在CPU modeごとのbanked SPSR
* `dbgGetReg(17)`が何を返しているか(ビルドには5分かかるのでまとめて検証する)
* write後に必要なside effect
* CPSR変更との関係
* ARM7、ARM9差
* user、system modeでSPSRが存在しない場合

調査結果なしに`cpu->SPSR.val = value`だけを追加しない。

## 78. 命名
`mcpResponser`ではなく、次のいずれかを使用する。

```text
mcpResponder
McpResponder
createMcpResponder
```

`responser`は避ける。今回はerror捕捉、normalization、WebMCP変換まで担当するため、`mcp-responder.js`が適切である。

## 79. 完了条件
次をすべて満たした場合だけ完了とする。

### 79.1 source、bundle、配信
* JavaScript sourceが`src/`以下へ移動している。
* `src/app.js`が単一entry pointである。
* `public/app.js`が単一bundleである。
* `public/app.js`を直接編集していない。
* `public/`に分割sourceがない。
* 自作moduleごとのHTTP requestがない。
* Worker sourceが原則として`public/app.js`へ文字列埋め込みされている。
* productionでWorkerごとのHTTP requestがない。
* localとPagesが同じ`public/app.js`を読む。
* local watch buildが動く。
* productionでminifyされる。
* production source mapが配信されない。
* `app.js`が二重minifyされない。
* `src/`と`node_modules/`がPages artifactへ含まれない。
* `npm ci`で再現可能である。
* bundle失敗時はdeployされない。

### 79.2 `coi-serviceworker.js`
* `public/coi-serviceworker.js`が独立fileである。
* `public/app.js`へbundleされていない。
* Worker文字列へ変換されていない。
* generic minify対象外である。
* MIT headerが保持されている。
* root scopeで登録される。
* secure contextでCross-Origin Isolationの成立を確認している。
* unsupported環境で無限reloadしない。

### 79.3 licenseとexternal algorithm
* external algorithmは完全なversion固定である。
* URLがallowlist化されている。
* SHA-256が固定されている。
* integrity不一致では実行しない。
* license、copyright、noticeを確認している。
* `THIRD_PARTY_NOTICES`が更新されている。
* CDN failureがdebugger全体へ波及しない。
* pixelmatchはpixel系だけに使用する。
* `hist`、`blk`、`edge`は外部libraryなしで動く。
* animation耐性はtrim付き`blk`、`edge`、`ssim-trim`で検証されている。

### 79.4 errorとWASM生存性
* 想定可能な失敗でJavaScript例外を投げない。
* 想定可能な失敗でC++例外を投げない。
* timeoutを`ok:false`として返す。
* invalid script sourceが`SCRIPT_SOURCE_INVALID`になる。
* script syntax errorが`SCRIPT_COMPILE_ERROR`になり、可能な範囲でlineとcolumnを返す。
* syntactically validな未定義identifierが`SCRIPT_RUNTIME_ERROR`と`ReferenceError`になる。
* Worker bootstrap、crash、protocol errorが専用codeへ分離される。
* `desmume.call`、`desmume.eval`、`desmume.runScript`のerror形式が同一である。
* MCP errorでWASM instanceを破棄しない。
* unexpected exception後もWASM instanceが使用可能である。
* error後も同じWASM instanceで`status`、`step`、`reset`、`reloadRom`を実行できる。
* compact outputに巨大stack traceがない。
* compact textとstructured contentが多重JSONになっていない。

### 79.5 operation
* timeout後にpauseする。
* timeout後に次commandを実行できる。
* operation競合がない。
* cleanupが一度だけ実行される。
* timer、listener、temporary ownerが残らない。
* input、touchが残らない。
* Workerが残らない。

### 79.6 breakpoint
* breakpoint owner管理が独立している。
* persistent scriptがuser breakpointを上書きしない。
* script trigger登録でuser breakpointを置換しない。
* script-only breakpointをdefaultで無視する。
* script-only breakpointだけなら`waitForBreak`は開始前に失敗する。
* mixed ownerは通常breakpointとして認識する。
* script callbackは従来どおり実行する。
* script明示pauseを勝手にresumeしない。
* script-only read、write breakpointから安全に継続できる。
* `waitForBreak`が古いbreakを誤認しない。
* `runUntil`が10回目のhitで停止できる。

### 79.7 screenとframe
* Stateロード直後のinvalid framebufferでcanvasを上書きしない。
* 直前の正常frameがある場合はcanvasを表示し続ける。
* breakpointでframe完了前に停止してもcanvasをblank、hide、clearしない。
* 正常frameが1回完了した後だけ画面取得APIが有効になる。
* raw frameをJS側独立bufferへcopyする。
* `captureFrame`のID保護が動く。
* `px`、`hist`、`blk`、`edge`が実装されている。
* `blk`が局所animationに耐える。
* `waitForScreenChange`が常にAと比較する。
* BやCへbaselineが移らない。
* `stableFrames`が正しく動く。
* timeout resultへ`maxPct`が含まれる。
* render無効時でも画面比較できる。
* user-visible breakpointで`BREAKPOINT_INTERRUPTED`になる。

### 79.8 input
* sequenceをIDだけで再利用できる。
* N秒連打できる。
* 複数buttonを扱える。
* frame holdを扱える。
* 同一IDの無断上書きを拒否する。
* error後に入力が残らない。
* success時に呼び出し前pause状態を復元する。

### 79.9 architectureとdocument
* `app.js`がentry point中心になっている。
* MCP response構築が`mcp-responder.js`へ集約されている。
* error codeが一元管理されている。
* command dispatchがregistry化されている。
* native exportの直接呼び出しがbridgeへ集約されている。
* 長時間operationがmanagerへ集約されている。
* frame comparisonが独立moduleである。
* input sequenceがinput serviceへ分離されている。
* UIとWebMCPが同じcommand実装を使う。
* 既存UI DOM、button、input、template、keyboard操作を再利用している。
* UI文言が内部仕様の長文説明ではなく、期待、操作、結果、次の行動を示している。
* 循環依存がない。
* `API.md`が実装前に更新されている。
* 自動生成documentが更新されている。
* `setSaveType`が削除されている。
* SPSRが推測変更されていない。
* 既存commandのregression testが通る。
* `AGENTS.md`が最後に最新手順へ更新され、既存Codespace build手順と`webassembly/build_safe_heap.sh`手順が維持されている。
* `build.cmd`が追加されていない。

### 79.10 既存仕様の完全維持
* 現行`API.md`、`window.DesmumeMCP.list()`、shortcutの互換性inventoryがある。
* 明示的な削除対象を除き、inventory上の全commandが同じ引数、default、戻り値、副作用で利用できる。
* 既存UI button、input、select、template、keyboard操作から同じ機能へ到達できる。
* 現行compact formatterのfield選別、短縮、件数制限が維持されている。
* stack traceとcall stackのC++側関連実装に差分がない。
* multi-frame検出、lane管理、public frame順序が維持されている。
* synthetic、observer、補助internal frameが外部へ公開されていない。
* persistent script同期modeの意味が維持され、性能調査結果と非同期queue modeの制約が文書化されている。
* この指示書に個別記載がないことを理由に既存機能を削除していない。

## 80. companion file
本統合指示書と同時に作成された`coi-serviceworker.js`を、内容を変更せず次へ配置する。

```text
public/coi-serviceworker.js
```

このfileは`coi-serviceworker v0.1.7`のMIT headerを含む。repository内でvendored third-party fileとして管理し、license notice対象へ含める。
