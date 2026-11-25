# game-debug-workbench

A Codex and Claude Code skill for adding a debug panel to browser games. The workbench and both playable demos open in English or Japanese based on the browser’s preferred languages. In a game with its own language setting, pass it to `mountWorkbench({ locale, ... })`. Translate game-specific labels in the adapter. [Try the ball demo](https://ryotakuga-source.github.io/game-debug-workbench/assets/web/demo.html) · [Language setup](references/integration.md#display-language)

ブラウザゲームに開発用のデバッグ盤を追加する、Codex・Claude Code向けのスキルです。ゲーム画面を見ながら、イベントが起きたコマで止めたり、調整値を変えて同じ入力を再生したりできます。

盤面と見本はブラウザの優先言語に合わせて日本語・英語で表示します。ゲームに言語設定があれば、そちらを優先できます。

## 見本を試す

[ボールの反発](https://ryotakuga-source.github.io/game-debug-workbench/assets/web/demo.html) ／ [3レーンの配達](https://ryotakuga-source.github.io/game-debug-workbench/assets/web/lane-demo.html)

ボールの見本で「場面の切り替え」から「着地の直前」を選びます。「イベントで自動停止」で「床に当たる」を選び、「発生まで進む」を押すと、着地した瞬間で止まります。「1コマ進む」で反発の様子を追えます。長押しすると連続で進みます。

手元で試すときは、ダウンロードしたフォルダの `assets/web/demo.html` をブラウザで開いてください。2つの見本は同じJavaScriptとCSSを読み込みます。

## スキルを入れる

使うツールに合わせて、次のコマンドでリポジトリを取得します。すでに同名のスキルを入れている場合は、手元の変更を確認してから更新してください。

**Codex**

```sh
git clone https://github.com/ryotakuga-source/game-debug-workbench.git "$HOME/.agents/skills/game-debug-workbench"
```

**Claude Code**

```sh
git clone https://github.com/ryotakuga-source/game-debug-workbench.git "$HOME/.claude/skills/game-debug-workbench"
```

インストールしたらゲームのプロジェクトで新しいセッションを開き、たとえば次のように依頼します。

> game-debug-workbench を使って、ゲーム画面の横に調整パネルを追加して。着地した瞬間で止めて、重力を変えながら1コマずつ確認したい。

Gitで取得したスキルは、そのフォルダで `git pull --ff-only` を実行すると更新できます。

## 自分のゲームに組み込む

最小構成は、プレビュー要素と表示したい状態を渡すだけです。コマ送りにはゲームの更新関数、イベント停止にはゲーム側からの通知をつなぎます。A/B比較を使う場合は、乱数を含む開始状態の保存・復元と、固定コマで入力を適用する処理も接続します。[最小構成と機能別の組み込み手順](references/integration.md)

ゲーム側の接続例は[ボールのコード](assets/web/demo.js)と[配達のコード](assets/web/lane-demo.js)で見られます。共通部品はフレームワークに依存せず、ゲームの更新ループを使います。

## 利用条件

MITライセンスで公開しています。商用利用・改変・再配布ができます。ソフトウェアのコピーや主要な部分を配布するときは、著作権表示と許諾文を同梱してください。[ライセンス全文](LICENSE)
