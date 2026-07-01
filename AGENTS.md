# GitHub Codespace Agent Guide

## 最優先ルール

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
- 文字化けを理由にすべてを英語化しない。`apply_patch` を使う限り文字化けは起きない。
- 循環参照はできる限り避ける。
- 編集した行番号を最終提出時に報告しなくてよい。Gitがあればファイル名だけで十分。
- `rg` コマンドが使用可能。
- 編集時の差分を最小化する。難しければ小さな単位に分割する。
- 可能な限りファイル1件ずつ差分を提出する。
- `git diff` で全差分を確認して行番号を報告するのはトークンの無駄。行わない。
- **許可なしに追加ソフトウェアをインストールしない。**
  許可とはメッセージ表示だけでなく、処理を中断してユーザーにインストール許可を求め、確認を得てからタスクを完了することを意味する。
- `public/branches`、`public/emulators.json`、`public/desmume.js` を読まない・検索対象に入れない（自動生成/ビルド成果物）。
- `AGENTS.md`、`handoff.md`、`system.md` は作業前後の重要情報源として扱う。エミュレーター実装・デバッグ作業では `handoff.md` も読むこと。

## ユーザー変更の扱い

- PLEASE DO NOT RESTORE the differences that I deleted for my own convenience.
  - These deletions were intentional. Do not attempt to restore them, assuming that "THE CHAT HISTORY IS CORRECT BUT WAS DELETED!!!!!"
  - Restoring this would be a waste of time for both parties.
- ユーザー由来の未追跡ファイルや削除を勝手に戻さない。

## PowerShellでUTF-8を読む

```powershell
[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Content -Encoding UTF8 file.txt
[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $i=1; Get-Content -Encoding UTF8 file.txt | % { "$i: $_"; $i++ }
```

## UIルール

- UIを実装する際は `old/interface-design/.claude/skills/interface-design/SKILL.md` を読むこと。
- CLS防止のため、JavaScriptで起動時に要素を挿入しない。すべての要素はHTMLに実装し、オプション要素はデフォルトで非表示（ただし幅は確保）にする。
  - テンプレートを使った動的追加は許可。
  - 動的要素を起動時に初期化してはいけない、という意味ではない。
  - 動的エレメントは、テンプレートエレメントを使用するべきである。
- UI description is not a specification report. When adding a description, write what the user should expect, what happens as a result, and what the user needs to do.

## 環境の区別

| 環境 | OS | 説明 | ソフトウェア追加 | ファイル操作 |
|---|---|---|---|---|
| **Codespace** | Linux | GitHubが管理する安全な環境 | `sudo apt` で自由に導入可 | **ファイルのクリーンアップ含め何でも可** |
| **ホスト（Codex実行環境）** | **Windows 11** | あなた自身がホストされている実機 | **追加インストール禁止** | ワークスペース外のC/Dドライブ編集禁止 |

- Codespace は `gh codespace ssh -c <name> "<command>"` 経由で使う。停止中でも ssh で自動起動される。
- タスク完了後、Codespaceを起動した場合は **必ず `gh codespace stop -c <name>` で停止**する。
- Codespace名は実行前に `gh codespace list` で確認する。
- `gh codespace cp` は必ず `-e` を付ける。例: `gh codespace cp ./webassembly/wasm-port.cpp remote:/workspaces/desmume_webassembly/webassembly/wasm-port.cpp -c <name> -e`
- gh cpは4セッション以上同時に使わない。
- ホストではソフトウェア追加禁止。C/Dドライブのワークスペース外ファイルを編集・削除しない。
- 外部にアップロードされず完全にローカル処理されることが明確な場合のみ、ユーザー指定の外部ファイルをChrome DevTools MCPで参照してよい。
- ROM/セーブ/ステートなどの実データ本文をチャットへ出さない。公開リポジトリに機密情報をアップロードしない。
- ローカルはssh認証済み、https未認証、gpg設定済み。認証情報を変えない。`~/.ssh` やGPG設定を勝手に触らない。ghトークンや秘密鍵を表示・ダンプしない。

## `sudo apt` 使用ルール

- 必ず `-y` を付けて非対話的に実行すること。
- ログは全部 `> /dev/null 2>&1` で捨てること。

```bash
gh codespace ssh -c <name> "sudo apt update && sudo apt-get install -y emscripten > /dev/null 2>&1"
```

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

## 許可される代表コマンド

```bash
# gh 読み取り・確認
gh * browse
gh * checks
gh * diff
gh * list
gh * logs
gh * search
gh * status
gh * verify
gh * view
gh * watch
gh * clone
gh * download
gh api *issues/*/comments*
gh api *pulls/*/comments*
gh api *pulls/*/reviews*

# git
git add
git blame
git branch
git checkout
git diff
git fetch
git log
git ls-files
git rev-parse
git show
git stash list
git status
git tag

# Nix / lint / format
nix build
nix develop
nix eval
nix flake
nix fmt
nix search
nix-fast-build
nixfmt
actionlint
deadnix
editorconfig-checker
prettier
shellcheck
shfmt
statix
typos
zizmor
```

## Codespace操作

```bash
gh codespace list
gh codespace list --repo owner/repo
gh codespace view -c <name>
gh codespace logs -c <name> --tail 100
gh codespace ports -c <name>
gh codespace ssh -c <name> "<command>"
gh codespace cp local-file.txt remote:~/path/ -c <name> -e
gh codespace cp -r remote:/workspaces/repo/dist/ ./dist/ -c <name> -e
gh codespace ports forward 8080:8080 -c <name>
gh codespace ports visibility 8080:org -c <name>
gh codespace stop -c <name>
```

- `gh codespace cp` が失敗する場合は、Codespaceが停止している可能性が高い。`gh codespace ssh -c <name> "echo started"` で起動を試す。
- 壊れていると思った場合でも、禁止コマンドに該当する操作（例: `gh codespace delete`）は実行しない。ユーザーに相談する。

## デバッグ・ビルド方針

- Chrome MCPでテストする場合は、Codespaceでビルドして `public/desmume.js` をローカルへ転送してからテストする。
- ソースを修正した場合は、ローカルで `apply_patch` を適用してから `gh codespace cp -e` でCodespaceへ転送し、Codespace上でビルドする。
- ファイルの中身を応答に復唱しない。
- スクリーンショットはcanvasだけで取る。canvasサイズはトークン消費を抑えるため1倍にする。ユーザーが詳細にバグを指定した場合は、ピクセル検査スクリプトを使う。
- GitHub Pagesへ毎回デプロイしない。HTML変更や軽い確認はローカル/プレビューサーバーで高速に回す。
- C++/WASM変更の開発では `webassembly/build_safe_heap.sh` (クラッシュ時、cpp側スタックトレースありモード) と `webassembly/build_sanitize.sh` を積極的に使う。
- GitHub Actionsでデプロイする場合は、最終段階でまとめて行い、cache-bustする。
- Actions完了待ちは実デプロイを見たいなら、次のコマンドで待つ: `gh run list --repo DaisukeDaisuke/desmume_webassembly --branch main --limit 3` で対象runを確認し、`gh run watch <run-id> --repo DaisukeDaisuke/desmume_webassembly --exit-status` で終了まで待つ。
- Codespaceでのbuildと構文チェックは本番Actionsほど重要ではない。軽い変更は本番環境で確認してよい。ただしビルドはリアルタイムで約5分かかるため、複数の問題をまとめて確認する。

### Chrome MCPでのファイルアップロード

- AI側からのROM/Save/State読み込みは、Chrome MCPのアップロード対象要素IDとアップロードツールを組み合わせる。
- file inputのIDは毎回変わる可能性がある。固定IDを仮定しない。
- アップロード用ツールはデフォルトで見えていないことがある。必要なら `tool_search` で `take_snapshot` と `upload_file` を探して使う。
- 手順:
  1. Chrome MCPで対象ページ（例: `https://daisukedaisuke.github.io/desmume_webassembly/` または `http://localhost:8766/`）を開く。
  2. `take_snapshot` でDOM/アクセシビリティツリーを取り、ROM/Save/Stateの file input またはアップロードボタンの現在IDを確認する。
  3. `upload_file` で、そのIDへユーザー指定ローカルファイルを渡す。
  4. ROM/Save/State本文はチャットに出さず、ブラウザへローカルアップロードするだけにする。
- DQ9のROM/Save/Stateはユーザー指定パスを使う。内容をコンテキストへ貼らない。

## コミットと同期

- ローカルでのコミットは許可されている。この環境は、gpgによる自動署名が構成されており、AIが署名コミットを行うことは許可されてる(なりすまし対策であるため)
- pushはAIが行うと失敗することがあるため、基本は人間が行う。pushが必要な場合は事前に確認する。強制pushは禁止。
- `old/desmume` に変更がある場合は、先に `old/desmume` 内でコミットし、プロジェクトルートに戻って `git add ./old/desmume` でサブモジュール参照を更新してから親リポジトリをコミットする。
- ローカルコミットでGPGが落ちた場合のみ、GPG設定を変更せずに次の回避を試してよい:
  1. `"C:\Program Files\GnuPG\bin\gpg-connect-agent.exe" /bye` で先に1回起動する(20秒間程度かかるので、完了待ちしない)
  2. `"C:\Program Files\GnuPG\bin\gpg-agent.exe"` を200msづつ、遅延を入れながら5回同時起動する。自動終了やエラーは無視してよい。このとき標準出力は捨てる。
  3. 20秒待ってからコミットを再試行する。
  4. これでもコミットに失敗した場合は、ファイル変更だけで助けを求める。
- GPG/SSHの再構成、鍵ファイル操作、認証情報の変更は禁止。

### ローカルPHPテストサーバー

```powershell
(Start-Process -FilePath "D:\software\php-8.5.7-nts-Win32-vs17-x64\php.exe" -ArgumentList "-S localhost:8766" -WindowStyle Hidden -WorkingDirectory "C:\Users\owner\CLionProjects\deweb\public" -PassThru).Id
```

URL:

```text
http://localhost:8766/
```

## クリーンアップ

- ポートフォワーディングは提出前に必ず停止する。
- 停止できない・忘れた場合は、次をチャットで必ず明記してユーザーに伝えること。

```bash
gh codespace ports -c <codespace-name>
# フォワードしているターミナルで Ctrl+C、またはプロセスを kill してください
lsof -i :<port>
kill <PID>
```

- Codespaceを起動した場合、タスク完了後に `gh codespace stop -c <name>` を実行する。

## 作業前チェックリスト

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
- [ ] Codespaceに転送したファイルは `apply_patch` → `cp -e` の手順を踏んだか
- [ ] ホスト環境にソフトウェアを追加インストールしていないか
- [ ] `sudo apt install` に `-y` を付けてログを `> /dev/null 2>&1` で捨てているか
- [ ] タスク完了後に `gh codespace stop -c <name>` で停止したか

## プロジェクト概要

- 目的: `old/desmume` をサブモジュールとして使い、DeSmuMEのWebAssembly版をフルデバッグ対応・WebMCP対応で実装する。
- 公開先: `https://daisukedaisuke.github.io/desmume_webassembly/`
- リポジトリ: `git@github.com:DaisukeDaisuke/desmume_webassembly.git`
- `old/desmume` はスタックトレース改造版で、`webassembly` ブランチでのコミットが許可されている。変更した場合は先にサブモジュール側をコミットし、親リポジトリでサブモジュール参照を更新する。
- `public/index.html` がUI。`public/desmume.js` はEmscriptenの `-sSINGLE_FILE=1` 生成物。
- `webassembly/wasm-port.cpp` が主なWASMポート実装。
- ルートの `main.cpp` と `CMakeLists.txt` はこのWeb実装には関係ない。
- `coi-serviceworker/coi-serviceworker.js` はGitHub Pagesで真のマルチスレッドを使うためのCOOP/COEP用ハック。
- すべてのAPIには説明を書く。
- 実装詳細・最近の注意点は `handoff.md` に残す。作業で得た重要な知見は Addendum として追記する。

## 実装要件の要約

- ROM、セーブ、ステートのインポート/エクスポート。ROM等はローカル処理のみ。
- ステートはローカル保存に対応する。
- 停止/再開、Nフレーム進行、0.25x〜4x速度変更、画面描画off、音量設定/無効化、画面回転、表示倍率1x〜4x。
- 人間用UIとAI用MCPの両方で、キー入力・任意キー・ホットキー設定を扱う。
- デバッガー: レジスタ取得/変更、PC付近、メモリダンプ/書き込み、ARM7/ARM9 disassemble、thumb/arm/auto、step/step over/continue、exec/read/write breakpoint、breakpoint一覧、ブレーク位置表示。
- メモリビュワー・スタックトレースなど重い機能はon/off可能にする。メモリビュワーの読み込みでread breakpointを誤発火させない。
- MCPでは状態取得、Nフレーム進行、スクリプト注入、JS eval相当、機能セットのon/offを提供する。安全な隔離を優先し、ネットワーク無効が望ましい。
- 停止中にロードステートした場合は停止状態を維持する。
- DQ9のROM/セーブ/ステートはユーザー指定のローカルパスにある。本文をコンテキストやリポジトリへ出さない。
- AIはゲームプレイを目的にせず、ボタン機能などの動作確認だけを行う。バグの再現手順など、指定があればその通りにする。

## DQ9検証用ローカルパス

- ROM: `D:\software\desmume-win-x64_2025_8_11\nds\dq9_new2.nds`
- Save: `D:\software\desmume-win-x64_2025_8_11\dq9_save-main\dq9_save\re一人旅_v2\28_ends.sav`
- State: `D:\software\state.dst`
- 重要Lua:
  - `D:\lua_new\lua\Ctable_jp.lua`
  - `D:\lua_new\lua\AChange.lua`
  - `D:\lua_new\lua\callstack_test.lua`
  - `D:\lua_new\lua\nigeru.lua`
  - `D:\lua_new\lua\setCTable_jp.lua`
  - `D:\lua_new\lua\enc_jp.lua`

## 参照

- [GitHub CLI Codespace Manual](https://cli.github.com/manual/gh_codespace)
- [GitHub Docs: Using Codespaces with GitHub CLI](https://docs.github.com/en/codespaces/developing-in-a-codespace/using-github-codespaces-with-github-cli)
- [AGENTS.md Open Standard](https://agents.md/)

# codespace

`gh codespace list`でずっとShuttingDownになっていても、おそらくghコマンドのバグなので、無視し、提出していい(停止には1分ぐらいかかる)。止まってなかったら人間があとで止めればいいため。

# 動作確認
- あなたは、chrome mcpで動作確認をするべきです。この場合ユーザーが再現方法を述べているため、これを使用し、コードが期待通りに修正されているか確かめる必要があります。
- ユーザーに丸なげする場合でも、提出前にpublic/desmume.jsをローカルにコピーするべきです。

# agents.md End

If the context has been injected up to this point, do not reread AGENTS.md file.
