できる。既存実装にはすでに `main thread → supervisor Worker → sandbox Worker` と、その逆方向の認証済み通信経路があります。生の`postMessage`を永続スクリプトへ公開せず、この経路へ「MCP公開」「呼び出し」「結果返却」を追加するのが自然です。

# Codex実装指示：永続スクリプト公開MCP

## 目的

永続スクリプトが自身のWorker内に保持している処理を、通常のMCPコマンドおよび`desmume.eval`などのワンショットスクリプトから呼び出せるようにする。
想定用途はゲームUIオーケストレーターである。永続スクリプトが現在選択可能なアクションを列挙し、別のMCP呼び出しによって指定アクションを実行できる構成を可能にする。
既存のWorker分離、RPC allowlist、結果の正規化、WebMCPのコンパクト返却経路を維持すること。

## 追加する通常コマンド

次の2コマンドを`src/commands/script-commands.js`へ追加する。

* `listPScriptMcp`
* `callPScriptMcp`
  個別のBrowser WebMCPツールを動的登録してはならない。既存の`desmume.call`と`desmume.eval`から通常コマンドとして利用できるようにする。

### `listPScriptMcp`

入力:

```js
{
  scriptId?: number
}
```

出力:

```js
{
  mcps: [
    {
      scriptId: 1,
      scriptName: "game-ui-orchestrator",
      name: "listActions",
      description: "現在選択可能なゲームUIアクションを返します。"
    }
  ]
}
```

実行中かつ公開処理の登録が完了しているスクリプトだけを対象とする。
`scriptId`指定時は、そのスクリプトが公開しているMCPだけを返す。
停止済みスクリプトのMCPは返さない。

### `callPScriptMcp`

入力:

```js
{
  scriptId: 1,
  name: "listActions",
  params: {},
  blocking: true,
  timeoutMs: 3000
}
```

`scriptId`、`name`、`blocking`は必須とする。`blocking`を省略可能にして暗黙の既定値を設定してはならない。
`timeoutMs`の既定値は3000、許容範囲は1から600000とする。
成功時の出力:

```js
{
  scriptId: 1,
  scriptName: "game-ui-orchestrator",
  name: "listActions",
  blocking: true,
  value: [
    {
      id: "menu.item",
      label: "アイテム",
      enabled: true
    }
  ]
}
```

公開関数の戻り値をコマンドのトップレベルへ直接展開してはならない。必ず`value`へ格納すること。
公開関数が`{ ok: false }`などを返した場合でも、通常MCPの成功・失敗エンベロープとして誤認されないようにする。

## 永続スクリプト側の公開形式

永続スクリプトのトップレベル戻り値として、次の配列を受け付ける。

```js
return [
  {
    name: "listActions",
    description: "現在選択可能なゲームUIアクションを返します。",
    handler: async (params, context) => {
      return [];
    }
  },
  {
    name: "clickAction",
    description: "指定したゲームUIアクションを実行します。永続状態へアクセスするためblocking:trueが必要です。",
    handler: async ({ id }, context) => {
      if (!context.blocking) {
        throw new Error("clickAction requires blocking:true");
      }
      return { clicked: id };
    }
  }
];
```

公開定義は次の3要素を必須とする。

* `name`: MCP名
* `description`: 人間が用途を理解できる説明
* `handler`: 呼び出される関数
  `handler`が厳密にAsyncFunctionであるかを`.constructor`などで検査してはならない。`typeof handler === "function"`だけを検証し、呼び出し結果を常に`await`する。
  関数自体を`postMessage`しようとしてはならない。関数はsandbox Worker内の`Map`へ保持し、main threadへは`name`と`description`だけを送る。
  トップレベル戻り値が`undefined`または`null`の場合は、公開MCPなしとして扱い、既存スクリプトとの互換性を維持する。
  公開定義内で名前が重複している場合、定義が不正な場合、上限を超えた場合は、その永続スクリプトを通常のスクリプト実行エラーとして停止する。
  異なるスクリプト間では同じMCP名を許可する。呼び出し対象は必ず`scriptId`と`name`の組で特定する。

## `blocking`の意味

`blocking`はエミュレーターを自動的にpauseする指定ではない。
`blocking: true`は、公開関数の実行を次の処理と同じFIFOキューへ入れる指定とする。

* 永続スクリプトのブレークポイントコールバック
* tick以外の永続イベント
* 他の`blocking: true`公開MCP呼び出し
  これにより、公開関数が永続スクリプト内の変数、`Map`、`Set`、キャッシュ、現在のUI状態などへアクセスする場合に、他のコールバックと並行実行されないことを保証する。
  `blocking: false`は、永続イベントキューの完了を待たずに公開関数を開始できるモードとする。永続スクリプト内の共有状態を読み書きする公開関数では使用してはならない。
  JavaScriptのクロージャがどの変数へアクセスするかを実行基盤から完全に判定することはできない。したがって、これはスケジューリング契約として実装・文書化すること。自動的に状態アクセスを検出できるとは記載しない。
  `handler`の第2引数には、少なくとも次を渡す。

```js
Object.freeze({
  blocking: true
})
```

状態を使用する公開関数は、必要に応じて`context.blocking`を検証し、`blocking: false`を明示的に拒否できるようにする。
既存の`asyncMode`とは別の概念として扱う。

* `blocking: true`: 永続スクリプト内のJavaScript状態を直列化する。
* `asyncMode: false`: 即時のレジスタ・メモリ操作やpause/resumeを許可する既存モード。
  `blocking: true`を指定しただけで、`asyncMode: true`スクリプトの禁止コマンドを許可してはならない。

## Worker通信経路

既存の次の経路を拡張する。

```text
main thread
  ↕
persistent-script-supervisor.worker.js
  ↕
persistent-script.worker.js
```

永続スクリプトへ生の`postMessage`、`addEventListener`、`Worker`などを再公開してはならない。

### sandbox Workerからsupervisorへの追加メッセージ

次の内部メッセージを追加する。

* `pscriptMcpPublished`
* `pscriptMcpResult`
  `pscriptMcpPublished`には関数を含めず、正規化済みの`name`と`description`だけを含める。
  `pscriptMcpResult`には呼び出しIDと、正規化済みの結果または正規化済みのエラー情報を含める。

### main threadからsupervisorへの追加メッセージ

次の内部メッセージを追加する。

* `pscriptMcpInvoke`
  含める情報:

```js
{
  type: "pscriptMcpInvoke",
  callId,
  name,
  params,
  blocking
}
```

supervisorは呼び出しIDの重複、同時呼び出し数、値の境界を検証してからsandboxへ転送する。
sandboxからの結果を受け取った時点で、対応するpending IDを削除する。
既存のsandbox発MCP RPC用IDと、公開MCP呼び出し用IDは別の集合または別の名前空間で管理する。

## sandbox Worker内の実行

`persistent-script.worker.js`へ公開関数用の`Map`を追加する。
トップレベルスクリプトの実行結果を受け取った後、公開定義を検証し、関数をWorker内へ保持する。
現在の`eventQueue`を、イベントと`blocking: true`公開MCP呼び出しを処理できる共通work queueへ拡張する。
共通キュー内では次を保証する。

* 1件ずつ処理する。
* 前の処理が返したPromiseのsettlementを待つ。
* 公開関数から行われる`mcp.call()`のreplyは、公開関数の完了待ち中でも通常どおり受信・解決できる。
* イベントに対してだけ既存の`eventProcessed`および`eventDone`を送る。
* 公開MCP呼び出しに対しては必ず1件だけ`pscriptMcpResult`を返す。
  `blocking: false`呼び出しは共通work queueへ入れずに開始してよいが、同時実行数を必ず制限する。

## main thread側の状態

各scriptレコードへ次相当の状態を追加する。

```js
{
  pscriptMcps: new Map(),
  pendingPScriptMcpCalls: new Map(),
  nextPScriptMcpCallId: 1,
  pscriptMcpPublished: false
}
```

グローバルな関数レジストリへhandlerを置いてはならない。
`pscriptMcps`にはmain threadへ送られたメタデータだけを保持する。
スクリプト停止時、再起動時、Worker異常終了時には次を必ず行う。

* 公開MCPメタデータを破棄する。
* pending呼び出しをすべて失敗させる。
* timeoutを解除する。
* 遅れて届いた結果を無視する。
  同名スクリプトの再実行ではscript IDが再利用される場合があるため、メッセージ処理時に次を確認する。

```js
script.running
state.scripts.get(script.id) === script
```

古いWorkerからの遅延メッセージで、新しいscriptレコードを更新してはならない。

## timeoutと異常終了

公開MCP呼び出しがtimeoutした場合は`TIMEOUT`を返し、その永続スクリプトを停止する。
timeout後もWorker内で処理が継続し、共有状態やキューの整合性が不明になる状態を残してはならない。
公開関数が通常の例外をthrowした場合は、呼び出し単位で`SCRIPT_RUNTIME_ERROR`を返す。通常のhandler例外だけでスクリプト全体を停止する必要はない。
次の場合はWorkerプロトコル異常としてスクリプトを停止する。

* 未知の呼び出しID
* 重複した結果
* 不正な公開定義
* 正規化できないメタデータ
* 結果境界を超えた値
* supervisorとsandbox間の認証不一致
  `SCRIPT_MCP_NOT_FOUND`を`src/error-codes.js`へ追加し、存在しないscript IDまたはMCP名に使用する。
  公開処理がまだ登録されていない実行中スクリプトに対する呼び出しは`BUSY`とし、`published: false`をdetailsへ含める。

## 値の正規化

新しい独自シリアライザーを実装してはならない。
既存の次を再利用する。

* `normalizeStructuredValue`
* `normalizeBoundedValue`
* `normalizeWorkerProtocolValue`
* `readOwnDataProperty`
  公開MCPの入力と出力は、最低でも次の箇所で正規化する。

1. main threadが`pscriptMcpInvoke`を送る直前
2. supervisorがsandboxへ転送する直前
3. sandboxがhandlerへparamsを渡す直前
4. sandboxがhandler結果を送る直前
5. supervisorがmain threadへ結果を転送する直前
6. main threadがpending Promiseを解決する直前
   公開定義の検査では、未検証オブジェクトに対してオブジェクトスプレッドや`Object.assign`を使用してはならない。
   各フィールドはown data propertyとして読み取る。
   アクセサーを含む定義は拒否する。
   正規化後のオブジェクトは、既存のnormalizerと同様にnull prototypeのdata objectとする。
   handlerの戻り値に対して、正規化前に`JSON.stringify`を呼び出してはならない。
   通常のWebMCP返却時だけ、既存の`mcp-responder.js`によるコンパクト形式への変換を使用する。
   `callPScriptMcp`専用の文字列化処理を新設してはならない。
   配列は配列のまま`structuredContent`とワンショットスクリプトへ返すこと。

## リソース上限

`src/resource-limits.js`へ明示的な上限を追加する。
推奨値:

```js
persistentMcpEndpointsPerScript: 32,
pendingPersistentMcpCallsPerScript: 16,
persistentMcpNameChars: 64,
persistentMcpDescriptionChars: 2048,
persistentMcpParamsBytes: 256 * 1024,
persistentMcpResultBytes: 1024 * 1024
```

MCP名は次の形式に制限する。

```text
^[A-Za-z][A-Za-z0-9._-]{0,63}$
```

descriptionは空文字を拒否し、前後の空白を除去する。

## RPC allowlist

`callPScriptMcp`と`listPScriptMcp`はワンショットスクリプトから使用可能にする。
`src/script-rpc-policy.js`では次のようにallowlistを分離する。

```js
export const EVAL_RPC_ALLOWLIST = new Set([
  ...COMMON_COMMANDS,
  "listPScriptMcp",
  "callPScriptMcp"
]);
export const PERSISTENT_RPC_ALLOWLIST = new Set(COMMON_COMMANDS);
```

永続スクリプト自身から`callPScriptMcp`を呼べるようにしてはならない。自己呼び出し、相互呼び出し、blocking queue待ちによる循環を今回の実装へ持ち込まないこと。
`listPScriptMcp`はfile transaction中の読み取り許可コマンドへ追加してよい。
`callPScriptMcp`は公開関数がエミュレーター状態を変更する可能性があるため、file transaction中の許可コマンドへ追加してはならない。

## 人間向けの可読性

公開MCPのdescriptionは必須とし、`listPScriptMcp`で常に返す。
スクリプト一覧のUI表示へ、公開MCP数を追加する。
例:

```text
game-ui-orchestrator · running · 2 triggers · 2 MCPs
```

MCP公開時と呼び出し時には、永続スクリプトの既存コンソールへ短いログを追加する。
ログへparams全体や戻り値全体を自動出力してはならない。
例:

```text
MCP published: listActions
MCP call: clickAction · blocking=true
```

ゲーム状態、選択可能なアクション、選択位置などの意味的な状態変化は基盤側で自動判定できない。
永続スクリプト作者が、状態の変化を検出したときだけ`print(...)`で人間向けの内容を出力する契約とする。
tickごとに同じ状態を繰り返し出力させてはならない。
公開関数の戻り値も、人間とAIの双方が理解できる名前付きオブジェクトまたは配列にするよう文書化する。

## ワンショットスクリプトからの利用例

```js
const published = await mcp.call("listPScriptMcp", {});
const target = published.mcps.find((item) => item.name === "listActions");
if (!target) throw new Error("listActions is not available");
const response = await mcp.call("callPScriptMcp", {
  scriptId: target.scriptId,
  name: target.name,
  params: {},
  blocking: true,
  timeoutMs: 3000
});
return response.value;
```

アクション実行例:

```js
return await mcp.call("callPScriptMcp", {
  scriptId: 1,
  name: "clickAction",
  params: {
    id: "menu.item"
  },
  blocking: true,
  timeoutMs: 3000
});
```

## 変更対象

最低限、次のファイルを変更する。

* `src/script-service.js`
* `src/commands/script-commands.js`
* `src/commands/command-factory.js`
* `src/workers/persistent-script.worker.js`
* `src/workers/persistent-script-supervisor.worker.js`
* `src/worker-rpc-payload.js`
* `src/script-rpc-policy.js`
* `src/resource-limits.js`
* `src/error-codes.js`
* `src/command-dispatcher.js`
* `src/api-descriptions.js`
* 関連テスト

## 文書更新

次の文書へ新APIと契約を記載する。

* `webassembly/API_CURRENT.md`
* `webassembly/API_COMPATIBILITY_INVENTORY.md`
* `webassembly/AI_Analyze.md`
* 必要なら`webassembly/LocalAI_System.md`
* `handoff.md`
  文書には必ず次を明記する。
* 公開定義の戻り値形式
* `listPScriptMcp`と`callPScriptMcp`の入力・出力
* `blocking`がエミュレーターのpauseではなく、永続スクリプト内の共有状態を直列化する指定であること
* 共有状態へアクセスするhandlerは`blocking: true`で呼ぶこと
* `asyncMode:false`とは別の契約であること
* 状態が変化したとき、永続スクリプトが`print`で人間向けに出力すること
* ワンショットスクリプトへは公開関数の戻り値が`response.value`として返ること

## テスト

既存テストの形式に合わせ、少なくとも次を追加する。

1. 永続スクリプトが2件のMCPを公開し、`listPScriptMcp`で名前と説明を取得できる。
2. ワンショットスクリプトから`callPScriptMcp`を呼び、配列の戻り値を`value`として取得できる。
3. handlerが`{ ok: false }`を返しても、通常コマンドの失敗結果として扱われず`value`内へ保持される。
4. `blocking: true`の2呼び出しと永続イベントが同一FIFOで実行される。
5. handlerへ渡される`context.blocking`が呼び出し値と一致する。
6. 重複したMCP名を持つ公開定義が拒否される。
7. スクリプト停止時に公開MCPが一覧から消える。
8. スクリプト停止時にpending呼び出しが解決待ちのまま残らない。
9. timeout時に呼び出しが`TIMEOUT`となり、対象スクリプトが停止する。
10. 遅延結果が、同じIDで再作成された新しいscriptレコードへ適用されない。
11. `desmume.eval`相当のallowlistでは呼び出せるが、永続スクリプトのallowlistからは呼び出せない。
12. 通常の`responder.toWebMcpContent`を通してコンパクトテキストと`structuredContent`が生成される。
    サンドボックス攻撃用コード、prototype操作用コード、特殊なアクセサー、Proxy、循環値、極端な深さやサイズを生成するテストは追加しない。
    既存のnormalizerを通ることと、境界ごとに正規化処理が配置されていることを通常の値で検証する。

## 完了条件

* 永続スクリプトが公開した関数を通常MCPおよびワンショットスクリプトから呼び出せる。
* 配列を含む戻り値が通常のMCP返却経路でコンパクト化される。
* handler関数がWorker外へ出ない。
* main threadおよび基盤側のprototypeが公開値によって変更されない。
* `blocking: true`呼び出しが永続イベントと直列化される。
* 停止、再起動、timeout、Worker異常終了後にpending呼び出しが残らない。
* 既存の永続スクリプト、`desmume.eval`、イベント処理、RPC allowlistの挙動を破壊しない。
* `npm test`、JavaScript構文チェック、production buildが成功する。

## 非目標

* 永続スクリプトへ生のWorker通信APIを公開しない。
* 永続スクリプトごとにBrowser WebMCPツールを動的登録しない。
* `blocking: true`によって既存の`asyncMode`制限を迂回させない。
* 永続スクリプト同士のMCP呼び出しは実装しない。
* 永続状態へのアクセスを静的または動的に自動検出しない。
* 今回の変更でsandbox境界そのものを再設計しない。

その通りです。前者は明確に不適切な副作用で、後者はnormalizerの再利用だけを書いて肝心の安全条件を明文化できていません。元の指示ではtimeout時に永続スクリプトを停止すると明記され、テストにも同じ誤りが入っています。 また、prototypeについては完了条件に一文あるだけで、各境界が守るべき不変条件として定義されていません。
次をCodexへ追加指示として渡してください。

# Codex修正指示：timeoutの無副作用化とprototype保護の明文化

既存の「永続スクリプト公開MCP」実装指示について、次の2点を修正すること。

## 1. timeoutによって永続スクリプトを停止してはならない

`callPScriptMcp`のtimeoutは、呼び出し元が結果を待つ時間の上限だけを表す。
timeoutによって、次の処理を行ってはならない。

* 永続スクリプトを停止する。
* sandbox Workerまたはsupervisor Workerを終了する。
* 実行中のhandlerを強制中断する。
* 永続スクリプトのイベントキューを破棄する。
* 公開MCP一覧を削除する。
* 永続スクリプト内の状態を初期化する。
* timeoutした呼び出しより後ろにある処理を意図的に失敗させる。
  呼び出し元のtimeoutが成立した時点では、その呼び出しに対して`TIMEOUT`を返すだけとする。

```js
{
  code: "TIMEOUT",
  message: "Persistent script MCP call timed out.",
  details: {
    scriptId,
    name,
    timeoutMs
  }
}
```

handlerはsandbox Worker内でそのまま実行を継続してよい。
`blocking: true`のhandlerがtimeout後も実行中の場合、FIFOキューはそのhandlerのsettlementまで通常どおり待つ。timeoutを理由としてキュー順序を変更したり、次の処理を並行実行したりしてはならない。
これは、timeoutを呼び出し元の待機制御とし、永続スクリプトの実行制御には使用しないという契約である。

### timeout後の遅延結果

timeout後にsandbox Workerから結果が返ることは正常系として扱う。
遅延結果を「未知の呼び出しID」や「重複結果」としてプロトコル異常にしてはならない。
main threadまたはsupervisorは、timeout済みの呼び出しIDを一定期間識別できるbounded tombstoneへ移す。
例:

```js
{
  expiredPScriptMcpCalls: new Map()
}
```

timeout時の処理:

1. 呼び出し元のPromiseを`TIMEOUT`でrejectする。
2. 通常のpending callerから削除する。
3. call IDをtimeout済みとしてbounded tombstoneへ記録する。
4. 永続スクリプトおよびWorkerには停止命令を送らない。
   遅延結果受信時の処理:
5. timeout済みcall IDなら結果を破棄する。
6. tombstoneからcall IDを削除する。
7. スクリプト状態、ログ、公開MCP一覧を変更しない。
8. プロトコル異常として扱わない。
   tombstoneには件数上限と保持時間を設ける。上限超過時は古い項目から削除してよい。
   古いtombstoneが削除された後に非常に遅い結果が届いた場合も、現在実行中のscript instanceと一致している限り、未知IDだけを理由に永続スクリプトを停止してはならない。警告ログを残して破棄する。

### script instanceの識別

call IDだけで呼び出しを識別してはならない。
少なくとも次の組で識別する。

```text
scriptId + scriptInstanceId + callId
```

`scriptInstanceId`は永続スクリプトの起動ごとに新しく生成する。
再起動前のWorkerから届いた結果は、現在のscript instanceへ適用せず破棄する。

### timeoutに関する停止条件

通常のMCP呼び出しtimeoutは停止条件から除外する。
永続スクリプトを停止してよいのは、既存の明示的停止操作、Worker自体の異常終了、初期化不能、または既存方針で停止対象となっている実際のプロトコル破損だけとする。
handlerの処理時間が長いこと、handlerが未settledであること、呼び出し元が待機を打ち切ったことは、プロトコル破損ではない。

## 2. シリアライズ処理によるprototype汚染を絶対に発生させない

公開MCPのparams、戻り値、metadata、エラーdetailsについて、シリアライズ、正規化、コピー、コンパクト化、Worker転送のどの段階でも、main thread、supervisor Worker、sandbox Worker、通常MCP返却層の重要prototypeを変更してはならない。
この要件は単なる入力検証ではなく、実装全体の不変条件とする。

### 保護対象

少なくとも次のprototypeおよび同等の組み込みprototypeを、公開MCP値によって変更可能な実装にしてはならない。

* `Object.prototype`
* `Array.prototype`
* `Function.prototype`
* `Map.prototype`
* `Set.prototype`
* `Promise.prototype`
* Error系prototype
* Worker通信およびMCP返却に使用する内部クラスのprototype
  入力値に含まれる文字列を、prototype、constructor、クラス、グローバルオブジェクト、組み込み関数を参照するための制御情報として解釈してはならない。
  入力値のキーは、正規化後も単なるデータキーとして扱うか、既存normalizerの規則に従って安全に拒否する。

### オブジェクト生成

未信頼値から正規化済みオブジェクトを作る場合は、通常prototypeを持つ空オブジェクトへ代入してはならない。
正規化済みdata objectは、原則として次の形式で生成する。

```js
const output = Object.create(null);
```

プロパティ追加には、prototype setterを起動し得る一般的な代入処理を使用しない。
検証済みの文字列キーをown data propertyとして定義する。

```js
Object.defineProperty(output, key, {
  value,
  enumerable: true,
  configurable: true,
  writable: true
});
```

既存normalizerが同等以上の保証を持つ場合は、その実装を再利用してよい。
ただし、再利用するという理由だけでprototype安全性の確認を省略してはならない。

### 禁止するコピー処理

未信頼値または正規化前の値に対して、次を使用してはならない。

* オブジェクトスプレッド
* `Object.assign`
* `for...in`
* prototype chainを参照するメンバー取得
* 任意キーを通常オブジェクトへ代入する処理
* 独自の再帰的JSON互換コピー
* 正規化前の`JSON.stringify`
* 入力値が提供するメソッドの呼び出し
  列挙にはown enumerable data propertyだけを対象とする安全な既存処理を使用する。
  プロパティ値の取得時にgetterやsetterを実行してはならない。

### 公開定義の検証

永続スクリプトが返す公開MCP定義について、`name`、`description`、`handler`を通常のプロパティアクセスで取得してはならない。
既存の`readOwnDataProperty`または同等の安全な処理を使用する。
アクセサープロパティ、継承プロパティ、型が一致しない値は拒否する。
handler関数はsandbox Worker内だけに保持し、Worker境界を越えて転送しない。
metadataへ変換するときは、新しく生成した安全なdata objectへ、検証済みの文字列値だけを格納する。

### paramsの処理

`callPScriptMcp`が受け取ったparamsは、main threadで安全な値へ正規化してからWorkerへ送る。
各Worker境界でも、受信値を信頼済みとして扱わず、既存のWorkerプロトコルnormalizerを通す。
sandbox Workerでhandlerへ渡すparamsも、受信メッセージの元オブジェクトを直接渡さず、最終的に正規化された独立値を渡す。
handlerへ渡したparamsから、main threadまたはsupervisor Workerが保持するオブジェクトへ参照が共有されてはならない。

### handler戻り値の処理

handler戻り値を通常MCP返却用オブジェクトへ直接マージしてはならない。
戻り値は安全なnormalizerを通した後、基盤側で新しく生成した返却エンベロープの`value`へown data propertyとして格納する。

```js
{
  scriptId,
  scriptName,
  name,
  blocking,
  value: normalizedValue
}
```

上記は論理形式の例であり、実際のオブジェクト生成では既存の安全なdata object生成処理を使用する。
handler戻り値のキーによって、返却エンベロープの`ok`、`code`、`message`、`details`、prototype、constructorなどが上書きされる構造にしてはならない。

### エラー値の処理

handlerがthrowした値を、そのままmain threadへ転送してはならない。
既存の安全なエラー正規化処理を通し、許可された文字列や安全なdetailsだけを新規data objectへ格納する。
throwされた値のprototype、独自メソッド、getter、列挙処理に依存してはならない。

### コンパクト形式への変換

WebMCP向けコンパクト形式への変換は、安全な構造化値の正規化が完了した後に限って行う。
コンパクト化処理は、入力値を通常オブジェクトへマージしたり、prototype chain上の値を参照したりしてはならない。
コンパクトテキスト生成に失敗した場合も、入力値のメソッドを呼び出して代替文字列を生成してはならない。

### 既存normalizerの監査

次の既存処理を名前だけ再利用して完了としてはならない。

* `normalizeStructuredValue`
* `normalizeBoundedValue`
* `normalizeWorkerProtocolValue`
* `readOwnDataProperty`
  Codexは各実装を読み、少なくとも次を確認する。

1. 出力オブジェクトがnull prototypeまたは同等に安全である。
2. 未信頼キーを通常オブジェクトへ代入していない。
3. getterおよびsetterを実行しない。
4. inherited propertyを読まない。
5. 入力値のメソッドを呼ばない。
6. 配列要素とオブジェクト値の両方へ深さ、件数、文字数、byte数の上限が適用される。
7. エラー経路でも未正規化値をログ、details、返却値へ混入させない。
   既存normalizerがこの条件を満たさない場合は、公開MCP側だけに場当たり的な回避処理を追加せず、既存normalizerを安全な共通実装へ修正する。
   ただし、既存APIの正常値に対する互換性を破壊しない。

## 修正後のテスト要件

既存テスト項目9を次に置き換える。
9. timeout時に呼び出し元だけが`TIMEOUT`となり、対象の永続スクリプト、Worker、公開MCP一覧、永続状態が維持される。
   次のテストを追加する。
10. timeout後にhandlerが完了して遅延結果が届いても、プロトコル異常にならず、永続スクリプトが停止しない。
11. timeoutした`blocking: true`呼び出しはhandlerのsettlementまでFIFO上の位置を維持し、後続処理を追い越さない。
12. timeout後も別の公開MCPを呼び出せる。
13. 再起動前のscript instanceから届いた遅延結果が、新しいinstanceのpending呼び出しへ適用されない。
14. 公開MCPのparams、戻り値、metadata、エラーdetailsが、既存の安全なnormalizerを通過する。
15. 正規化後のdata objectがnull prototypeまたは既存実装上同等に安全な形式である。
16. 未信頼値を通常オブジェクトへスプレッド、`Object.assign`、`for...in`、任意キー代入している経路が存在しないことをコードレビューおよび通常値テストで確認する。
    サンドボックス攻撃用コード、prototype操作用コード、アクセサー、Proxy、循環値、極端なサイズや深さを生成するテストは追加しない。
    禁止入力そのものを実行するテストではなく、安全な共通normalizerが全境界で使用されていること、出力コンテナのprototype、own propertyの扱い、timeout後の状態維持を通常値で検証する。

## 修正後の完了条件

* `callPScriptMcp`のtimeoutは呼び出し元の待機だけを終了し、永続スクリプトへ停止、再起動、状態初期化などの副作用を与えない。
* timeout後の遅延結果は正常に破棄され、プロトコル異常として扱われない。
* `blocking: true`のFIFO契約は、呼び出し元のtimeout後も変化しない。
* 公開MCP値のシリアライズ、正規化、Worker転送、返却エンベロープ生成、コンパクト化の全経路でprototype汚染が発生しない。
* 入力値のキーまたは値によって、基盤側のprototype、constructor、通常MCP返却エンベロープ、内部状態が上書きされない。
* 安全性が既存normalizerの名称ではなく、実装上の不変条件として確認されている。

なお、元指示の「未知の呼び出しIDならスクリプト停止」も、timeout後の遅延結果と衝突します。未知ID単独では停止せず、現在のscript instance、認証情報、メッセージ形式まで含めて本当にプロトコル破損かを判定する必要があります。

