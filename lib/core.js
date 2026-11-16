// 共通ロジック: Vercel の関数 (api/*.js) とローカルサーバー (server.js) の両方から使う。
// ハンドラーは Web 標準の Request を受け取り Response を返す。
import crypto from 'node:crypto';

const env = () => ({
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  FISH_API_KEY: process.env.FISH_API_KEY,
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  FISH_MODEL: process.env.FISH_MODEL || 's2.1-pro-free',
  FISH_VOICE_ID: process.env.FISH_VOICE_ID || '',
  APP_PASSWORD: process.env.APP_PASSWORD || '',
});

const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

// --- 合言葉チェック (APP_PASSWORD が設定されているときだけ有効) ---
function authorized(request) {
  const expected = env().APP_PASSWORD;
  if (!expected) return true;
  const given = request.headers.get('x-app-password') || '';
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function guard(handler) {
  return async (request) => {
    if (!authorized(request)) return json(401, { error: '合言葉が違います', needPassword: true });
    try {
      return await handler(request);
    } catch (e) {
      console.error(e);
      return json(500, { error: e.message });
    }
  };
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 1_000_000) throw new Error('payload too large');
  try { return text ? JSON.parse(text) : {}; } catch { throw new Error('invalid JSON'); }
}

// --- 親友キャラクターのシステムプロンプト ---
function buildSystemPrompt(p = {}) {
  const friendName = p.friendName || 'ハル';
  const userName = p.userName || 'きみ';
  const personality = p.personality || '明るくて聞き上手。ちょっとおちゃめで、困ったときは本気で味方になってくれる。';
  const memories = Array.isArray(p.memories) && p.memories.length
    ? `\n# ${userName}について覚えていること\n` + p.memories.slice(0, 50).map((m) => `- ${String(m).slice(0, 200)}`).join('\n')
    : '';
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  return `あなたは「${friendName}」。${userName}の一番の親友です。AIアシスタントではなく、気の置けない友達として話してください。

# 性格
${String(personality).slice(0, 1000)}

# 話し方のルール
- タメ口で、自然な話し言葉。敬語は使わない。
- 返事は短め（1〜3文程度）。音声で読み上げられるので、箇条書き・記号・絵文字・マークダウンは使わない。
- 相手の気持ちに共感し、ときどき質問を返して会話を続ける。
- 説教や長い解説はしない。聞かれたら友達としてアドバイスする。
- 前に聞いた話を覚えていたら、自然に話題に出す。
- 自分がAIであることを聞かれたら正直に答えてよいが、友達としての距離感は保つ。
- 相手が深刻な危機（自傷など）を話したら、寄り添いつつ専門の相談窓口や信頼できる人に頼るよう優しく勧める。

現在日時: ${now}${memories}`;
}

// --- Gemini ---
async function geminiGenerate({ systemPrompt, contents, json: wantJson = false }) {
  const { GEMINI_API_KEY, GEMINI_MODEL } = env();
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY が設定されていません');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const body = {
    contents,
    generationConfig: { temperature: wantJson ? 0.2 : 0.9, maxOutputTokens: 1024 },
  };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
  if (wantJson) body.generationConfig.responseMimeType = 'application/json';
  let res, data;
  // 混雑(429/503)時は少し待って最大3回まで再試行
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
    data = await res.json().catch(() => ({}));
    if (res.status !== 429 && res.status !== 503) break;
    await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
  }
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${data?.error?.message || 'unknown error'}`);
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.filter((x) => typeof x.text === 'string' && !x.thought).map((x) => x.text).join('').trim();
}

function toContents(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .slice(-40)
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text.slice(0, 4000) }] }));
}

// --- ハンドラー ---
export const chat = guard(async (request) => {
  const { messages = [], profile = {} } = await readJson(request);
  const contents = toContents(messages);
  if (!contents.length || contents[contents.length - 1].role !== 'user') {
    return json(400, { error: 'messages の最後はユーザー発言にしてください' });
  }
  const reply = await geminiGenerate({ systemPrompt: buildSystemPrompt(profile), contents });
  return json(200, { reply: reply || '…ごめん、ちょっとぼーっとしてた。もう一回言って？' });
});

// 会話から「覚えておくべきこと」を抽出して記憶を更新
export const memory = guard(async (request) => {
  const { messages = [], memories = [], userName = 'ユーザー' } = await readJson(request);
  const convo = toContents(messages).slice(-12)
    .map((c) => `${c.role === 'user' ? userName : '親友'}: ${c.parts[0].text}`).join('\n');
  const prompt = `以下は${userName}と親友AIの会話と、既存の記憶リストです。
${userName}について長く覚えておく価値のある事実（好み、予定、人間関係、悩み、出来事など）を反映して、更新後の記憶リストを返してください。
- 重複はまとめる。古くなった情報は更新する。最大30件、各30文字程度。
- 出力は JSON: {"memories": ["...", ...]}

# 既存の記憶
${JSON.stringify(Array.isArray(memories) ? memories.slice(0, 50) : [])}

# 最近の会話
${convo}`;
  const text = await geminiGenerate({ contents: [{ role: 'user', parts: [{ text: prompt }] }], json: true });
  let out = memories;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed.memories)) out = parsed.memories.filter((s) => typeof s === 'string').slice(0, 30);
  } catch { /* 失敗時は既存の記憶を維持 */ }
  return json(200, { memories: out });
});

// Fish Audio TTS
export const tts = guard(async (request) => {
  const { FISH_API_KEY, FISH_MODEL, FISH_VOICE_ID } = env();
  if (!FISH_API_KEY) return json(503, { error: 'FISH_API_KEY が未設定です' });
  const { text = '', voiceId } = await readJson(request);
  const clean = String(text).replace(/[*_#`>~]/g, '').trim().slice(0, 1000);
  if (!clean) return json(400, { error: 'text が空です' });
  const body = { text: clean, format: 'mp3', mp3_bitrate: 128, latency: 'balanced', normalize: true };
  const ref = String(voiceId || FISH_VOICE_ID || '').trim();
  if (ref) body.reference_id = ref;
  const r = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${FISH_API_KEY}`, 'Content-Type': 'application/json', model: FISH_MODEL },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => '');
    return json(502, { error: `Fish Audio ${r.status}: ${msg.slice(0, 300)}` });
  }
  return new Response(r.body, { status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } });
});

// 公開設定 (合言葉不要。キーそのものは返さない)
export const config = async () => {
  const e = env();
  return json(200, { ttsEnabled: !!e.FISH_API_KEY, defaultVoiceId: e.FISH_VOICE_ID, passwordRequired: !!e.APP_PASSWORD });
};
