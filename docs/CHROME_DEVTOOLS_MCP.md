# 専用Chromeでの開発・検証

現在の接続先は9223。このプロジェクト用MCPからの拡張導入・再読み込みに成功している。下記の初回確認記録にある接続失敗は解消済み。最新の検証範囲は「9223への実接続と拡張導入」を参照する。

## 対象と前提条件

- Windows、PowerShell、Codex、Google Chrome、Node.js / npm（`node`・`npx`がPATHにあること）。MCPのNode要件は使用版の公式READMEで確認する。
- Gitルート・展開済み拡張の読み込み元は `middleclick-extension` フォルダー。以下では、その環境で取得した絶対パスを `$repoRoot` と表記する。
- `manifest.json` はManifest V3 / MiddleClick+ 1.2.3。`background.js`、`navigation-learning.js`、`content.js`、`icons/logo.png` が直接参照される。package.jsonとビルド設定はない。ビルド不要で、出力先も別にない。回帰テストは `tests/*.test.cjs` にある。`storage` と `webNavigation` が必要。
- 親の `MiddleClick+_enhanced` はGitルートではない。隣の `MiddleClick+_enhanced_1.2.1` と `releases` は読み込み元にしない。
- READMEは英語の1ファイルだけ。旧版フォルダーのREADMEは別版の資料であり同期対象ではない。
- この拡張にポップアップやオプション画面はない。対象ページでの中クリック動作が実画面検証の中心になる。

## 専用Chromeの起動・再利用

このプロジェクト専用のプロファイルと9223を使う。他プロジェクトが検証中の共有Chrome（9222）には接続しない。このプロジェクト内でも複数のチャット・担当者による同時操作はしない。

```powershell
# 標準の配置例。別の場所にcloneした場合は、そのGitルートへ移動する。
Set-Location (Join-Path $env:USERPROFILE 'git\MiddleClick+_enhanced\middleclick-extension')
$repoRoot = (Get-Item -LiteralPath '.').FullName
.\scripts\start-dev-chrome.ps1
```

既定値:

| 項目 | 値 |
| --- | --- |
| 実行ファイル | `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| 専用プロファイル | `%LOCALAPPDATA%\Chrome-MCP-MiddleClick-enhanced`（実行時に絶対パスへ展開） |
| デバッグ接続先 | `http://127.0.0.1:9223` |

必要なら `-ChromePath '絶対パス' -ProfilePath '絶対パス' -Port 9223 -TimeoutSeconds 20` を指定する。ポートを変更する場合はMCPのbrowser-urlも一致させる。

スクリプトはCIMのChrome情報と待受ポートを取得し、既存の専用Chromeを再利用する。未起動かつポートが空いている場合だけ、`--remote-debugging-port=9223` と `--user-data-dir=<展開済み絶対パス>` を付け、`Start-Process -WindowStyle Hidden` で起動する。プロファイルはこのプロジェクトだけで再利用し、共有プロファイルや通常のChrome／Braveからコピーしない。

起動・再利用後はポート所有PIDの実行ファイル、両引数、`/json/version` のBrowser・WebSocket情報を照合する。HTTP応答だけでは成功としない。競合、プロセス情報の取得不能、専用プロファイルだけ起動済みでポートがない場合は理由を表示して終了コード1で停止する。別プロセスの終了、ロック削除、自動再起動はしない。実行権限の問題は利用環境の方針に従って解消し、情報取得を省略しない。

## CodexのMCP設定と反映

このチャットの作業フォルダー（Gitルートの親）の `.codex/config.toml` と、Gitルートの `.codex/config.toml` に設定を置く。親側のworkspaceはチャット作業フォルダー、子側はGitルートの絶対パスとし、どちらも拡張読み込み元を含む。接続先は両方とも9223。

Gitルート側の設定例:

移植用の `.codex/config.toml.example` を `.codex/config.toml` へコピーし、下記のプレースホルダーを実際の絶対パスに置き換える。実際のconfig.tomlは個人環境のパスを含むためGit対象外とする。親フォルダーでこのチャットを開く構成では、親側にも前述の設定が必要。

```toml
[mcp_servers.chrome-devtools]
enabled = true
command = "npx"
args = [
  "-y",
  "chrome-devtools-mcp@latest",
  "--categoryExtensions=true",
  '--workspace=<REPOSITORY_ABSOLUTE_PATH>',
  "--browser-url=http://127.0.0.1:9223"
]
```

これはSTDIOサーバーの起動設定。9223はChrome DevToolsの接続先であり、MCPのHTTP `url` にはしない。固定接続に `--autoConnect` を併用しない。

上記は説明用テンプレート。`<REPOSITORY_ABSOLUTE_PATH>` は、前節で取得した `$repoRoot` の値に置き換えて保存する。ドキュメントには個人ユーザー名を記載しない。実際のローカル設定には展開済み絶対パスが必要であり、TOMLのargsへ `$env:USERPROFILE` や `%USERPROFILE%` をそのまま書いても展開されるとは扱わない。

`--workspace` はMCPのファイルアクセス範囲、Chromeの `--user-data-dir` はプロファイル保存先。今回は読み込み元がGitルート内なのでworkspaceは1つだけでよい。外部出力先が必要になった場合だけ実際の出力先を追加する。プロファイルは追加しない。args内の環境変数展開を前提にしない。移動・別PCへの移植時はworkspaceの絶対パスを更新する。

Codexは信頼済みプロジェクトのローカル設定を読み込む（[公式Codex MCP資料](https://developers.openai.com/codex/mcp)）。ユーザー設定の同名テーブルをこのプロジェクト設定で上書きする。ユーザー全体の設定を変更しない。

1. このチャットの作業フォルダーを使う場合は親側の設定を使う。Gitルートで開く場合は子側の設定を使う。親で開いたチャットに子側だけの設定が反映されるとは仮定しない。
2. 環境の信頼設定を確認する。MCPの再接続機能が利用できれば接続を作り直す。再起動だけで設定反映が成功するとは扱わない。
3. 実際のツール定義を取得し直す。`list_pages` が応答することを確認する。
4. 下記の `install_extension` が正しいパスを受理したことも確認する。ファイル保存・CLIの設定表示・ツール一覧だけで稼働中のworkspaceが更新されたとは判断しない。

ユーザーはアプリのソースフォルダー追加時に「信頼する」にYESと回答済みだったが、デスクトップ実行ファイルによる診断では、親側の設定に `config/read` の `layers[].disabledReason`（プロジェクトの信頼登録が必要）が付いていた。その後、ユーザーの明示許可を得て、ユーザー設定ファイルへこのチャット作業フォルダーの信頼登録1件だけを追加した。現在は `codex mcp get chrome-devtools` で当プロジェクトのworkspaceと9223が表示される。ソースフォルダー追加時のYESだけで設定反映成功と扱わない。過去の一時的なtrust指定によるCLI確認は再現しておらず、解決手順とはしない。

MCP接続が9223とこのプロジェクトのworkspaceへ切り替わった証拠を得るまで、既存のChrome DevTools MCPツールをブラウザー操作に使わない。他プロジェクトの検証を妨げるため、9222に接続したままのツールでのページ列挙・拡張導入も行わない。ユーザー全体の設定は変更しない。

`@latest` は変化する。セッションごとに `npx.cmd -y chrome-devtools-mcp@latest --version` と `--help`、起動スクリプトのBrowser値を記録する。既に稼働中のMCPは別版の可能性があるため、必要ならそのプロセスのパッケージ版も照合する。再現性が必要なら合意してパッケージ版を固定する。公式の[設定資料](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md)と[ツール資料](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md)より、実際に公開された定義を優先する。

## 拡張の導入と更新

2026-10-18に公開されたツール定義では以下を確認した。ID・UIDは毎回応答から取得する。以下はツール呼び出しのJSON例でありPowerShellコマンドではない。

1. `list_pages {}` → 接続済みページを確認。専用Chromeのプロセス照合を先に済ませる。
2. `list_extensions {}` → 名前・ID・version・enabledを記録する。すべての拡張を網羅する保証や読み込み元の証拠とはしない。
3. 対象が未導入の場合だけ `install_extension {"path":"<REPOSITORY_ABSOLUTE_PATH>"}` のpathに `$repoRoot` の実際の値を渡し、導入結果のIDを記録する。プレースホルダーや環境変数名は渡さない。同名候補があれば推測で導入・再読み込みせず、専用Chromeの拡張詳細にある読み込み元と照合する。版数だけでは判断しない。
4. `new_page {"url":"<ユーザー指定URL>"}` で新しい検証タブを開く。既存タブを無断で転用しない。
5. 応答のpageIdで `take_snapshot {"pageId":...}`。最新snapshotのUIDから操作対象を選ぶ。必要なら `take_screenshot`、`evaluate_script` の読み取りでDOM・寸法を確認する。
6. コード変更・構文検査後、`reload_extension {"id":"<確認済みID>"}` → `navigate_page {"pageId":...,"type":"reload","ignoreCache":true}` の順に実行する。拡張だけの再読み込みでは既存ページのcontent scriptは更新されない。
7. 新しいsnapshot、同一条件の画面・DOM・寸法、操作結果、`list_console_messages {"pageId":...,"types":["error","warn"],"includeStackTraces":true}` を確認する。必要なら `get_console_message` で発生元を調べる。

ツール未提供ならcategoryExtensions、サーバー版、実ツール定義、Chrome側の対応を確認する。非対応の場合、ユーザーが専用Chrome内で `chrome://extensions/` → デベロッパーモード →「パッケージ化されていない拡張機能を読み込む」→ 上記Gitルートを選択する。更新は読み込み元とIDを確認した対象カードの再読み込み、その後に対象ページの再読み込み。ほかの拡張の無効化・削除はしない。workspace拒否ならまずCodex接続を作り直す。手動操作や別CDPクライアントでアクセス制限を迂回しない。

## 受入項目

対象URLはユーザーに確認する。ログインが必要ならユーザーが専用Chrome内で完了する。閲覧・スクロール・安全なリンク操作だけを行い、投稿・送信・既存データの編集／削除は別指示なしに行わない。

- 実画面の対象要素をsnapshotとスクリーンショットで確認。比較の前後でURL、画面状態、スクロール、viewport（例: `emulate` の `viewport: "1280x800x1"`）を揃える。変更がない場合も基準状態を記録する。
- 通常の左クリックが従来どおり動く。通常のリンクの中クリックで重複タブが作られない。
- 安全にURLを解決できる擬似リンクは、元タブの右隣のバックグラウンドタブに1つだけ開く。元タブの選択を保つ。
- URLを解決できないボタンは何もしない。短時間の連続中クリック、必要に応じてShadow DOMも確認する。
- ChatGPT専用の固定ルートは廃止済み。URLのないボタンは通常の左クリックで学習してから中クリックを検証する。あなたのdotの遷移先は `/dots/home`。再読み込みや拡張の再起動後にも再利用できること、学習前・重複・競合時は何も開かないことを確認する。Codexは学習不要で、新タブのURLが `/`、Codexボタンの `data-selected` と `history.state.usr.sidebarProductMode === 'codex'` を確認する。SVG素材のURLが開かないことも確認する。安全な閲覧リンクに限定し、対象UIが存在しない場合は未確認とする。
- ページと対象拡張service workerのConsoleを確認する。URL・stackの拡張IDでサイト／対象拡張／他拡張を区別する。発生元不明は「未特定」。

現行 `click` の引数には中ボタン指定がない。物理中クリックの受入はユーザーが専用Chromeで操作し、前後のsnapshot・タブ一覧・選択状態をMCPで観測する。DOM合成イベントやservice workerの直接呼び出しを物理中クリック成功の代わりにしない。タブの順序・active状態が一覧から不明なら、確認済み対象service workerの読み取りで `chrome.tabs.query` 等を使い、書き換えない。

Codexによる自動検証には汎用の `scripts/synthetic-middle-click.js` を使う。HTTP(S)ページの最新snapshotから安全な閲覧用リンク・ボタンのUIDを `evaluate_script` のargsへ渡し、sourcePathにこのファイルの絶対パス、formatに `function` を指定する。子SVG・画像があればイベント送信先にする。期待URLは実際の通常左クリック等から別途確認し、このスクリプトでサイト固有のルートを推測しない。フォームやアクションメニューは対象にしない。これは `isTrusted=false` の合成中ボタンイベントであり、学習の開始やOSの物理入力、ブラウザー標準の中クリック処理を検証するものではない。

汎用学習用のローカルページは `node tests/fixtures/server.cjs` で起動する。表示されたループバックURLを専用Chromeの新しいタブで開き、SPA destination／Document destinationをMCPの通常clickで左クリックして学習する。再読み込み・拡張の再起動後に合成中クリックし、保存結果の再利用を確認する。Unresolved buttonは学習前後とも無反応であることを確認する。検証後は作成したタブを閉じ、サーバーをCtrl+Cで停止する。専用Chromeからサーバーに接続できない場合、サンドボックスのネットワーク分離を確認する。

操作前後に、確認済み対象service workerから `chrome.tabs.query({currentWindow:true})` を読み取り、ID・index・groupId・activeを比較する。増加が1タブ、同じgroupId、元タブの右隣、元タブactive=true／新タブactive=falseを確認する。元タブがグループ未所属なら新タブも未所属であることを確認する。拡張の関数や `tabs.create` を直接呼んで結果を作ることはしない。

## 自動検査

Gitルートで実行する。npm scriptsは存在しないため作らず、以下を用いる。

```powershell
node --check background.js
node --check content.js
node --check navigation-learning.js
node --check scripts/synthetic-middle-click.js
node --test tests/*.test.cjs
Get-Content manifest.json -Raw | ConvertFrom-Json | Out-Null
$tokens = $null; $errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $PWD 'scripts/start-dev-chrome.ps1'), [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count) { throw ($errors | Out-String) }
git diff --check
```

各コマンドの終了コードを確認する。構文検査成功はブラウザー動作の成功を意味しない。manifest参照先の実在も確認する。スクリーンショット、Console、認証情報、私的本文やプロファイルをGitへ追加しない。保存が必要ならGit管理外に置く。

## 汎用学習への変更の確認記録（2026-10-24）

- Nodeの自動テスト41件、JS構文、manifest参照先とISOLATED構成、Git差分検査が成功。
- 専用Chromeで「あなたのdot」は学習前の合成中クリックでは何も開かず、MCPの通常左クリックで `/dots/home` を学習した。拡張とページの再読み込み後、合成中クリックで保存結果を再利用した。Codexは新タブの選択状態と履歴状態がcodexであることを確認。
- ChatGPT以外のループバックfixtureでSPA遷移とページ全体の遷移を通常左クリックから学習し、拡張再読み込み後も再利用できた。合成中クリックで増加は1タブ、元タブの右隣、新タブactive=false・元タブactive=trueを確認。
- 同じfixtureボタンを別URLへ左クリック遷移させると競合記録になり、次の合成中クリックでは何も開かなかった。検証用の保存データとタブを除去し、サーバーを停止した。
- fixtureと対象service workerでwarn/errorは0件。通常の左クリックはMCP操作、中クリックは `isTrusted=false` の合成イベントであり、この変更に対する物理中クリック・ブラウザー再起動の実操作は未検証。再起動相当の保存再読込は単体テストと拡張再読み込みで確認した。

## 初回確認記録（2026-10-18）

- 開始時のGit作業ツリーはクリーン。AGENTS.md、package.json、既存スクリプト、プロジェクトMCP設定はなかった。
- Chrome `155.0.8059.80` / Protocol `1.3`。指定実行ファイル、展開済み専用プロファイル、9222を所有する同一プロセス、HTTP応答を照合し再利用した。
- MCP `1.11.0`。実行中プロセスの版と、`@latest --version` が一致。`--help` でcategoryExtensions・workspace・browser-url対応を確認。
- `list_pages` と `list_extensions` は応答。対象MiddleClick+は一覧になく、導入を試みたが既存MCPのworkspaceが別プロジェクトに限定されているため `Access denied ... not within any of the configured workspace roots` で拒否された。
- 新規ローカル設定の稼働中MCPへの反映、対象拡張の導入・再読み込み・対象URLでのUI動作は未確認。再接続後に上記順序で再開する。通常ブラウザーや他拡張には変更を加えていない。
- ユーザー指定の対象URLは `https://chatgpt.com/`。新規検証タブでホーム・サイドバー・入力欄をsnapshotとスクリーンショットで確認。読み取り時のviewportは1545×1286 CSS px、DPR 1.5。変更前の基準画面のみで、拡張動作の成功とは扱わない。
- ConsoleにはlocalStorage SecurityError、Statsigキャッシュ警告、ERR_BLOCKED_BY_CLIENTがあった。SecurityErrorのstackはVM内content.js、ほかも対象拡張IDへ帰属させる証拠はなく、発生元の確定は未完了。MiddleClick+のエラーとは判断していない。私的なsnapshot本文・画像はファイルに保存していない。
- 自動検査: 3つのJSの `node --check`、manifest JSON解析・参照ファイルの実在確認、PowerShell Parser、`git diff --check` が成功。起動スクリプトは既存専用Chromeの再利用・プロセス／HTTP照合に成功。一時的な非Chromeの待受ポートでは終了コード1・競合理由で停止し、待受プロセスを終了しないことを確認した。未起動からのChrome起動と物理中クリックは未検証。

## プロジェクト専用構成への変更（2026-10-18）

- 別プロジェクトが共有Chromeで検証中との申告を受け、当プロジェクトは専用プロファイル `Chrome-MCP-MiddleClick-enhanced` と9223へ分離した。上記の初回記録にある9222は過去の構成。
- 親・子両方のMCP設定、起動スクリプト既定値、AGENTS.md、READMEを更新した。ユーザー全体の設定は変更していない。
- 起動スクリプトで新しい専用Chromeを起動し、実行ファイル・プロファイル引数・9223の所有PID・HTTPのChromeバージョンを照合した。共有側9222とは別PIDでの待受を確認した。共有Chromeには操作を行っていない。
- 起動スクリプトの構文検査とGit差分検査は成功。稼働中のMCPプロセスはまだ別workspace／9222を指定しているため、専用Chromeでの拡張導入・ChatGPT上の動作検証は未実施。MCPの再構成が必要で、単なるChrome分離だけで解決したとは扱わない。
- 設定診断: デスクトップ同梱Codex `0.163.0-alpha.10.2` の一時的なapp-serverで、公式JSON-RPCの `initialize` → `config/read`（作業フォルダーをcwdに指定、includeLayers=true）を実行した。MCPに関係する設定とレイヤーの無効理由だけを出力し、認証・モデル等の設定は出力していない。
- 診断結果では、作業フォルダーの `.codex/config.toml` にある9223設定を検出しつつ、ユーザー設定ファイルへの当該プロジェクトの信頼登録を要求する `disabledReason` が付いていた。有効なMCP設定はユーザー側の別workspace／9222だった。プロセス内だけのtrust指定でも無効化は解消しなかった。
- 現在の制約ではユーザー全体の設定ファイルを変更できないため、このプロジェクトのtrust登録を同ファイルへ追加する場合は例外の許可が必要。既存MCPのworkspace・接続先の変更とは分ける。全体向けMCP再読み込みや、ブラウザー操作を別クライアントへ切り替えて制限を迂回する操作は行わない。

## 信頼登録追加後の状態（2026-10-18）

- ユーザーがこのプロジェクトの信頼登録1件の追加を明示許可。ユーザー設定ファイルへ正規化済みのチャット作業フォルダーをキーとする `trust_level = "trusted"` を追記した。既存内容をバイト単位で保持し、追記分以外に変更がないことを確認した。既存MCP設定・他プロジェクトの設定は変更していない。
- `codex mcp get chrome-devtools` は当プロジェクトのworkspaceと `http://127.0.0.1:9223` を表示するようになった。起動スクリプトは専用プロファイルと9223の所有プロセス・HTTP応答の照合に成功した。
- 設定読み込みの問題は解消したが、当該確認時点では9223向けのMCPプロセスはまだ起動していなかった。現在のチャットのMCP接続を再作成し、9223への実接続を確認してから拡張導入へ進む。全チャット向けのMCP再読み込みや他プロジェクトのプロセス終了は行わない。

## 9223への実接続と拡張導入（2026-10-18）

- Codex再起動後、プロジェクトworkspaceと9223を指定するMCPプロセスを確認した。起動スクリプトで専用Chromeを起動し、専用プロファイル・ポート所有者・HTTP応答の照合に成功。別プロジェクトのChromeは操作していない。
- 使用版はChrome `155.0.8059.80`、実行中MCPパッケージ `1.11.0`。
- 実ツール定義を再確認し、`list_pages` → `list_extensions` → 未導入の対象への `install_extension` を実行した。Gitルートのパスが受理され、`MiddleClick+ 1.2.2` がEnabledで導入された。拡張IDは保存値を再利用せず、次回も一覧・導入結果から取得する。
- 拡張service workerから読み取った `background.js`、`content.js`、`chatgpt-bridge.js` のSHA-256がローカルファイルと全て一致した。版数だけでなく内容を照合した。
- `reload_extension` → 対象ページのreloadが成功。ログイン・二段階認証はユーザー本人が専用Chrome内で行い、ログイン済みホームとサイドバーを確認した。
- 基準viewportは1251×1294 CSS px、DPR 1.5。「新しいチャット」はBUTTONで、取得時の寸法は276×35 CSS px。snapshot、対象ボタンだけのスクリーンショット、DOM寸法を確認した。私的な会話名・本文・認証情報を含む画像やログは保存していない。
- 未ログイン時にはGoogle One Tap / FedCM関連の警告・認証エラーがあり、ログイン後の確認ではサイトのStatsigキャッシュ警告があった。対象拡張service workerのwarn/error取得結果は0件。これらを対象拡張のエラーとは扱っていない。
- 物理中クリックの基本受入は成功。ユーザーが上部の「新しいチャット」を実際のホイールボタンで1回中クリックし、MCPで操作前後を観測した。タブ数は2→3で、増加は1タブのみ。新しいタブのURLはChatGPTホーム、元タブのindexは1、新しいタブは2で右隣に挿入され、元タブはactive=true、新しいタブはactive=falseを維持した。
- 操作前後のviewportは1251×1294 CSS px、DPR 1.5で一致。「新しいチャット」の位置・寸法も一致。操作後の対象拡張service workerのwarn/error取得結果は0件。合成イベントや直接のタブ作成を使った検証ではない。
- この時点で未確認だった会話／プロジェクトの合成イベント検証は、後述の6ケースで実施済み。一般サイトの通常リンク、短時間の連続中クリック、Shadow DOM等の網羅的な回帰検証は未確認。

## タブグループ継承の改修・検証（2026-10-18）

- 拡張が作成する中クリックタブを、元タブの最新のグループへ `chrome.tabs.group` で追加するよう改修。グループ追加でタブが移動した場合も右隣へ戻す。未所属の場合はグループを新規作成しない。グループ追加失敗時には作成済みタブを保持し、重複作成しない。版数・権限は変更していない。
- Nodeの回帰テスト8件が成功。修正前にはグループ継承等の4件が失敗することを確認し、修正後に8件全て成功した。対象はgroupId=0、最新グループの参照、未所属、グループ追加失敗、作成再試行、元タブ消失、グループ追加による並び替え、元タブなし。JS構文検査・差分検査も成功。
- 9223の専用Chromeで拡張→ページの順に再読み込み。Chrome内のbackground.jsと修正ファイルのSHA-256一致を確認した。
- 実マウス検証: ユーザーがグループ内のChatGPTホームで「新しいチャット」を1回中クリック。タブ数は1→2、元タブと新タブのgroupIdは同一、indexは0→1で右隣、新タブactive=false／元タブactive=true。viewportは前後とも1251×1294 CSS px、DPR 1.5。対象拡張service workerのwarn/errorは0件。
- Codexの合成イベント検証: 同じ元タブからpointerdown/mousedown/pointerup/mouseup/auxclick（button=1）を送信した。既存2タブのグループ内でタブ数は2→3、増加は1、同じグループの右隣に新タブを挿入し、既存の子タブはさらに右へ移動。元タブの選択を維持した。対象拡張service workerのwarn/errorは0件。実入力とは区別する。
- 保存した `scripts/synthetic-middle-click.js` もMCPのsourcePathから実行し、自動判定7項目（増加1タブ、同じグループ、右隣、元タブ選択維持、新タブ非選択、期待URL、合成入力の識別）が全てPASS。既存3タブの状態から4タブとなった。
- Chrome標準に任せる一般サイトのリンク、短時間連続入力の実画面回帰は未確認。会話／プロジェクトは後述の合成イベント検証を実施した。他プロジェクトのChromeは操作していない。

## 会話・プロジェクトとグループ未所属の自動検証（2026-10-18）

9223の専用Chromeを照合してから、新しい検証用ChatGPTホームタブを作成した。同じ検証用タブで未所属の3ケースを実行し、その後、この検証用タブだけを新しいグループに入れて所属の3ケースを実行した。既存タブのグループは変更していない。

| 対象 | グループ未所属 | グループ所属 |
| --- | --- | --- |
| 新しいチャット | PASS | PASS |
| 会話リンク | PASS | PASS |
| プロジェクト行 | PASS | PASS |

各ケースで次の10項目を自動判定し、6ケースすべて成功した。

1. 増加は1タブだけ。
2. 新タブのgroupIdは元タブと同じ（未所属の場合は両方-1）。
3. 新タブは元タブの右隣。
4. 元タブはactive=trueを維持。
5. 新タブはactive=false。
6. 元タブのURLは変化しない。
7. 新タブのURLは実DOMから得た期待URLと一致。
8. 新タブのsnapshotでも期待URLへの表示を確認。
9. スクリプトが識別した対象種別が指定ケースと一致。
10. 送信したイベントは合成イベント（isTrusted=false）として識別。

対象拡張service workerのwarn/error取得結果は0件。合成イベントによる結果であり、物理入力や全ての会話・プロジェクトを網羅した結果とは扱わない。テストは表示中の会話リンク1件・プロジェクト1件を各状態で使用した。短時間連続入力、一般サイトのネイティブ動作は未確認。

各ケースの新規タブと最後の検証用元タブは、作成時のページ一覧との差分で所有を確認して閉じた。終了時に、開始前からあった4タブのID・並び・groupId・active状態が保たれていることを確認した。私的な会話名・本文・個別URL・認証情報をファイルへ保存せず、他プロジェクトのChromeも操作していない。

## トラブルシューティング

- 9223競合: 所有PIDと実行ファイルを確認し報告。勝手に終了・別ポートへ変更しない。
- CIM/TCP情報の取得拒否: 確認不能として停止。必要な権限でスクリプトを実行できる状態にし、再確認する。
- HTTPだけ応答: プロファイル照合未完了なら操作しない。
- 専用Chromeが応答しない: 他作業者と調整してユーザーが閉じ、再実行する。ロックファイルは削除しない。
- Access denied: 信頼状態、プロジェクトルート、反映後のworkspaceを確認。プロファイル追加や別クライアントで回避しない。
- install/reloadがChrome側で拒否: エラーと公式対応状況を確認し、必要なChrome更新または上記手動手順を案内する。起動フラグを独断で追加しない。
- 変更が見えない: 導入結果・読み込み元・IDを照合し、拡張→ページの順に再読み込み。版数以外に変更箇所のDOM・動作とConsoleを確認する。

## 次回依頼用プロンプト

```text
このGitルートのAGENTS.mdとdocs/CHROME_DEVTOOLS_MCP.mdに従い、専用ChromeとChrome DevTools MCPで開発・検証してください。
対象URL: <URL>
変更内容: <内容>
他の作業者による専用Chromeの操作は終了済みです。
起動スクリプトで接続先を照合し、実ツール定義・読み込み元を確認してから作業してください。
既存変更を保持し、通常ブラウザー・他拡張は変更せず、commit・push・公開はしないでください。
構文検査と実画面結果を分け、物理中クリックが必要なら操作を案内してください。
```
