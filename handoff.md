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
