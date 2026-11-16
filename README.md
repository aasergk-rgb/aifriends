# AI Best Friend 🫶

Gemini で会話し、Fish Audio の声で話してくれる「親友AI」。

- 💬 タメ口で話す親友キャラ（名前・性格・呼ばれ方を設定可能）
- 🔊 Fish Audio (`s2.1-pro-free`) で返事を読み上げ
- 🎤 マイクで話しかけられる（Chrome / Edge / Safari の音声認識）、ハンズフリーモードあり
- 🧠 会話から「あなたについて覚えておくこと」を自動で記憶（設定画面で確認・編集可）
- 🔐 APIキーはサーバー側だけで使用し、ブラウザには送りません

## 使い方

必要なもの: Node.js 18 以上（追加パッケージ不要）

```bash
cp .env.example .env   # FISH_API_KEY と GEMINI_API_KEY を記入
npm start              # → http://localhost:3000
```

## Vercel で公開する

1. https://vercel.com に GitHub アカウントでログイン
2. **Add New… → Project** で `aifriends` リポジトリを **Import**
3. Framework Preset は **Other** のまま。**Environment Variables** に以下を追加して **Deploy**

| 名前 | 値 |
|---|---|
| `GEMINI_API_KEY` | Gemini の API キー |
| `FISH_API_KEY` | Fish Audio の API キー |
| `APP_PASSWORD` | 好きな合言葉（**必ず設定**。未設定だと誰でもあなたのキーで使えます） |
| `FISH_VOICE_ID` | （任意）声モデルID |
| `GEMINI_MODEL` / `FISH_MODEL` | （任意）既定は `gemini-3.5-flash-lite` / `s2.1-pro-free` |

デプロイ後の `https://〇〇.vercel.app` を開くと合言葉を聞かれます。HTTPS なのでスマホのマイク入力も使えます。
環境変数を変えたら **Deployments → Redeploy** で反映されます。

### 声を選ぶ
https://fish.audio で好きな声を探し、そのページURL末尾のIDを `.env` の `FISH_VOICE_ID`
または画面右上 ⚙️ の「Fish Audio 声モデルID」に入れてください。空欄ならデフォルト音声です。

### 注意
- マイク入力は `localhost` か HTTPS でのみ動作します（Vercel は HTTPS なのでOK）。
- 会話履歴と記憶はブラウザの localStorage に保存されます。

## 構成
| ファイル | 役割 |
|---|---|
| `lib/core.js` | 本体: `/api/chat`(Gemini) `/api/memory`(記憶抽出) `/api/tts`(Fish Audio) と合言葉チェック |
| `api/*.js` | Vercel Functions（`lib/core.js` を呼ぶだけ） |
| `server.js` | ローカル開発用サーバー（`npm start`） |
| `public/` | チャットUI（HTML/CSS/JS） |
