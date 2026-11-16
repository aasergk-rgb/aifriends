// AI Best Friend - フロントエンド
const $ = (id) => document.getElementById(id);
const chatEl = $('chat');
const inputEl = $('input');
const sendBtn = $('sendBtn');
const micBtn = $('micBtn');
const statusEl = $('status');
const avatarEl = $('avatar');

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};

let profile = store.get('profile', {
  friendName: 'ハル',
  userName: '',
  personality: '明るくて聞き上手。ちょっとおちゃめで、困ったときは本気で味方になってくれる。',
  voiceId: '',
  handsFree: false,
  memories: [],
});
let messages = store.get('messages', []);
let voiceOn = store.get('voiceOn', true);
let ttsEnabled = true;
let busy = false;
let turnsSinceMemory = 0;
let currentAudio = null;
let appPassword = store.get('appPassword', '');

// 合言葉付きで API を呼ぶ。401 なら合言葉を聞き直して再試行
async function api(path, payload) {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-app-password': appPassword },
      body: JSON.stringify(payload),
    });
    if (res.status !== 401) return res;
    const pw = prompt(i ? '合言葉が違います。もう一度入力してください' : '合言葉を入力してください');
    if (pw === null) return res;
    appPassword = pw; store.set('appPassword', pw);
  }
  throw new Error('合言葉が違います');
}

// ---------- 表示 ----------
function render() {
  $('friendNameLabel').textContent = profile.friendName || 'ハル';
  $('voiceToggle').textContent = voiceOn && ttsEnabled ? '🔊' : '🔇';
  chatEl.innerHTML = '';
  if (!messages.length) {
    addBubble('model', `やっほー！${profile.friendName || 'ハル'}だよ。今日はどんな一日だった？`, false);
  }
  for (const m of messages) addBubble(m.role, m.text, false);
  scrollDown();
}

function addBubble(role, text, scroll = true) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  if (role === 'model' && ttsEnabled) {
    const b = document.createElement('button');
    b.className = 'replay'; b.title = 'もう一度聞く'; b.textContent = '▶';
    b.onclick = () => speak(text);
    div.appendChild(b);
  }
  chatEl.appendChild(div);
  if (scroll) scrollDown();
  return div;
}

function showTyping() {
  const div = document.createElement('div');
  div.className = 'msg model typing';
  div.innerHTML = '<span></span><span></span><span></span>';
  chatEl.appendChild(div);
  scrollDown();
  return div;
}

function scrollDown() { chatEl.scrollTop = chatEl.scrollHeight; }
function setStatus(s) { statusEl.textContent = s; }

// ---------- 会話 ----------
async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true; sendBtn.disabled = true;
  stopAudio();
  messages.push({ role: 'user', text, at: Date.now() });
  addBubble('user', text);
  inputEl.value = ''; autoGrow();
  const typing = showTyping();
  setStatus('入力中…');
  try {
    const res = await api('/api/chat', { messages, profile });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    typing.remove();
    messages.push({ role: 'model', text: data.reply, at: Date.now() });
    store.set('messages', messages.slice(-200));
    addBubble('model', data.reply);
    setStatus('オンライン');
    if (voiceOn && ttsEnabled) await speak(data.reply);
    maybeUpdateMemory();
  } catch (e) {
    typing.remove();
    messages.pop();
    addBubble('error', `エラー: ${e.message}`);
    setStatus('オンライン');
  } finally {
    busy = false; sendBtn.disabled = false;
    if (profile.handsFree && recognition && !currentAudio) startListening();
  }
}

// 数ターンごとに会話から記憶を更新
async function maybeUpdateMemory() {
  turnsSinceMemory++;
  if (turnsSinceMemory < 4) return;
  turnsSinceMemory = 0;
  try {
    const res = await api('/api/memory', ({ messages: messages.slice(-12), memories: profile.memories || [], userName: profile.userName || 'ユーザー' }));
    const data = await res.json();
    if (res.ok && Array.isArray(data.memories)) {
      profile.memories = data.memories;
      store.set('profile', profile);
    }
  } catch { /* 記憶更新の失敗は無視 */ }
}

// ---------- 音声合成 (Fish Audio) ----------
function stopAudio() {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  avatarEl.classList.remove('speaking');
}

async function speak(text) {
  stopAudio();
  try {
    setStatus('話し中…');
    const res = await api('/api/tts', { text, voiceId: profile.voiceId });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || res.statusText);
    }
    const url = URL.createObjectURL(await res.blob());
    const audio = new Audio(url);
    currentAudio = audio;
    avatarEl.classList.add('speaking');
    await new Promise((resolve) => {
      audio.onended = audio.onerror = audio.onpause = resolve;
      audio.play().catch(resolve);
    });
    URL.revokeObjectURL(url);
    if (currentAudio === audio) {
      currentAudio = null;
      if (profile.handsFree && recognition && !busy) startListening();
    }
  } catch (e) {
    addBubble('error', `音声エラー: ${e.message}`);
  } finally {
    avatarEl.classList.remove('speaking');
    setStatus('オンライン');
  }
}

// ---------- 音声認識 (ブラウザ標準 Web Speech API) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;
if (SR) {
  recognition = new SR();
  recognition.lang = 'ja-JP';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.onresult = (ev) => {
    let finalText = '', interim = '';
    for (const r of ev.results) (r.isFinal ? (finalText += r[0].transcript) : (interim += r[0].transcript));
    inputEl.value = finalText || interim;
    autoGrow();
    if (finalText) { stopListening(); send(finalText); }
  };
  recognition.onend = () => stopListening();
  recognition.onerror = () => stopListening();
} else {
  micBtn.title = 'このブラウザは音声入力に対応していません（Chrome推奨）';
  micBtn.style.opacity = .4;
}

function startListening() {
  if (!recognition || listening) return;
  stopAudio();
  try { recognition.start(); listening = true; micBtn.classList.add('listening'); setStatus('聞いてるよ…'); } catch {}
}
function stopListening() {
  if (!recognition) return;
  if (listening) { try { recognition.stop(); } catch {} }
  listening = false; micBtn.classList.remove('listening');
  if (statusEl.textContent === '聞いてるよ…') setStatus('オンライン');
}
micBtn.onclick = () => (listening ? stopListening() : startListening());

// ---------- 入力欄 ----------
function autoGrow() { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px'; }
inputEl.addEventListener('input', autoGrow);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(inputEl.value); }
});
$('composer').addEventListener('submit', (e) => { e.preventDefault(); send(inputEl.value); });

$('voiceToggle').onclick = () => {
  if (!ttsEnabled) return alert('サーバーに FISH_API_KEY が設定されていません');
  voiceOn = !voiceOn; store.set('voiceOn', voiceOn);
  if (!voiceOn) stopAudio();
  $('voiceToggle').textContent = voiceOn ? '🔊' : '🔇';
};

// ---------- 設定 ----------
const dlg = $('settings');
const form = $('settingsForm');
$('settingsBtn').onclick = () => {
  form.friendName.value = profile.friendName || '';
  form.userName.value = profile.userName || '';
  form.personality.value = profile.personality || '';
  form.voiceId.value = profile.voiceId || '';
  form.handsFree.checked = !!profile.handsFree;
  form.memories.value = (profile.memories || []).join('\n');
  $('memCount').textContent = (profile.memories || []).length;
  dlg.showModal();
};
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  profile = {
    ...profile,
    friendName: form.friendName.value.trim() || 'ハル',
    userName: form.userName.value.trim(),
    personality: form.personality.value.trim(),
    voiceId: form.voiceId.value.trim(),
    handsFree: form.handsFree.checked,
    memories: form.memories.value.split('\n').map((s) => s.trim()).filter(Boolean),
  };
  store.set('profile', profile);
  render();
});
$('resetBtn').onclick = () => {
  if (!confirm('会話履歴を消しますか？（覚えていることは残ります）')) return;
  messages = []; store.set('messages', messages);
  dlg.close(); render();
};

// ---------- 起動 ----------
fetch('/api/config').then((r) => r.json()).then((c) => {
  ttsEnabled = !!c.ttsEnabled;
  if (c.passwordRequired && !appPassword) {
    appPassword = prompt('合言葉を入力してください') || '';
    store.set('appPassword', appPassword);
  }
  render();
}).catch(render);
