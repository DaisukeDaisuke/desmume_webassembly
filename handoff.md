# Handoff Notes

- ファイル書き込みは必ず `apply_patch`。生成物以外をコマンド置換で編集しない。
- `gh codespace cp` を使う場合は必ず `-e` を付ける。
- `public/desmume.js` は生成物。基本は `webassembly/wasm-port.cpp` と `public/index.html` を直してビルドで再生成する。
- 前回の作業では、`old/desmume` サブモジュール未初期化と `emcc` 未導入でCodespaceビルドが失敗した。Codespaceでビルドするなら `git submodule update --init old/desmume` と Codespace内だけの `sudo apt-get install -y emscripten > /dev/null 2>&1` が必要だった。
- ローカル `file://` で開くと `coi-serviceworker.js` は登録失敗する。これはプロトコル制約で、HTTP/GitHub Pagesの問題とは分けて扱う。
- これはhttps://daisukedaisuke.github.io/desmume_webassembly/を直接見にに行けばいい。ファイルを同期してから、codespace側でコミットして、push、ghコマンドでworkflow終了まで待ち、それからhttps://daisukedaisuke.github.io/desmume_webassembly/に見に行く。
- `EMUFILE_MEMORY` に `changed` メンバーは無い。セーブ変更検知に使わない。
- セーブインポートは `savImportFromFile(forceSize)` にファイルサイズを渡す方針。
- ステートロードはリセットなしで `loadStateFromBuffer()` する方針。停止中なら停止状態を維持する。
- タッチはDS下画面だけが有効。上画面クリックを座標に入れない。
- 音声は `44100` Hz基準で、倍速時は生成サンプル量と `AudioBufferSourceNode.playbackRate` を速度に連動させる。
- 停止中に重い場合は `requestAnimationFrame` を常時回さず、停止中だけ低頻度タイマーに落とす。
- キー設定の現行デフォルト方針: `KeyX=A`, `KeyZ=B`, `KeyA=X`, `KeyS=Y`, `KeyQ=L`, `KeyW=R`, `Enter=Start`, `ShiftRight=Select`。
- メモリ検索は `searchMemory` / `resetMemorySearch`。初回検索とRefineを分け、Refineは前回候補だけを絞り込む。
- `AGENTS.md` や未追跡の `.gitignore`, `CMakeLists.txt`, `main.cpp` はユーザー由来の可能性がある。勝手に戻さない。
- remote:/workspaces/desmume_webassembly/webassembly/wasm-port.cppが正しいremote url。
- 環境未初期化のcodespaceが渡される場合があるので、その場合は勝手に初期化してよい。

## 2026-06-17 Addendum

- スタックトレースは SP 周辺ダンプではなく、`registerenterfunc` Lua フック相当の関数入口記録が主目的。WASM では `OP_STMDB_W` と `OP_PUSH_LR` から `wasmEnterFunctionHook()` を呼び、`wasm-port.cpp` 側の call stack に `caller/lr`, `callee`, `sp`, `cpsr`, thumb状態, 同一callee内idを記録する。
- `traceSetEnabled(0)` は call stack と call count をクリアする。IRQ除外は `traceSetPrivilegeCheck()` で切り替える。
- ブレークポイントは UI/API とも id 管理。アドレス文字列 `20cb6c4` / `020cb6c4` は 10進ではなく16進として扱う。
- `setCTable_jp.lua` 相当は JS/API の `setCTableSeed` で実装可能。既定では `0x02385f0c = 0x4b539adb`, `0x02385f10 = 0` を書く。
- 最近読み込んだ save/state は最大6件を id 付きで保持し、`reloadRecentFile` から再ロードできる。
- ステートロード前に `reset()` しないこと。ステートは CPU/PC を含む完全状態なので、reset 後に読むと PC や周辺状態が壊れて無限ループ化しやすい。セーブロードだけは、カートリッジ保存領域を反映するため import 後に `reset()` する。
- ブレークポイントはヒットしたら必ず `paused=true` にする。実行ブレークは `armcpu_exec()` の命令実行前、read/write は MMU の実アクセスで止める。GUI のメモリビューワーは `MMU_AT_DEBUG` 読みなので read breakpoint を発火させない。
- data abort / prefetch abort / undefined instruction はエミュレーター破棄ではなく、最後の発生元 PC/CPSR を `status().native.lastBreak` に残して停止する。
- call stack UI は SP ダンプではなく `dbgCallStackJson()` の `frames` を表で出す。callee の Jump は disassembler address に入れるだけで、PC は変更しない。
- 2026-06-17: save/stateロード中は `loadingFile` で実行ループと自動 `.sav` slot保存を止め、WASM側を `pauseEmu(1)` にしてから import/reset/loadState する。ロード後は直前のrun/pause状態へ戻す。走行中のまま保存領域やsavestateバッファを触ると公開ページでメインスレッドが固まりやすい。
- 2026-06-17: セーブimport後に `NDS_Reset()` だけを呼ぶとARM9 PCが `0x0f000000` 付近へ飛び、WASMが `table index is out of bounds` で壊れる。セーブ反映は選択済みROMを `loadROM()` し直す経路にする。
- 2026-06-17: `MMU_new.backupDevice.importData()` をROM実行後に呼んでも同じPC破壊が起きた。Webのセーブ入力は `importData()` を使わず、WASM FSの `rom.sav` / `rom.dsv` を置き換えてから `loadROM()` し直す方式にする。
- 2026-06-17: 外部ステートは `stateGetPointer(size)` 後にJSがHEAPへ書く。`loadStateFromBuffer(size)` 側で再度 `truncate(size)` するとEMUEFILE_MEMORY内の読み込み済みバイトが壊れ、`savestate_load()` が `-1` になる。ロード側はサイズ一致確認と `fseek(0)` のみにする。
