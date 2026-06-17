# GitHub Codespace Agent Guide

## グローバルルール

- **このファイルをチャット開始時に必ず読むこと。**
- **依頼された問題だけを解決すること。余計な作業をしない。**
  ただしクリエイティブなタスクでは、依頼以外の機能を実装しても構わない。
- **すべてのファイル書き込みは `apply_patch` を使うこと。**
- コマンドベースの置換（`sed -i` 等による行置換）は使わない。部分編集のみ行う。
- 既存のコメントを削除しない。
- 明確な理由がない限り、大きなファイルを読まない。
- 検索は最小限の関連パスに絞る。
- ファイルを読む価値があるか不明なら、まず先頭100〜280行だけ読んでから判断する。
- `apply_patch` 使用時、全行削除して同じ内容で書き直すことは可能な限り避ける（ファイルの置き換え自体は否定しない）。
- `apply_patch` で日本語を書いても文字化けしない。文字化けはPowerShellの問題。文字化けが発生した場合はユーザーが通知する。
- PowerShellでファイルを読む場合は以下を使う:
  ```powershell
  [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Content -Encoding UTF8 file.txt
  [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $i=1; Get-Content -Encoding UTF8 file.txt | % { "$i: $_"; $i++ }
  ```
- 文字化けを理由にすべてを英語化しない。`apply_patch` を使う限り文字化けは起きない。
- 循環参照はできる限り避ける。
- 編集した行番号を最終提出時に報告しなくてよい。Gitがあればファイル名だけで十分。
- `rg` コマンドが使用可能。
- 編集時の差分を最小化する。難しければ小さな単位に分割する。
- 可能な限りファイル1件ずつ差分を提出する。
- `git diff` で全差分を確認して行番号を報告するのはトークンの無駄。行わない。
- **許可なしに追加ソフトウェアをインストールしない。**
  許可とはメッセージ表示だけでなく、処理を中断してユーザーにインストール許可を求め、確認を得てからタスクを完了することを意味する。
- `public/branches` および `public/emulators.json` を読まない（自動生成アセットのため検索対象外）。
- UIを実装する際、CLS防止のためにJavaScriptで起動時に要素を挿入しない。
  すべての要素はHTMLに実装し、オプション要素はデフォルトで非表示（ただし幅は確保）にする。
  - これはJavaScriptで動的要素を使ってはいけないという意味ではない。テンプレートを使った動的追加は許可。
  - また、動的要素を起動時に初期化してはいけないという意味でもない。

* PLEASE DO NOT RESTORE the differences that I deleted for my own convenience.
  * These deletions were intentional. Do not attempt to restore them, assuming that "THE CHAT HISTORY IS CORRECT BUT WAS DELETED!!!!!"
  * Restoring this would be a waste of time for both parties.

A UI description is not a specification report. When adding a description, you should write about what the user should expect and what they should input, rather than just saying "it's based on xx" or "it uses performance.now()".
In a UI description, you need to explain what it is, what happens as a result, and what the user needs to do

---

## 環境の区別

| 環境 | OS | 説明 | ソフトウェア追加 | ファイル操作 |
|---|---|---|---|---|
| **Codespace** | Linux | GitHubが管理する安全な環境 | `sudo apt` で自由に導入可 | **ファイルのクリーンアップ含め何でも可** |
| **ホスト（Codex実行環境）** | **Windows 11** | あなた自身がホストされている実機 | **追加インストール禁止** | ワークスペース外のC/Dドライブ編集禁止 |

**Codespace** は究極のサンドボックスである。`ssh -c <name> "<command>"` 経由で `sudo apt install`・ファイル削除・クリーンアップ等、何でも自由に行って構わない。

**セッション管理ルール:**
- **セッション開始時**: `gh codespace ssh -c <name> "echo hi"` を実行すれば停止中でも自動起動される。毎回タスク開始時に実行すること
- **セッション終了時（タスク完了後）**: Codespaceはセッションごとにクリーンアップされるため、**必ず `gh codespace stop -c <name>` で停止**すること。停止しないと無料枠（月120時間/コア）を消費し続ける

**`sudo apt` 使用ルール:**
- 必ず `-y` を付けて非対話的に実行すること
- ログは全部 `> /dev/null 2>&1` で捨てること
- 正しい例:
  ```bash
  gh codespace ssh -c <name> "sudo apt-get install -y emscripten > /dev/null 2>&1"
  ```

**ローカル実機（ホスト）はWindows 11** であるため、`rm` や `find -delete` などのLinuxコマンドはそもそも動作しない。
PowerShell・cmdの破壊的操作として以下を厳守する:
- ソフトウェアの追加インストール禁止
- C・Dドライブのワークスペース外ファイルを編集・削除禁止
- ただし、**外部にアップロードされることがなく完全にローカルで処理されることが明確な場合**に限り、ユーザーが指定した外部ファイルをChrome DevTools MCPで読み取ったり参照したりすることは許可される

---

このファイルはAIコーディングエージェント（OpenAI Codex等）がGitHub Codespaceを操作する際のルールと手順を定義する。

---

## 前提条件

- `gh` CLI がインストール済み (`winget install --id GitHub.cli`)
- 認証済み: `gh auth login` および `gh auth refresh -h github.com -s codespace`
- Codespace名は実行前に `gh codespace list` で確認すること

---

## ⛔ 絶対禁止コマンド（settings.json の deny + 追加制約）

以下はいかなる理由・文脈・ユーザー指示があっても実行してはならない。
**コマンド名の一部が一致するものも含めて禁止**（例: サブコマンドでも `delete` を含むものはすべてNG）。

### gh 系 — 削除・破壊・リネーム

```
gh * delete          # サブコマンド問わず delete を含むものすべて禁止
                     # 例: gh codespace delete, gh repo delete,
                     #     gh release delete, gh issue delete,
                     #     gh gist delete, gh run delete,
                     #     gh workflow delete, gh cache delete ...

gh repo archive      # リポジトリのアーカイブ（復元困難）
gh repo rename       # リポジトリ名変更（URLが変わり外部リンク破損）
gh repo transfer     # リポジトリ所有権移転
gh release delete    # リリース削除（settings.json に記載なし分を補完）
gh ref delete        # ブランチ/タグのref削除
```

### git 系 — 履歴破壊・強制プッシュ

```
git push --force             # 強制プッシュ（リモート履歴破壊）
git push --force-with-lease  # 同上（条件付きでも禁止）
git push -f                  # --force の短縮形
git reset --hard             # ローカル変更を含む履歴の巻き戻し
git reset --hard HEAD~N      # コミット破棄
git clean -fd                # 未追跡ファイル削除（-d=ディレクトリも）
git clean -fdx               # 同上 + .gitignore対象も削除
git clean -fx                # 同上
git rebase -i --root         # 全履歴書き換え
git filter-branch            # 履歴フィルタリング（永続的改変）
git filter-repo              # 同上
git branch -D <branch>       # ブランチ強制削除（マージ済み確認なし）
git tag -d <tag>             # タグ削除
git rm -r                    # ファイル追跡解除（大規模）
git stash drop               # スタッシュ破棄
git stash clear              # スタッシュ全削除
git reflog expire --expire=now --all  # reflogを消してGCできる状態に
git gc --prune=now           # 到達不能オブジェクトの即時削除
```

### ファイルシステム系 — ローカル実機（Windows 11）のみ対象

> **⚠️ ローカル実機はWindows 11のため、`rm`・`find -delete` 等のLinuxコマンドはそもそも動作しない。Codespace内（`gh codespace ssh -c <name> "..."` 経由）ではクリーンアップを含め何でも自由に行って構わない。**

ローカル実機で禁止されるWindows相当の操作:

```powershell
# ワークスペース外のパスへの Remove-Item / del はすべて禁止
```

### Codespace インフラ系

```
gh codespace rebuild     # 環境再構築（devcontainerが変わりデータ消失の可能性）
                         # ※ユーザーが明示的に指示した場合のみ実行可
```

### その他高リスク操作

```
git commit --amend --no-edit  # プッシュ済みコミットのamendは --force と組み合わせ必須になるため禁止
gh api -X DELETE              # REST API経由の削除も禁止
gh api --method DELETE        # 同上
curl -X DELETE https://api.github.com/...  # curlによるGitHub API DELETE禁止
```

---

## デバッグ方針（HTML / JS / WebAssembly）

### 方針A: ローカルファイルを直接 Chrome DevTools MCP で開く

ビルド成果物がローカルに存在する場合はこちらを優先。

```bash
# ビルドのみCodespaceで実行し、成果物をローカルに同期
gh codespace ssh -c <name> "cd /workspaces/repo && npm run build"
gh codespace cp -r remote:/workspaces/repo/dist/ ./dist/ -c <name>

# → Chrome DevTools MCP でローカルの dist/index.html を直接開く
```

### 方針B: Codespaceでサーバーを立てて Chrome DevTools MCP 経由でプレビュー

DockerやDevcontainer上のサーバーに接続する場合。

```bash
# Codespace上でサーバー起動（バックグラウンド）
gh codespace ssh -c <name> "cd /workspaces/repo && npm run dev &"

# ポートをローカルにフォワード
gh codespace ports forward 3000:3000 -c <name>

# → Chrome DevTools MCP で http://localhost:3000 を開く
```

### ファイル同期の原則

- **ファイルの中身を応答に復唱しない**
- ビルドのみの場合: 成果物（`dist/`、`build/`、`.wasm` 等）をローカルに同期すること
- **ソースを修正した場合: ローカルで `apply_patch` を適用してから `gh codespace cp` でCodespaceへ転送して確実に上書きする**
  ```bash
  # 正しい手順
  # 1. ローカルで apply_patch を使いファイルを編集
  # 2. Codespace へ cp で上書き転送（-c オプションで Codespace 名を指定）
  gh codespace cp ./src/foo.ts remote:/workspaces/repo/src/foo.ts -c <name>
  # 3. Codespace 上でビルド
  gh codespace ssh -c <name> "cd /workspaces/repo && npm run build"
  ```
- 双方向の大量ファイル同期が必要なら `gh codespace ssh` + `rsync` を検討する

```bash
# rsync 経由での同期（sshconfig を使う場合）
gh codespace ssh --config -c <name> >> ~/.ssh/config
rsync -avz --exclude node_modules ./src/ <codespace-host>:/workspaces/repo/src/
```

---

## 許可コマンド一覧（settings.json の allow より）

### 読み取り・確認系（副作用なし）

```bash
gh * browse      # ブラウザで開く
gh * checks      # CI/CDチェック確認
gh * diff        # 差分確認
gh * list        # 一覧取得
gh * logs        # ログ確認
gh * search      # 検索
gh * status      # 状態確認
gh * verify      # 検証
gh * view        # 詳細表示
gh * watch       # 監視
gh browse
gh search
gh status
```

### ダウンロード・クローン（ローカルへの取得）

```bash
gh * clone       # リポジトリクローン
gh * download    # アセット等のダウンロード
```

### GitHub API（読み取り・コメント系のみ）

```bash
gh api *issues/*/comments*   # Issueコメント
gh api *pulls/*/comments*    # PRコメント
gh api *pulls/*/reviews*     # PRレビュー
```

### git 操作（許可されているもの）

```bash
git add          # ステージング
git blame        # 行履歴確認
git branch       # ブランチ一覧・作成（削除は -D 禁止、-d はマージ済みのみ）
git checkout     # ブランチ切り替え・ファイル復元
git diff         # 差分確認
git fetch        # リモート情報取得（マージしない）
git log          # ログ確認
git ls-files     # 追跡ファイル一覧
git rev-parse    # リビジョン解析
git show         # コミット・オブジェクト表示
git stash list   # スタッシュ一覧（dropやclearは禁止）
git status       # 状態確認
git tag          # タグ一覧・作成
```

### Nix 系（ビルド・評価・フォーマット）

```bash
nix build
nix develop
nix eval
nix flake
nix fmt
nix search
nix-fast-build
nixfmt
```

### Lint / Format 系

```bash
actionlint       # GitHub Actions ワークフロー lint
deadnix          # Nix 未使用コード検出
editorconfig-checker
prettier
shellcheck
shfmt
statix           # Nix static analysis
typos            # スペルチェック
zizmor           # GitHub Actions セキュリティ lint
```

---

## Codespace 操作（安全な操作のみ）

```bash
# 一覧・確認
gh codespace list
gh codespace list --repo owner/repo
gh codespace view -c <name>
gh codespace logs -c <name> --tail 100
gh codespace ports -c <name>

# 非対話型コマンド実行
gh codespace ssh -c <name> "<command>"
gh codespace ssh -c <name> "cd /workspaces/repo && make build"

# ファイル転送
gh codespace cp local-file.txt remote:~/path/ -c <name>
gh codespace cp -r remote:/workspaces/repo/dist/ ./dist/ -c <name>

# ポートフォワード
gh codespace ports forward 8080:8080 -c <name>
gh codespace ports visibility 8080:org -c <name>

# セッション開始（停止中でも ssh で自動起動される）
gh codespace ssh -c <name> "echo hi"

# 停止（タスク完了後は必ず実行 — 無料枠消費を防ぐ）
gh codespace stop -c <name>
```

---

## クリーンアップ（タスク完了後・提出前）

### ポートフォワーディングの停止（必須）

ポートフォワーディングは**提出前に必ず停止**すること。
フォワードプロセスはターミナルのフォアグラウンドで動作するため、`Ctrl+C` で停止する。

```bash
# フォワード状態を確認
gh codespace ports -c <name>

# フォワードしているプロセスのPIDを確認してkill
lsof -i :8080
kill <PID>
```

停止できない・忘れた場合はチャットで以下を**必ず**明記してユーザーに伝えること:

> **⚠️ ポートフォワーディングが残っています。以下のコマンドで手動停止してください:**
> ```bash
> gh codespace ports -c <codespace-name>   # フォワード中のポートを確認
> # フォワードしているターミナルで Ctrl+C、またはプロセスを kill してください
> lsof -i :<port>
> kill <PID>
> ```

### 一時ファイルの扱い

**Codespace内**はサンドボックスのため、`rm` で自由にクリーンアップして構わない:

```bash
# Codespace内での削除は ssh 経由で直接 rm を使える
gh codespace ssh -c <name> "rm /tmp/work.log"
gh codespace ssh -c <name> "rm -rf /tmp/workdir/"
```

**ローカル実機**では `rm` が禁止のため、一時ファイルを削除できない。
ただし、ワークスペース内の一時ファイルであれば削除してよいが、コマンドをミスらないように細心の注意を払う。

```bash
> C:\Users\<user>\AppData\Local\Temp\work.log
```

- ファイルの転送はcsp使うな。gh codespace cp使え。cpが失敗する場合おそらくサーバーが落ちてる。編集だけしてあとはすぐに私に助けを求めろ。
- もし助けを求めるのが癪なら、codespace消していいので、再作成すること。おかしいと思ったらすぐに再作成すること。
```
gh codespace list
gh codespace stop -c <name>
gh codespace delete -c <name>
gh codespace create --idle-timeout "15m" -r DaisukeDaisuke/desmume_webassembly -b main --machine basicLinux32gb 
```


# important

To avoid the gh codespace cp bug, be sure to use the -e flag.
```
gh codespace cp ./webassembly/wasm-port.cpp remote:/workspaces/desmume_webassembly/webassembly/wasm-port.cpp -c curly-parakeet-v6797wvg9vw2wvr9 -e
```

---

## チェックリスト（タスク実行前）

- [ ] コマンドに `delete` が含まれていないか
- [ ] `rm` が含まれていないか（引数問わず禁止）
- [ ] `git push` に `--force` / `-f` が付いていないか
- [ ] `git reset --hard` が含まれていないか
- [ ] `git clean` が含まれていないか
- [ ] `gh repo archive` / `rename` / `transfer` が含まれていないか
- [ ] `gh api` で `-X DELETE` または `--method DELETE` を使っていないか
- [ ] `-e` フラグをユーザー入力と組み合わせていないか（シェルインジェクション）
- [ ] デバッグ時にファイル内容を応答に復唱していないか
- [ ] ポートフォワーディングを提出前に停止したか（または停止方法をチャットで明記したか）
- [ ] Codespaceに転送したファイルは `apply_patch` → `cp` の手順を踏んだか
- [ ] ホスト環境にソフトウェアを追加インストールしていないか
- [ ] `sudo apt install` に `-y` を付けてログを `> /dev/null 2>&1` で捨てているか
- [ ] タスク完了後に `gh codespace stop -c <name>` で停止したか

---

---

## 参照

- [GitHub CLI Codespace Manual](https://cli.github.com/manual/gh_codespace)
- [GitHub Docs: Using Codespaces with GitHub CLI](https://docs.github.com/en/codespaces/developing-in-a-codespace/using-github-codespaces-with-github-cli)
- [AGENTS.md Open Standard](https://agents.md/)

---

# agents.md End
If the context has been injected up to this point, do not reread AGENTS.md file

# UIルール

`old/interface-design/.claude/skills/interface-design/SKILL.md`を読むこと

# coi-serviceworker
coi-serviceworkerは、github pageで真のマルチスレッドを使用するためのハック(模擬ワーカーハックではなく)
coi-serviceworker/coi-serviceworker.js


## 参照

- [GitHub CLI Codespace Manual](https://cli.github.com/manual/gh_codespace)
- [GitHub Docs: Using Codespaces with GitHub CLI](https://docs.github.com/en/codespaces/developing-in-a-codespace/using-github-codespaces-with-github-cli)
- [AGENTS.md Open Standard](https://agents.md/)

---

# project rule
The GitHub codespace allows you to execute the emcc command and build projects
It also allows you to set up a server and debug it using Chrome
emcc provides build scripts and also supports building with githubactions.
You are allowed to create commits, push (except with -f), and add submodules.
You can submodule the old code for deployment
Regarding `old\desmume`, commits are permitted on the `webassembly` branch. Also, you will be updating the submodules.
You need to keep detailed records of the deployment using GitHub Actions and future AI-related notes.
system.md is always created
GitHub Codespace is the ultimate sandbox for you, provided you don't make any quotation mistakes.
The ROM for DQ9 is located at "D:\software\desmume-win-x64_2025_8_11\nds\dq9_new2.nds". Use this to debug. Do not dump this into context.
The save data for DQ9 is located at "D:\software\desmume-win-x64_2025_8_11\dq9_save-main\dq9_save\re一人旅_v2\28_ends.sav".
The save state is located at "D:\software\state.dst".
You are not an AI designed for gaming, so you will only be testing button functionality. Please do not try to enjoy the game.
The important Lua code is as follows (this will run on the web emulator with features like JS eval and slot upload functionality):
- "D:\lua_new\lua\Ctable_jp.lua": This completely dumps the battle random numbers in the C table.
- "D:\lua_new\lua\AChange.lua": Spam changes to A Table
- "D:\lua_new\lua\callstack_test.lua": This is a fully functional stack trace damper, and I would like to incorporate this as a mode, but it comes at a significant performance cost.
- nigeru.lua: Guaranteed battle escape cheat
- "D:\lua_new\lua\setCTable_jp.lua": Sets a random number for the ctable.
- "D:\lua_new\lua\enc_jp.lua": (Optional) fully functional pre-encounter emulator
You need to write a description for every API.
You can evaluate any JavaScript code and test it with the emulator.
- Use chrome-devtools-mcp for debugging.
- It is also allowed to do git commit, git pull in codespace, and synchronize the repository (but do not upload old, make it a submodule)
- vs22, vs26, vs26 build tools are installed.
- cmake ninja gcc installed
- php 8.4 installed
- nodejs installed
- git@github.com:DaisukeDaisuke/desmume_webassembly.git
- 公開repositoryなので、機密情報アップロード不可。
- 細かくコミット、push、して、codespace git pullで同期することを許可
- コミットはcodespace側ですること。転送したい場合はローカルでしてもいいが、AI経由だとなぜかうまくいかない
- /home/codespace

- The pioneering implementation can be found at old/desmume-wasm/desmume/wasm-port/main.cpp

# deployment
remote url: https://daisukedaisuke.github.io/desmume_webassembly/


# Project Overview
old/desmumeについて、このフォークをサブモジュール化してから、desmumeウェブ版を実装してほしい。本家同様フルデバック対応、webmcpによるAIデバック対応。
シングルファイルで。メモリ制限2GB?
github actionsによるデプロイはC:\Users\owner\Documents\BattleEmulator\.github\workflows\webassembly.ymlを参考
必要な機能
AIによるありとあらゆる操作の実現
- ステートのインポート、ローカルストレージへのステート保存?(ただし256mb)、ステートエクスポート。
- 0.25倍速~4倍速までの倍速機能(mcpあり)
- 状態取得mcp
- Nフレーム進めるmcp
- 画面の描写をoffにできる
- 音量をさげることができる。無効化可能
- js evalまたは、wab mcp経由で様々な機能の実現。
- 内臓ディスアセンブラによるネアーpcダンプ、キー入力(ボタン or 任意キー(人間用))
- セーブデータのインポート、エクスポート
- AIが操作できる、デバッカー、レジスタの取得、pc付近の取得、指定メモリのディスアセンブル、指定レジスタの変更、ステップ、ステップオーバー、メモリブレイクポイント、メモリ書き込みブレイクポイント、メモリ読み取りブレイクポイント、メモリのダンプ、アセンブリの取得(アドレスあり、正規表現あり)、ステートの読み込み、ステートの保存、外部ステートの読み込み、jsコードインジェクションによるlua相当の機能の提供によるこれらの達成、web mcpによる達成、コード解析自体はghidra mcpでするので、ある程度のダンプがあればok、実行ブレイクポイントの作成、削除、人間が操作できるデバッカー。N回ステップする、contする、ramの範囲ダンプ、メモリ全ダンプ？メモリとディスアセンブラのautoアップデート機能、画面の回転、ロムのアップロード(ただしローカルで処理)、mcpによるスクリプト注入(ただし安全な隔離で)、thumb、auto、armの自動判別(ディスアセンブラ)、arm7ディスアセンブラ、arm9ディスアセンブラ、指定レジスタの取得、ブレイクポイント位置に赤の目印をリアルタイムで。メモリブレイクポイントとメモリビュワーによる読み込みは競合するので注意する。ブレイクポイント一覧、スタックトレースモードon/off、スタックトレースダンプ、
- エミュレーターの停止、再開(停止中にロードステートした場合は停止したままロードする)
- ホットキー設定
- bois、ファームウェアアップロード？(基本的にフリーbios使いたい。どっかに含まれてるはず)
- メモリビュワー、スタックトレースは重いのでon offできるようにする。
  本番はgithub actionsでビルドする
- テストはcodespaceでする。git pull+コミット術を使ってファイルを同期するか、ghでコピーする。
  agents.mdにいろいろ書いてるのでそれに従う。
  nextcall: "D:\lua_new\lua\callstack_test.lua"で使われてる仕組みで実現可能
  info registers cpsr
  continue: 再開
- エミュレーターサイズの指定(1x 1.5x 2x 2.5x 3.0x 3.5x 4.0x)
- 実行速度の指定
- ありとあらゆるmcp(安全なコードインジェクションを含む、ただし隔離環境ネットワーク無効が望ましい)
- ミラーメモリに対するデバック。メモリブレイクポイント(本家は非対応)
- 機能セットを丸ごとオフにできるmcp、ボタンで高速動作。ただ遊びたい場合のみにも対応する。
- ソースコードはサブモジュールを使う。old\desmumeはスタックトレース改造版である。
- 音量の設定(デフォルトで爆音であるため)
- 実装はまとめてせず、試しながら実装する。ただしchrome mcpはめちゃくちゃトークン食うので注意すること。
- webassembly jsはシングルファイルにすること。ファイル分けすること。
- main.cppは関係ない。
- read handoff.md and Addend to the handoff.md
- gh run list --repo DaisukeDaisuke/desmume_webassembly --branch main --limit 3　gh run watch ???? --repo DaisukeDaisuke/desmume_webassembly --exit-statusで、actionsが終わるまで待機すること。codespaceでのbuildと構文チェックはそこまで重要ではない。軽い変更ならテストも本番環境でやればいい。ただしビルドはリアルタイムで5分かかるので、できれば複数の問題をまとめてすること。
- ローカルは、ssh認証済み(リポジトリはsshモード)、https未認証、gpg設定済み。gh一部権限使用可能(リポジトリ削除などははく奪済み)。ローカルなので認証情報を変えるな、ghのトークンダンプするな。sshフォルダはワークスペース外なのでいじるな。鍵をコンテキストにダンプするな。
- (ローカルコミットで、gpgがコミットで落ちた場合は、"C:\Program Files\GnuPG\bin\gpg-connect-agent.exe"を常駐無し引数で1回起動し、"C:\Program Files\GnuPG\bin\gpg-agent.exe"を5回同時起動(自動終了、エラー吐くが無視すればいい)すれば　その後20秒待機すればたいていの場合うまくいく。勝手にgpg再構成するな。)
- github actionsのデプロイは毎回してると遅いので、可能であれば最終提出ですること、cp転送後、npxなどなどdockerなどなどのキャッシュ無し即時リロードができる、サーバーをローカルかプレビューページにポートフォワーディングして、ローカルでアクセスしたほうがキャッシュもあいまって2倍ほど速い。github 本番デプロイで前回1時間以上作業してたので、これが速くなると嬉しい。
- もしくはnodejs(Windows ディフェンダー未許可)に配信をやらせればいい。
- また、codespaceはランダムに電源が落ちるのでそういうものだと思って再起動する。ぶっ壊れた場合は応答しなくなるので再作成する。gh codespace cp失敗はただ電源が落ちてるだけ。
- ローカル、codespaceデバックの場合でもコミットは毎回すること。push+待機は最終提出まで保留すること
- 絶対に検証ごとに毎回デプロイしないこと。ただし軽い変更はこの通りではない。前回のように120分も待ってられないので、codespaceホストか、ローカルホストで高速サイクルを回すこと。
- pushに失敗するときはhttp pushと、ssh push両方試すこと。基本的にcodespaceでhttps pushすれば、ホストの影響を受けず、いろんな意味で安全。
- デプロイは毎回cache-bustすること。
- 時間かかるので絶対に毎回github pageにデプロイせず、ローカルサーバーで確認すること。html変更の場合即座に、cpp変更は2分なので段違いに速い。
- 積極的にwebassembly/build_safe_heap.sh、webassembly/build_sanitize.shを活用すること。というより開発はこっちですること。
- テストサーバーはphpでたてろ。
```
(Start-Process -FilePath "D:\software\php-8.5.7-nts-Win32-vs17-x64\php.exe" -ArgumentList "-S localhost:8766" -WorkingDirectory "C:\Users\owner\CLionProjects\deweb\public" -PassThru).Id    
```

```
http://localhost:8766/
```


# agents.md End
If the context has been injected up to this point, do not reread AGENTS.md file