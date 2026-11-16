// AI Best Friend - 依存パッケージなしの Node.js サーバー
// APIキーはサーバー側だけで使い、ブラウザには渡しません。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- .env 読み込み ---
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const {
  GEMINI_API_KEY,
  FISH_API_KEY,
  GEMINI_MODEL = 'gemini-3.5-flash-lite',
  FISH_MODEL = 's2.1-pro-free',
  FISH_VOICE_ID = '',
  PORT = '3000',
} = process.env;

if (!GEMINI_API_KEY) console.warn('⚠ GEMINI_API_KEY が設定されていません (.env を確認)');
if (!FISH_API_KEY) console.warn('⚠ FISH_API_KEY が設定されていません (音声はオフになります)');

// --- 親友キャラクターのシステムプロンプト ---
function buildSystemPrompt(p = {}) {
  const friendName = p.friendName || 'ハル';
  const userName = p.userName || 'きみ';
  const personality = p.personality || '明るくて聞き上手。ちょっとおちゃめで、困ったときは本気で味方になってくれる。';
  const memories = Array.isArray(p.memories) && p.memories.length
    ? `\n# ${userName}について覚えていること\n` + p.memories.map((m) => `- ${m}`).join('\n')
    : '';
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  return `あなたは「${friendName}」。${userName}の一番の親友です。AIアシスタントではなく、気の置けない友達として話してください。

# 性格
${personality}

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
async function geminiGenerate({ systemPrompt, contents, json = false }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const body = {
    contents,
    generationConfig: { temperature: json ? 0.2 : 0.9, maxOutputTokens: 1024 },
  };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
  if (json) body.generationConfig.responseMimeType = 'application/json';
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
  return messages
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .slice(-40)
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] }));
}

async function handleChat(req, res) {
  const { messages = [], profile = {} } = await readJson(req);
  const contents = toContents(messages);
  if (!contents.length || contents[contents.length - 1].role !== 'user') {
    return sendJson(res, 400, { error: 'messages の最後はユーザー発言にしてください' });
  }
  const reply = await geminiGenerate({ systemPrompt: buildSystemPrompt(profile), contents });
  sendJson(res, 200, { reply: reply || '…ごめん、ちょっとぼーっとしてた。もう一回言って？' });
}

// 会話から「覚えておくべきこと」を抽出して記憶を更新
async function handleMemory(req, res) {
  const { messages = [], memories = [], userName = 'ユーザー' } = await readJson(req);
  const convo = messages.slice(-12).map((m) => `${m.role === 'user' ? userName : '親友'}: ${m.text}`).join('\n');
  const prompt = `以下は${userName}と親友AIの会話と、既存の記憶リストです。
${userName}について長く覚えておく価値のある事実（好み、予定、人間関係、悩み、出来事など）を反映して、更新後の記憶リストを返してください。
- 重複はまとめる。古くなった情報は更新する。最大30件、各30文字程度。
- 出力は JSON: {"memories": ["...", ...]}

# 既存の記憶
${JSON.stringify(memories)}

# 最近の会話
${convo}`;
  const text = await geminiGenerate({ contents: [{ role: 'user', parts: [{ text: prompt }] }], json: true });
  let out = memories;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed.memories)) out = parsed.memories.filter((s) => typeof s === 'string').slice(0, 30);
  } catch { /* 失敗時は既存の記憶を維持 */ }
  sendJson(res, 200, { memories: out });
}

// --- Fish Audio TTS ---
async function handleTts(req, res) {
  if (!FISH_API_KEY) return sendJson(res, 503, { error: 'FISH_API_KEY が未設定です' });
  const { text = '', voiceId } = await readJson(req);
  const clean = String(text).replace(/[*_#`>~]/g, '').trim().slice(0, 1000);
  if (!clean) return sendJson(res, 400, { error: 'text が空です' });
  const body = { text: clean, format: 'mp3', mp3_bitrate: 128, latency: 'balanced', normalize: true };
  const ref = (voiceId || FISH_VOICE_ID || '').trim();
  if (ref) body.reference_id = ref;
  const r = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${FISH_API_KEY}`,
      'Content-Type': 'application/json',
      model: FISH_MODEL,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => '');
    return sendJson(res, 502, { error: `Fish Audio ${r.status}: ${msg.slice(0, 300)}` });
  }
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
  for await (const chunk of r.body) res.write(chunk);
  res.end();
}

// --- 共通ユーティリティ ---
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new Error('payload too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const publicDir = path.join(__dirname, 'public');

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(publicDir, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(publicDir)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const routes = {
  'POST /api/chat': handleChat,
  'POST /api/memory': handleMemory,
  'POST /api/tts': handleTts,
  'GET /api/config': (req, res) => sendJson(res, 200, { ttsEnabled: !!FISH_API_KEY, defaultVoiceId: FISH_VOICE_ID }),
};

http.createServer(async (req, res) => {
  const handler = routes[`${req.method} ${new URL(req.url, 'http://x').pathname}`];
  if (!handler) return req.method === 'GET' ? serveStatic(req, res) : sendJson(res, 404, { error: 'not found' });
  try {
    await handler(req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.end();
  }
}).listen(Number(PORT), () => {
  console.log(`🫶 AI Best Friend: http://localhost:${PORT}`);
});
