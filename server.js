/* =========================================================
   Loup Garou — server.js  (نسخة مصلحة + بوتات فيهم دماغ صغير للدردشة)
   يطابق البروتوكول اللي كيستعملو olders.html (room:*, game:*, night:*, vote:*, chat:*)
   + نظام Creator آمن (السر فالسيرفر فقط، عبر متغير بيئة)
   + BotBrain: شبكة عصبية صغيرة (~10K بارامتر) مدمجة، تُستعمل غير باش
     البوتات "يفكّرو" شنو يقولو فالشات (اختيار النية + الهدف)، ماشي
     لتوليد نص حر — النصوص نفسها مبنية من بنك جمل جاهزة (توكنات/عبارات)
     باش تبقى مفهومة ومتماسكة.
   =========================================================- */
const crypto = require('crypto');
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(__dirname));

/* ------------------------------------------------------------
   Creator auth (آمن): السر كيتقارن فالسيرفر فقط.
   خاصك تصاوب متغير بيئة قبل التشغيل، مثلاً:
     CREATOR_SECRET=IAM-ALAA-DEVOFLOUPPY node server.js
   ------------------------------------------------------------ */
const CREATOR_SECRET = process.env.CREATOR_SECRET || null;
const CREATOR_SECRET_BUF = CREATOR_SECRET ? Buffer.from(CREATOR_SECRET) : null;

// socket.id ديال أي واحد أثبت أنه Creator فهاد الجلسة الحالية ديال السيرفر
const creatorSockets = new Set();

// حماية ضد brute force: عدد المحاولات الفاشلة لكل IP + وقت آخر محاولة
const creatorAuthAttempts = new Map(); // ip -> { count, firstAttemptAt, blockedUntil }
const CREATOR_AUTH_MAX_ATTEMPTS = 5;
const CREATOR_AUTH_WINDOW_MS = 60 * 1000;   // نافذة دقيقة وحدة
const CREATOR_AUTH_BLOCK_MS = 5 * 60 * 1000; // بلوكاج 5 دقايق بعد ما تنهار المحاولات

// مقارنة آمنة ضد الأسرار (ثابتة فالوقت، ما كتبانش من طول أو محتوى النص)
function safeCompareSecret(input) {
  if (!CREATOR_SECRET_BUF || typeof input !== 'string') return false;
  const inputBuf = Buffer.from(input);
  // خاص نفس الطول باش نقارنو بـ timingSafeEqual، وإلا كندير مقارنة وهمية
  // بنفس المدة تقريباً باش ما نبانوش الفرق فالطول عبر التوقيت
  if (inputBuf.length !== CREATOR_SECRET_BUF.length) {
    crypto.timingSafeEqual(CREATOR_SECRET_BUF, CREATOR_SECRET_BUF);
    return false;
  }
  return crypto.timingSafeEqual(inputBuf, CREATOR_SECRET_BUF);
}

// كيرجع true إذا هاد الـ IP بلوكي دابا بسبب محاولات كثيرة
function isCreatorAuthBlocked(ip) {
  const rec = creatorAuthAttempts.get(ip);
  if (!rec) return false;
  if (rec.blockedUntil && Date.now() < rec.blockedUntil) return true;
  if (rec.blockedUntil && Date.now() >= rec.blockedUntil) {
    creatorAuthAttempts.delete(ip);
    return false;
  }
  return false;
}

function registerFailedCreatorAuth(ip) {
  const now = Date.now();
  let rec = creatorAuthAttempts.get(ip);
  if (!rec || now - rec.firstAttemptAt > CREATOR_AUTH_WINDOW_MS) {
    rec = { count: 0, firstAttemptAt: now, blockedUntil: null };
  }
  rec.count++;
  if (rec.count >= CREATOR_AUTH_MAX_ATTEMPTS) {
    rec.blockedUntil = now + CREATOR_AUTH_BLOCK_MS;
  }
  creatorAuthAttempts.set(ip, rec);
}

function clearCreatorAuthAttempts(ip) {
  creatorAuthAttempts.delete(ip);
}

// IPs محظورة بشكل دائم (كتضيع لما يعاود يتشغل السيرفر — حسب الطلب)
const permBannedIPs = new Set();
// IPs محظورة مؤقتاً لهاد التشغيلة الحالية فقط
const sessionBannedIPs = new Set();

function getClientIP(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return socket.handshake.address;
}

function isBannedIP(ip) {
  return permBannedIPs.has(ip) || sessionBannedIPs.has(ip);
}

function isCreator(socket) {
  return CREATOR_SECRET && creatorSockets.has(socket.id);
}

function requireCreator(socket, cb) {
  if (!isCreator(socket)) {
    socket.emit('creator:error', 'غير مصرح لك بهاد العملية');
    return false;
  }
  cb();
  return true;
}

/* ------------------------------------------------------------
   الأدوار
   ------------------------------------------------------------ */
const ROLES_INFO = {
  VILLAGER:   { name: 'فلاح',         emoji: '🧑‍🌾', color: '#2ecc71', desc: 'يصوّت نهارًا فقط',        wolf: false },
  WEREWOLF:   { name: 'مستذئب',       emoji: '🐺',   color: '#e74c3c', desc: 'يقتل كل ليلة',            wolf: true },
  ALPHA_WOLF: { name: 'ذئب ألفا',     emoji: '🔥🐺', color: '#ff4444', desc: 'الذئب الأقوى',            wolf: true },
  SEER:       { name: 'عرّافة',        emoji: '🔮',   color: '#9b59b6', desc: 'ترى هوية لاعب كل ليلة',   wolf: false },
  WITCH:      { name: 'ساحرة',        emoji: '🧙',   color: '#1abc9c', desc: 'ترياق + سم مرة واحدة',    wolf: false },
  HUNTER:     { name: 'صيّاد',        emoji: '🏹',   color: '#f1c40f', desc: 'سهم أخير عند الموت',      wolf: false },
  BODYGUARD:  { name: 'حارس',         emoji: '🛡️',  color: '#3498db', desc: 'يحمي لاعبًا كل ليلة',      wolf: false },
  CUPID:      { name: 'كيوبيد',       emoji: '💘',   color: '#e91e63', desc: 'يربط عاشقَين',            wolf: false },
  ELDER:      { name: 'شيخ القرية',   emoji: '👴',   color: '#a0522d', desc: 'يتحمل ضربة من الذئاب',    wolf: false },
  FOOL:       { name: 'المجنون',      emoji: '🃏',   color: '#00bcd4', desc: 'يفوز إن أُعدم نهارًا',    wolf: false },
  PLAGUE_DR:  { name: 'طبيب الطاعون', emoji: '⚗️',  color: '#7f8c8d', desc: 'يمرّض لاعبًا',            wolf: false },
  THIEF:      { name: 'اللص',         emoji: '🥷',   color: '#e67e22', desc: 'يسرق دور لاعب آخر',       wolf: false },
};

const ROLE_DIST = {
  5:  ['WEREWOLF', 'SEER', 'WITCH', 'VILLAGER', 'VILLAGER'],
  6:  ['WEREWOLF', 'WEREWOLF', 'SEER', 'WITCH', 'ELDER', 'VILLAGER'],
  7:  ['WEREWOLF', 'WEREWOLF', 'SEER', 'WITCH', 'HUNTER', 'ELDER', 'VILLAGER'],
  8:  ['WEREWOLF', 'WEREWOLF', 'SEER', 'WITCH', 'HUNTER', 'BODYGUARD', 'CUPID', 'VILLAGER'],
  9:  ['WEREWOLF', 'WEREWOLF', 'ALPHA_WOLF', 'SEER', 'WITCH', 'HUNTER', 'BODYGUARD', 'CUPID', 'VILLAGER'],
  10: ['WEREWOLF', 'WEREWOLF', 'ALPHA_WOLF', 'SEER', 'WITCH', 'HUNTER', 'BODYGUARD', 'CUPID', 'FOOL', 'VILLAGER'],
  11: ['WEREWOLF', 'WEREWOLF', 'ALPHA_WOLF', 'SEER', 'WITCH', 'HUNTER', 'BODYGUARD', 'CUPID', 'FOOL', 'THIEF', 'VILLAGER'],
  12: ['WEREWOLF', 'WEREWOLF', 'ALPHA_WOLF', 'SEER', 'WITCH', 'HUNTER', 'BODYGUARD', 'CUPID', 'FOOL', 'THIEF', 'ELDER', 'PLAGUE_DR'],
};

const MAX_PLAYERS = 12;
const MIN_PLAYERS = 5;
const BOT_NAMES = ['سعيد', 'فاطمة', 'يوسف', 'خديجة', 'رشيد', 'سميرة', 'كريم', 'ليلى', 'عادل', 'نادية', 'حمزة', 'أمينة'];
const BOT_AVATARS = ['🤖', '👽', '🐺', '🦊', '🐻', '🦁', '🐯', '🐸'];

function shuffle(arr) { return arr.map(v => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map(x => x[1]); }
function makeId(prefix) { return prefix + '-' + Math.random().toString(36).slice(2, 10); }
function roleInfo(key) { return ROLES_INFO[key] || ROLES_INFO.VILLAGER; }

/* ------------------------------------------------------------
   🧠 BotBrain — شبكة عصبية صغيرة (~10K بارامتر) مدمجة فالسيرفر
   الهدف: غير "التفكير" (شنو ينوي البوت يقول + شكون الهدف)، ماشي
   توليد نص حر — هادشي كيحافظ على جمل مفهومة ب100% ديال الوقت.
   ------------------------------------------------------------ */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function randMatrix(rows, cols, rng) {
  const m = new Array(rows * cols);
  const scale = Math.sqrt(2 / (rows + cols));
  for (let i = 0; i < m.length; i++) m[i] = (rng() * 2 - 1) * scale;
  return m;
}
class TinyBrain {
  // شبكة feed-forward صغيرة: F=16 مدخل → H1=70 → H2=70 → O=50 مخرج
  // مجموع البارامترات ≈ 9710 (قريب من 10K كيما طلب المستخدم)
  constructor(seed = 1337) {
    const rng = mulberry32(seed);
    this.F = 16; this.H1 = 70; this.H2 = 70; this.O = 50;
    this.W1 = randMatrix(this.F, this.H1, rng); this.b1 = new Array(this.H1).fill(0);
    this.W2 = randMatrix(this.H1, this.H2, rng); this.b2 = new Array(this.H2).fill(0);
    this.W3 = randMatrix(this.H2, this.O, rng); this.b3 = new Array(this.O).fill(0);
    this.paramCount =
      this.W1.length + this.b1.length +
      this.W2.length + this.b2.length +
      this.W3.length + this.b3.length;
  }
  static relu(x) { return x > 0 ? x : 0; }
  forward(input) {
    const h1 = new Array(this.H1);
    for (let j = 0; j < this.H1; j++) {
      let s = this.b1[j];
      for (let i = 0; i < this.F; i++) s += input[i] * this.W1[i * this.H1 + j];
      h1[j] = TinyBrain.relu(s);
    }
    const h2 = new Array(this.H2);
    for (let j = 0; j < this.H2; j++) {
      let s = this.b2[j];
      for (let i = 0; i < this.H1; i++) s += h1[i] * this.W2[i * this.H2 + j];
      h2[j] = TinyBrain.relu(s);
    }
    const out = new Array(this.O);
    for (let j = 0; j < this.O; j++) {
      let s = this.b3[j];
      for (let i = 0; i < this.H2; i++) s += h2[i] * this.W3[i * this.O + j];
      out[j] = s;
    }
    return out; // logits خام: [0..11]=نيات, [12..15]=نبرة, [16..49]=اختيار صيغة/توكن
  }
}
const BOT_BRAIN = new TinyBrain(20260911);
console.log(`🧠 BotBrain جاهز — عدد البارامترات: ${BOT_BRAIN.paramCount}`);

function softmax(arr, temp = 1) {
  const m = Math.max(...arr);
  const exps = arr.map(x => Math.exp((x - m) / temp));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map(e => e / sum);
}
function sampleIndex(probs, rng = Math.random) {
  const r = rng(); let acc = 0;
  for (let i = 0; i < probs.length; i++) { acc += probs[i]; if (r <= acc) return i; }
  return probs.length - 1;
}

const INTENTS = [
  'accuse', 'defend_self', 'defend_other', 'suspicious_general',
  'support_vote', 'mourn', 'wolf_target_discuss', 'wolf_agree',
  'calm_villager', 'joke', 'call_for_vote', 'silence_pass',
];
const DAY_INTENT_IDX = [0, 1, 2, 3, 4, 5, 8, 9, 10, 11]; // كلشي ما عدا نوايا الذئاب
const WOLF_INTENT_IDX = [6, 7, 3, 8]; // نوايا خاصة بشات الذئاب

const CHAT_TEMPLATES = {
  accuse: [
    'أنا مركز بزاف على {target}، شي حاجة فيه مشبوهة 🤨',
    '{target} كيهضر بزاف باش يبعد الشك عليه...',
    'واش حد آخر حس بلي {target} غريب الليلة؟',
    'أنا نصوت ضد {target}، ما عنديش ثقة فيه',
  ],
  defend_self: [
    'أنا برئ، عافاك ما ديروش الشك علي!',
    'صافي ثقو فيا، ما عنديش علاقة بالموضوع',
    'كيفاش تشكو فيا؟ أنا غير فلاح عادي!',
  ],
  defend_other: [
    'خليو {target}، ما شفتش عليه شي حاجة مريبة',
    'أنا واثق ف{target}، ماشي هوما',
  ],
  suspicious_general: [
    'كاين شي حد فينا كايكذب...',
    'خاصنا نديرو attention لكل حركة الليلة',
    'الوضعية صعيبة، خاصنا نفكرو مزيان قبل نصوتو',
  ],
  support_vote: [
    'متافق، نصوتو ضد {target}',
    'أنا نتبع الجماعة فهاد التصويت',
  ],
  mourn: [
    'الله يرحمو... خسارة كبيرة 😢',
    'كنا نظن بلي هو بريء...',
    'الله يرحمو، خاصنا نكونو أذكى من دابا',
  ],
  wolf_target_discuss: [
    'شكون نضربو الليلة؟ أنا نقترح {target}',
    '{target} خطر علينا، خاصنا نبعدوه',
    'واش كلكم متافقين على {target}؟',
  ],
  wolf_agree: [
    'متافق، {target} هدف زوين 🐺',
    'ياك، نمشيو عليه الليلة',
  ],
  calm_villager: [
    'سيري بلا ستريس، غادي نلقاو الذيب',
    'خاصنا نبقاو متحدين باش نربحو',
  ],
  joke: [
    '😂 حتى أنا بديت نشك ف راسي',
    'هادي لعبة ولا محكمة؟ 😅',
  ],
  call_for_vote: [
    'واخا نبداو نصوتو؟',
    'خاصنا نحسمو دابا، الوقت كايمشي',
  ],
  silence_pass: ['...', 'مازال كنفكر 🤔'],
};

// شخصية ثابتة لكل بوت (4 خصائص 0..1) مبنية من hash ديال الاسم — كل بوت عندو "طبع" مختلف
const personalityCache = new Map();
function personalityFor(botKey) {
  if (personalityCache.has(botKey)) return personalityCache.get(botKey);
  const rng = mulberry32(hashStr(botKey));
  const p = [rng(), rng(), rng(), rng()]; // [عدوانية, ثرثرة, ثقة, فكاهة]
  personalityCache.set(botKey, p);
  return p;
}

function buildFeatures(room, bot, { isWolfChat = false } = {}) {
  const alive = alivePlayers(room);
  const wolves = wolvesOf(room);
  const accusedCount = (room._suspicion && room._suspicion.get(bot.id)) || 0;
  const p = personalityFor(bot.id + ':' + bot.name);
  return [
    room.phase === 'night' ? 1 : 0,
    room.phase === 'day' ? 1 : 0,
    Math.min(room.day / 10, 1),
    alive.length ? alive.length / room.players.length : 0,
    roleInfo(bot.role).wolf ? 1 : 0,
    Math.min(accusedCount / 3, 1),
    room._justDied ? 1 : 0,
    alive.length ? wolves.length / alive.length : 0,
    p[0], p[1], p[2], p[3],
    Math.random(), Math.random(),
    isWolfChat ? 1 : 0,
    1, // bias
  ];
}

function pickTarget(room, bot, wolvesOnly) {
  const pool = alivePlayers(room).filter(x => x.id !== bot.id && (!wolvesOnly || !roleInfo(x.role).wolf));
  if (!pool.length) return null;
  // كيفضّل هدف تراكمت عليه شكوك (تخزنة فـ room._suspicion) مع شوية عشوائية
  const weights = pool.map(p => 1 + ((room._suspicion && room._suspicion.get(p.id)) || 0) * 1.5);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) return pool[i]; }
  return pool[pool.length - 1];
}

function botThink(room, bot, opts = {}) {
  const isWolfChat = !!opts.isWolfChat;
  const features = buildFeatures(room, bot, { isWolfChat });
  const logits = BOT_BRAIN.forward(features);
  const allowedIdx = isWolfChat ? WOLF_INTENT_IDX : DAY_INTENT_IDX;
  const masked = INTENTS.map((_, i) => (allowedIdx.includes(i) ? logits[i] : -Infinity));
  const probs = softmax(masked, 0.85);
  const intent = INTENTS[sampleIndex(probs)];

  let target = null;
  if (['accuse', 'defend_other', 'support_vote', 'wolf_target_discuss', 'wolf_agree'].includes(intent)) {
    target = pickTarget(room, bot, isWolfChat);
    if (!target) return null;
  }

  const bank = CHAT_TEMPLATES[intent] || CHAT_TEMPLATES.silence_pass;
  // اختيار الصيغة باستعمال جزء من مخرجات الشبكة (توكن الاختيار) بدل عشوائية بحتة
  const variantScore = logits.slice(16, 16 + bank.length);
  const variantProbs = softmax(variantScore.length ? variantScore : [1], 0.9);
  const variantIdx = sampleIndex(variantProbs) % bank.length;
  let text = bank[variantIdx];
  if (target) text = text.replace('{target}', target.name);

  if (intent === 'accuse' && target) bumpSuspicion(room, target.id);

  return { intent, target, text, isWolfChat };
}

function bumpSuspicion(room, playerId) {
  if (!room._suspicion) room._suspicion = new Map();
  room._suspicion.set(playerId, ((room._suspicion.get(playerId)) || 0) + 1);
}

function emitBotChat(room, bot, think) {
  if (!think) return;
  const msg = { sender: bot.name, avatar: bot.avatar, text: think.text, isWolfOnly: think.isWolfChat, isBot: true };
  if (think.isWolfChat) {
    wolvesOf(room).filter(w => !w.isBot).forEach(w => io.to(w.id).emit('chat:message', msg));
  } else {
    io.to(room.code).emit('chat:message', msg);
  }
}

/* ------------------------------------------------------------
   تايمرات الغرفة — تتبع كل setTimeout باش نقدرو نمسحوها ونتفاديو
   تداخل الجولات لما الـ Creator يدير restart/forceEnd أو الغرفة تفرغ
   ------------------------------------------------------------ */
function addTimer(room, fn, ms) {
  const id = setTimeout(() => {
    room.timers.delete(id);
    fn();
  }, ms);
  room.timers.add(id);
  return id;
}
function clearRoomTimers(room) {
  room.timers.forEach(id => clearTimeout(id));
  room.timers.clear();
}

/* ------------------------------------------------------------
   جدولة دردشة البوتات
   ------------------------------------------------------------ */
function scheduleDayChat(room) {
  const window = 45000; // نفس مدة نقاش النهار فـ startDay
  const bots = alivePlayers(room).filter(p => p.isBot);
  bots.forEach(bot => {
    const p = personalityFor(bot.id + ':' + bot.name);
    const msgCount = 1 + Math.round(p[1] * 2); // 1..3 رسائل حسب "الثرثرة"
    for (let i = 0; i < msgCount; i++) {
      const delay = 2000 + Math.random() * (window - 4000);
      addTimer(room, () => {
        if (room.state !== 'playing' || room.phase !== 'day') return;
        const fresh = room.players.find(x => x.id === bot.id);
        if (!fresh || !fresh.alive) return;
        emitBotChat(room, fresh, botThink(room, fresh));
      }, delay);
    }
  });
  if (room._justDied) {
    addTimer(room, () => {
      if (room.state !== 'playing' || room.phase !== 'day') return;
      const mourner = alivePlayers(room).find(p => p.isBot);
      if (mourner) emitBotChat(room, mourner, botThink(room, mourner));
    }, 1200 + Math.random() * 1500);
    room._justDied = false;
  }
}

function scheduleWolfChat(room) {
  const wolfBots = wolvesOf(room).filter(w => w.isBot);
  if (!wolfBots.length) return;
  const rounds = Math.min(2, wolfBots.length);
  for (let i = 0; i < rounds; i++) {
    const speaker = wolfBots[Math.floor(Math.random() * wolfBots.length)];
    addTimer(room, () => {
      if (room.state !== 'playing' || room.phase !== 'night') return;
      const fresh = room.players.find(x => x.id === speaker.id);
      if (!fresh || !fresh.alive) return;
      emitBotChat(room, fresh, botThink(room, fresh, { isWolfChat: true }));
    }, 800 + i * 1800 + Math.random() * 600);
  }
}

function scheduleBotDefense(room, accusedBot) {
  addTimer(room, () => {
    if (room.state !== 'playing' || room.phase !== 'day') return;
    const fresh = room.players.find(x => x.id === accusedBot.id);
    if (!fresh || !fresh.alive) return;
    const think = botThink(room, fresh);
    // نفضّلو رد دفاع إذا كانت النية العامة قريبة، وإلا كنخليو شنو قررات الشبكة
    emitBotChat(room, fresh, think.intent === 'silence_pass'
      ? { ...think, intent: 'defend_self', text: CHAT_TEMPLATES.defend_self[Math.floor(Math.random() * CHAT_TEMPLATES.defend_self.length)] }
      : think);
  }, 1200 + Math.random() * 2200);
}

/* ------------------------------------------------------------
   الغرف
   ------------------------------------------------------------ */
const rooms = new Map(); // code -> room

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function newRoom(hostSocketId) {
  return {
    code: makeRoomCode(),
    hostId: hostSocketId,
    state: 'lobby',        // lobby | playing | ended
    phase: 'night',        // night | day
    day: 1,
    players: [],           // {id,name,avatar,role,alive,isBot,votedFor,lover}
    nightQueue: [],        // ترتيب الأدوار اللي خاصها تتصرف هاد الليلة
    nightIndex: 0,
    nightEvents: [],
    nightKillTarget: null, // هدف الذئاب
    guardedId: null,
    witchHeal: true,
    witchKill: true,
    witchHealUsedOnTarget: null,
    plagueSickId: null,
    lovers: null,          // [id1, id2]
    thiefSwapped: false,
    timers: new Set(),     // كل الـ setTimeout الجارية فهاد الغرفة
    _suspicion: new Map(), // playerId -> عدد المرات اللي اتهم فيها (للبوتات)
    _justDied: false,
  };
}

function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.find(p => p.id === socketId)) return room;
  }
  return null;
}

function alivePlayers(room) { return room.players.filter(p => p.alive); }
function wolvesOf(room) { return alivePlayers(room).filter(p => roleInfo(p.role).wolf); }
function villagersOf(room) { return alivePlayers(room).filter(p => !roleInfo(p.role).wolf); }

function publicPlayer(p) {
  return { id: p.id, name: p.name, avatar: p.avatar, alive: p.alive, isBot: !!p.isBot };
}

function roomPublicState(room) {
  return {
    code: room.code,
    state: room.state,
    phase: room.phase,
    day: room.day,
    players: room.players.map(publicPlayer),
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room:update', roomPublicState(room));
}

function addBotsToRoom(room) {
  const humanCount = room.players.filter(p => !p.isBot).length;
  if (humanCount < 2) return;
  const needed = Math.max(0, Math.min(MIN_PLAYERS, MAX_PLAYERS) - room.players.length);
  const usedNames = new Set(room.players.map(p => p.name));
  const usedAvatars = new Set(room.players.map(p => p.avatar));
  for (let i = 0; i < needed; i++) {
    if (room.players.length >= MAX_PLAYERS) break;
    const name = BOT_NAMES.find(n => !usedNames.has(n)) || `بوت ${i + 1}`;
    usedNames.add(name);
    const avatar = BOT_AVATARS.find(a => !usedAvatars.has(a)) || '🤖';
    usedAvatars.add(avatar);
    room.players.push({
      id: makeId('bot'), name, avatar, role: null, alive: true,
      votedFor: null, isBot: true, lover: false,
    });
  }
}

function assignRoles(room) {
  const n = room.players.length;
  const key = Math.min(Math.max(n, 5), 12);
  let roles = [...(ROLE_DIST[key] || ROLE_DIST[5])];
  while (roles.length < n) roles.push('VILLAGER');
  roles = shuffle(roles).slice(0, n);
  room.players.forEach((p, i) => {
    p.role = roles[i];
    p.alive = true;
    p.votedFor = null;
    p.lover = false;
    p._elderHitOnce = false;
  });
}

function sendRolesToPlayers(room) {
  room.players.forEach(p => {
    if (p.isBot) return;
    const info = roleInfo(p.role);
    let wolfMates = [];
    if (info.wolf) {
      wolfMates = room.players.filter(x => x.id !== p.id && roleInfo(x.role).wolf).map(x => x.name);
    }
    io.to(p.id).emit('game:role', { role: p.role, roleInfo: info, wolfMates });
  });
}

function nightActingOrder(room) {
  // ترتيب منطقي: كيوبيد (ليلة 1 فقط) → حارس → ذئاب → عرّافة → ساحرة → طبيب الطاعون
  const order = [];
  if (room.day === 1) order.push('CUPID');
  order.push('BODYGUARD', 'WEREWOLF', 'SEER', 'WITCH', 'PLAGUE_DR');
  const seen = new Set();
  const result = [];
  order.forEach(role => {
    if (seen.has(role)) return;
    seen.add(role);
    const holders = alivePlayers(room).filter(p => p.role === role || (role === 'WEREWOLF' && roleInfo(p.role).wolf));
    if (holders.length) result.push(role);
  });
  return result;
}

function startNight(room) {
  room.phase = 'night';
  room.nightKillTarget = null;
  room.guardedId = null;
  room.plagueSickId = null;
  room.witchHealUsedOnTarget = null; // 🔧 fix: كان كيبقى محدد من ليلة سابقة ويبلوكي الساحرة غلط
  room.players.forEach(p => { p.votedFor = null; });
  room.nightQueue = nightActingOrder(room);
  room.nightIndex = 0;
  room.nightEvents = [];
  io.to(room.code).emit('phase:night', { day: room.day });
  broadcastRoom(room);
  advanceNightStep(room);
}

function botAutoNightAction(room, bot, role) {
  // بوتات كيديرو أكشن عشوائي بسيط باش الليلة توصل للفجر
  if (role === 'WEREWOLF') {
    const candidates = villagersOf(room);
    if (candidates.length) room.nightKillTarget = candidates[Math.floor(Math.random() * candidates.length)].id;
  } else if (role === 'BODYGUARD') {
    const candidates = alivePlayers(room);
    if (candidates.length) room.guardedId = candidates[Math.floor(Math.random() * candidates.length)].id;
  } else if (role === 'PLAGUE_DR') {
    const candidates = alivePlayers(room);
    if (candidates.length && Math.random() > 0.5) room.plagueSickId = candidates[Math.floor(Math.random() * candidates.length)].id;
  } else if (role === 'SEER' && bot) {
    // بوت العرّافة: كيختار هدف عشوائي ويشوف دوره (نفس منطق pickTarget، بلا تأثير خارجي)
    const candidates = alivePlayers(room).filter(p => p.id !== bot.id);
    if (candidates.length) {
      const target = candidates[Math.floor(Math.random() * candidates.length)];
      // إذا الهدف ذيب، البوت كيزيد شك عليه (كيفعل بالمعلومة كيما لاعب حقيقي)
      if (roleInfo(target.role).wolf) bumpSuspicion(room, target.id);
    }
  } else if (role === 'WITCH' && bot) {
    // بوت الساحرة: عشوائياً كيقرر يعالج ضحية الذئاب و/أو يسمم لاعب آخر
    if (room.witchHeal && room.nightKillTarget && Math.random() > 0.5) {
      room.witchHeal = false;
      room.witchHealUsedOnTarget = room.nightKillTarget;
      room.nightKillTarget = null;
    } else if (room.witchKill && Math.random() > 0.75) {
      const candidates = alivePlayers(room).filter(p => p.id !== bot.id);
      if (candidates.length) {
        room.witchKill = false;
        room._witchPoisonTarget = candidates[Math.floor(Math.random() * candidates.length)].id;
      }
    }
  } else if (role === 'CUPID' && bot && room.day === 1) {
    // بوت كيوبيد: كيختار زوج عشوائي من لاعبين حيين مختلفين
    const candidates = alivePlayers(room);
    if (candidates.length >= 2) {
      const shuffled = shuffle(candidates);
      const [a, b] = shuffled;
      room.lovers = [a.id, b.id];
      [a, b].forEach(p => { p.lover = true; });
    }
  }
}

function advanceNightStep(room) {
  if (room.nightIndex >= room.nightQueue.length) {
    resolveNight(room);
    return;
  }
  const role = room.nightQueue[room.nightIndex];
  const holders = alivePlayers(room).filter(p => p.role === role || (role === 'WEREWOLF' && roleInfo(p.role).wolf));
  const humanHolders = holders.filter(p => !p.isBot);
  const botHolders = holders.filter(p => p.isBot);

  botHolders.forEach(bot => botAutoNightAction(room, bot, role));
  if (role === 'WEREWOLF' && botHolders.length) scheduleWolfChat(room);

  if (humanHolders.length === 0) {
    room.nightIndex++;
    advanceNightStep(room);
    return;
  }

  humanHolders.forEach(p => {
    if (role === 'WEREWOLF') {
      const targets = villagersOf(room).map(publicPlayer);
      io.to(p.id).emit('night:action', { type: 'wolf_kill', targets });
    } else if (role === 'SEER') {
      const targets = alivePlayers(room).filter(x => x.id !== p.id).map(publicPlayer);
      io.to(p.id).emit('night:action', { type: 'seer_check', targets });
    } else if (role === 'WITCH') {
      const dead = room.nightKillTarget ? room.players.find(x => x.id === room.nightKillTarget) : null;
      io.to(p.id).emit('night:action', {
        type: 'witch',
        killTarget: dead ? publicPlayer(dead) : null,
        canHeal: room.witchHeal && !!room.nightKillTarget,
        canKill: room.witchKill,
        killTargets: alivePlayers(room).filter(x => x.id !== p.id).map(publicPlayer),
      });
    } else if (role === 'BODYGUARD') {
      const targets = alivePlayers(room).map(publicPlayer);
      io.to(p.id).emit('night:action', { type: 'bodyguard', targets });
    } else if (role === 'CUPID') {
      const targets = alivePlayers(room).map(publicPlayer);
      io.to(p.id).emit('night:action', { type: 'cupid', targets });
    } else if (role === 'PLAGUE_DR') {
      const targets = alivePlayers(room).filter(x => x.id !== p.id).map(publicPlayer);
      io.to(p.id).emit('night:action', { type: 'plague_dr', targets });
    }
  });

  room._pendingRole = role;
  room._pendingHumans = new Set(humanHolders.map(p => p.id));
}

function resolveNight(room) {
  const events = [];
  const wolfTarget = room.nightKillTarget;
  let anyDeath = false;

  if (wolfTarget) {
    let blocked = false;
    if (room.guardedId === wolfTarget) { blocked = true; events.push('🛡️ الحارس أنقذ ضحية الذئاب الليلة!'); }
    if (room.witchHealUsedOnTarget === wolfTarget) blocked = true;
    const target = room.players.find(p => p.id === wolfTarget);
    if (target && target.alive && !blocked) {
      if (target.role === 'ELDER' && !target._elderHitOnce) {
        target._elderHitOnce = true;
        events.push(`👴 ${target.name} (شيخ القرية) صمد أمام هجوم الذئاب!`);
      } else {
        target.alive = false;
        anyDeath = true;
        events.push(`💀 وُجد ${target.name} (${roleInfo(target.role).name}) ميتاً عند الفجر!`);
        killLoverIfNeeded(room, target, events);
        if (target.role === 'HUNTER') notifyHunter(room, target);
      }
    }
  }

  if (room._witchPoisonTarget) {
    const t = room.players.find(p => p.id === room._witchPoisonTarget);
    if (t && t.alive) {
      t.alive = false;
      anyDeath = true;
      events.push(`☠️ الساحرة سمّت ${t.name}!`);
      killLoverIfNeeded(room, t, events);
      if (t.role === 'HUNTER') notifyHunter(room, t);
    }
    room._witchPoisonTarget = null;
  }

  if (!events.length) events.push('🌙 ليلة هادئة، لم يمت أحد.');

  room.nightEvents = events;
  room._justDied = anyDeath;
  io.to(room.code).emit('phase:dawn', { events, day: room.day });

  const win = checkWin(room);
  broadcastRoom(room);
  if (win) { endGame(room, win); return; }

  addTimer(room, () => startDay(room), 4000);
}

function killLoverIfNeeded(room, deadPlayer, events) {
  if (!room.lovers) return;
  if (!room.lovers.includes(deadPlayer.id)) return;
  const otherId = room.lovers.find(id => id !== deadPlayer.id);
  const other = room.players.find(p => p.id === otherId);
  if (other && other.alive) {
    other.alive = false;
    events.push(`💔 ${other.name} مات حزناً على حبيبه!`);
  }
}

function notifyHunter(room, hunter) {
  if (hunter.isBot) return;
  const targets = alivePlayers(room).filter(p => p.id !== hunter.id).map(publicPlayer);
  if (targets.length) io.to(hunter.id).emit('hunter:shot', { targets });
}

function startDay(room) {
  room.phase = 'day';
  room.players.forEach(p => { p.votedFor = null; });
  io.to(room.code).emit('phase:day', { day: room.day });
  broadcastRoom(room);
  scheduleDayChat(room);
  addTimer(room, () => openVote(room), 45000);
}

function openVote(room) {
  if (room.state !== 'playing') return;
  const candidates = alivePlayers(room).map(publicPlayer);
  alivePlayers(room).filter(p => !p.isBot).forEach(p => {
    io.to(p.id).emit('vote:open', { candidates: candidates.filter(c => c.id !== p.id) });
  });
  // بوتات كيصوتو — كيفضلو الهدف اللي جمع شكوك أكثر (نفس المنطق ديال pickTarget)
  alivePlayers(room).filter(p => p.isBot).forEach(p => {
    const target = pickTarget(room, p, false);
    if (target) p.votedFor = target.id;
  });
  checkVotesComplete(room);
}

function checkVotesComplete(room) {
  const alive = alivePlayers(room);
  const voted = alive.filter(p => p.votedFor);
  io.to(room.code).emit('vote:update', { count: voted.length, total: alive.length });
  if (voted.length < alive.length) return;

  const tally = {};
  voted.forEach(p => { tally[p.votedFor] = (tally[p.votedFor] || 0) + 1; });
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  io.to(room.code).emit('vote:result', { tally });
  if (!sorted.length) { addTimer(room, () => startNight2(room), 2000); return; }

  const [condemnedId] = sorted[0];
  const condemned = room.players.find(p => p.id === condemnedId);
  if (condemned && condemned.alive) {
    condemned.alive = false;
    room._suspicion && room._suspicion.delete(condemned.id);
    io.to(room.code).emit('vote:condemned', { player: { ...publicPlayer(condemned), roleInfo: roleInfo(condemned.role) } });
    if (condemned.role === 'HUNTER') notifyHunter(room, condemned);
    const evts = [];
    killLoverIfNeeded(room, condemned, evts);
    if (evts.length) io.to(room.code).emit('phase:dawn', { events: evts, day: room.day });
  }
  broadcastRoom(room);
  const win = checkWin(room);
  if (win) { endGame(room, win); return; }
  addTimer(room, () => startNight2(room), 3000);
}

function startNight2(room) {
  room.day++;
  startNight(room);
}

function checkWin(room) {
  const wolves = wolvesOf(room);
  const villagers = villagersOf(room);
  if (!wolves.length) return 'village';
  if (wolves.length >= villagers.length) return 'wolves';
  return null;
}

function endGame(room, winner) {
  room.state = 'ended';
  clearRoomTimers(room);
  io.to(room.code).emit('game:end', {
    winner,
    players: room.players.map(p => ({ ...publicPlayer(p), role: p.role, roleInfo: roleInfo(p.role) })),
  });
}

/* ------------------------------------------------------------
   يعالج مغادرة لاعب فالنص لعبة: بلا هادشي كانت الليلة/التصويت
   يقدر يوقف بلا ما يكمل (خاصة إذا كان هو اللي خاصو يدير أكشن)
   ------------------------------------------------------------ */
function handlePlayerRemovedDuringGame(room, leftPlayerId) {
  if (room.state !== 'playing') return;

  if (room.phase === 'night' && room._pendingHumans && room._pendingHumans.has(leftPlayerId)) {
    room._pendingHumans.delete(leftPlayerId);
    if (room._pendingHumans.size === 0) {
      room.nightIndex++;
      advanceNightStep(room);
    }
    return;
  }

  if (room.phase === 'day') {
    checkVotesComplete(room);
  }

  const win = checkWin(room);
  if (win) endGame(room, win);
}

/* ------------------------------------------------------------
   Socket handlers
   ------------------------------------------------------------ */
io.on('connection', (socket) => {
  const ip = getClientIP(socket);
  if (isBannedIP(ip)) {
    socket.emit('room:error', 'أنت محظور من هاد اللعبة');
    socket.disconnect(true);
    return;
  }

  console.log(`✅ متصل: ${socket.id} (${ip})`);

  socket.on('room:create', ({ playerName }) => {
    const room = newRoom(socket.id);
    room.players.push({
      id: socket.id, name: (playerName || 'مضيف').slice(0, 20), avatar: '🧑',
      role: null, alive: true, votedFor: null, isBot: false, lover: false,
    });
    rooms.set(room.code, room);
    socket.join(room.code);
    socket.emit('room:created', { code: room.code });
    broadcastRoom(room);
  });

  socket.on('room:join', ({ code, playerName }) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) { socket.emit('room:error', 'الغرفة غير موجودة'); return; }
    if (room.state !== 'lobby') { socket.emit('room:error', 'اللعبة بدأت بالفعل'); return; }
    if (room.players.length >= MAX_PLAYERS) { socket.emit('room:error', 'الغرفة ممتلئة'); return; }
    room.players.push({
      id: socket.id, name: (playerName || 'لاعب').slice(0, 20), avatar: '🧑',
      role: null, alive: true, votedFor: null, isBot: false, lover: false,
    });
    socket.join(room.code);
    socket.emit('room:joined', { code: room.code });
    broadcastRoom(room);
  });

  socket.on('game:start', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;
    if (room.state !== 'lobby') return;
    if (room.players.filter(p => !p.isBot).length < 2) {
      socket.emit('room:error', 'خاصك لاعب آخر واحد على الأقل باش تبدا');
      return;
    }
    addBotsToRoom(room);
    if (room.players.length < MIN_PLAYERS) {
      socket.emit('room:error', `خاص ${MIN_PLAYERS} لاعبين على الأقل`);
      return;
    }
    assignRoles(room);
    room.state = 'playing';
    room.day = 1;
    room.lovers = null;
    room._suspicion = new Map();
    broadcastRoom(room);
    sendRolesToPlayers(room);
    addTimer(room, () => startNight(room), 5000);
  });

  socket.on('night:submit', (data) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.state !== 'playing' || room.phase !== 'night') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.alive) return;
    const role = room._pendingRole;
    if (!role) return;

    if (data.type === 'wolf_kill' && roleInfo(player.role).wolf) {
      if (data.targetId) room.nightKillTarget = data.targetId;
    } else if (data.type === 'seer_check' && player.role === 'SEER') {
      const t = room.players.find(x => x.id === data.targetId);
      if (t) socket.emit('seer:result', { targetName: t.name, role: t.role, roleInfo: roleInfo(t.role) });
    } else if (data.type === 'witch' && player.role === 'WITCH') {
      if (data.heal && room.witchHeal && room.nightKillTarget) {
        room.witchHeal = false;
        room.witchHealUsedOnTarget = room.nightKillTarget;
        room.nightKillTarget = null;
      } else if (data.killTargetId && room.witchKill) {
        room.witchKill = false;
        room._witchPoisonTarget = data.killTargetId;
      }
    } else if (data.type === 'bodyguard' && player.role === 'BODYGUARD') {
      room.guardedId = data.targetId || null;
    } else if (data.type === 'cupid' && player.role === 'CUPID') {
      if (data.lover1 && data.lover2) {
        room.lovers = [data.lover1, data.lover2];
        [data.lover1, data.lover2].forEach(id => {
          const p = room.players.find(x => x.id === id);
          if (p) p.lover = true;
        });
      }
    } else if (data.type === 'plague_dr' && player.role === 'PLAGUE_DR') {
      room.plagueSickId = data.targetId || null;
    }

    if (room._pendingHumans) {
      room._pendingHumans.delete(socket.id);
      if (room._pendingHumans.size === 0) {
        room.nightIndex++;
        advanceNightStep(room);
      }
    }
  });

  socket.on('vote:submit', ({ targetId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.state !== 'playing' || room.phase !== 'day') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.alive) return;
    player.votedFor = targetId || null;
    checkVotesComplete(room);
  });

  socket.on('hunter:submit', ({ targetId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const t = room.players.find(p => p.id === targetId);
    if (!t || !t.alive) return;
    t.alive = false;
    const evts = [`🏹 الصيّاد أطلق سهمه على ${t.name}!`];
    killLoverIfNeeded(room, t, evts);
    io.to(room.code).emit('phase:dawn', { events: evts, day: room.day });
    broadcastRoom(room);
    const win = checkWin(room);
    if (win) endGame(room, win);
  });

  // ---------------- الشات: بشر + بوتات كيتفاعلو ----------------
  socket.on('chat:send', ({ text }) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.alive) return;
    if (!text || !String(text).trim()) return;
    const cleanText = String(text).slice(0, 300);
    const isWolfChat = room.phase === 'night' && roleInfo(player.role).wolf;
    const msg = { sender: player.name, avatar: player.avatar, text: cleanText, isWolfOnly: isWolfChat, isBot: false };
    if (isWolfChat) {
      wolvesOf(room).filter(w => !w.isBot).forEach(w => io.to(w.id).emit('chat:message', msg));
    } else {
      io.to(room.code).emit('chat:message', msg);
      // 🤖 إذا شي بوت تسمى فالرسالة، كيرد يدافع عن راسو بعد شوية
      alivePlayers(room).filter(p => p.isBot).forEach(bot => {
        if (cleanText.includes(bot.name)) {
          bumpSuspicion(room, bot.id);
          scheduleBotDefense(room, bot);
        }
      });
    }
  });

  /* ---------------- Creator auth & tools ---------------- */

  socket.on('creator:auth', (code) => {
    if (!CREATOR_SECRET) {
      socket.emit('creator:error', 'ميزة المطور غير مفعّلة على هاد السيرفر');
      return;
    }
    if (isCreatorAuthBlocked(ip)) {
      socket.emit('creator:error', 'محاولات كثيرة، عاود حاول من بعد شوية');
      return;
    }
    if (typeof code === 'string' && safeCompareSecret(code)) {
      clearCreatorAuthAttempts(ip);
      creatorSockets.add(socket.id);
      const room = findRoomBySocket(socket.id);
      socket.emit('creator:ok', { name: 'Alaa Dev' });
      console.log(`👑 Creator authenticated: ${socket.id}`);
      if (room) broadcastRoom(room);
    } else {
      registerFailedCreatorAuth(ip);
      socket.emit('creator:error', 'الكود غير صحيح');
    }
  });

  socket.on('creator:addBots', ({ count }) => {
    requireCreator(socket, () => {
      const room = findRoomBySocket(socket.id);
      if (!room) return;
      const room_cap = Math.max(0, MAX_PLAYERS - room.players.length);
      const n = Math.max(0, Math.min(parseInt(count, 10) || 1, room_cap));
      const usedNames = new Set(room.players.map(p => p.name));
      const usedAvatars = new Set(room.players.map(p => p.avatar));
      for (let i = 0; i < n; i++) {
        const name = BOT_NAMES.find(nm => !usedNames.has(nm)) || `بوت ${Date.now()}${i}`;
        usedNames.add(name);
        const avatar = BOT_AVATARS.find(a => !usedAvatars.has(a)) || '🤖';
        usedAvatars.add(avatar);
        room.players.push({ id: makeId('bot'), name, avatar, role: 'VILLAGER', alive: true, votedFor: null, isBot: true, lover: false });
      }
      broadcastRoom(room);
    });
  });

  socket.on('creator:kick', (targetId) => {
    requireCreator(socket, () => {
      const room = findRoomBySocket(socket.id);
      if (!room) return;
      const idx = room.players.findIndex(p => p.id === targetId);
      if (idx === -1) return;
      io.to(targetId).emit('room:error', 'تم طردك من قِبل المطور');
      room.players.splice(idx, 1);
      handlePlayerRemovedDuringGame(room, targetId);
      if (room.players.length === 0) { rooms.delete(room.code); return; }
      broadcastRoom(room);
    });
  });

  // حظر: type = 'session' (يقدر يرجع يدخل من بعد) أو 'permanent' (حتى يتعاود تشغيل السيرفر)
  socket.on('creator:ban', ({ targetId, type }) => {
    requireCreator(socket, () => {
      const room = findRoomBySocket(socket.id);
      if (!room) return;
      const idx = room.players.findIndex(p => p.id === targetId);
      if (idx === -1) return;
      const targetSocket = io.sockets.sockets.get(targetId);
      const targetIP = targetSocket ? getClientIP(targetSocket) : null;
      if (targetIP) {
        if (type === 'permanent') permBannedIPs.add(targetIP);
        else sessionBannedIPs.add(targetIP);
      }
      io.to(targetId).emit('room:error', type === 'permanent' ? 'تم حظرك بشكل دائم' : 'تم حظرك من قِبل المطور');
      if (targetSocket) targetSocket.disconnect(true);
      room.players.splice(idx, 1);
      handlePlayerRemovedDuringGame(room, targetId);
      if (room.players.length === 0) { rooms.delete(room.code); return; }
      broadcastRoom(room);
    });
  });

  socket.on('creator:unban', (ip) => {
    requireCreator(socket, () => {
      permBannedIPs.delete(ip);
      sessionBannedIPs.delete(ip);
      socket.emit('creator:banList', { permanent: [...permBannedIPs], session: [...sessionBannedIPs] });
    });
  });

  socket.on('creator:getBanList', () => {
    requireCreator(socket, () => {
      socket.emit('creator:banList', { permanent: [...permBannedIPs], session: [...sessionBannedIPs] });
    });
  });

  socket.on('creator:setRole', ({ targetId, role }) => {
    requireCreator(socket, () => {
      const room = findRoomBySocket(socket.id);
      if (!room || !ROLES_INFO[role]) return;
      const p = room.players.find(x => x.id === targetId);
      if (!p) return;
      p.role = role;
      if (!p.isBot) io.to(p.id).emit('game:role', { role: p.role, roleInfo: roleInfo(p.role), wolfMates: [] });
      broadcastRoom(room);
    });
  });

  socket.on('creator:setPhase', (phase) => {
    requireCreator(socket, () => {
      const room = findRoomBySocket(socket.id);
      if (!room) return;
      if (phase === 'night') startNight(room);
      else if (phase === 'day') startDay(room);
    });
  });

  socket.on('creator:forceEnd', (winner) => {
    requireCreator(socket, () => {
      const room = findRoomBySocket(socket.id);
      if (!room) return;
      endGame(room, winner === 'wolves' ? 'wolves' : 'village');
    });
  });

  socket.on('creator:restart', () => {
    requireCreator(socket, () => {
      const room = findRoomBySocket(socket.id);
      if (!room) return;
      clearRoomTimers(room);
      room.state = 'lobby'; room.phase = 'night'; room.day = 1;
      room._suspicion = new Map();
      room._justDied = false;
      room.players.forEach(p => { p.role = null; p.alive = true; p.votedFor = null; p.lover = false; });
      broadcastRoom(room);
    });
  });

  socket.on('disconnect', () => {
    creatorSockets.delete(socket.id);
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;
    const left = room.players[idx];
    room.players.splice(idx, 1);
    console.log(`❌ ${left.name} غادر الغرفة ${room.code}`);
    if (room.players.length === 0) {
      clearRoomTimers(room);
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id;
    }
    handlePlayerRemovedDuringGame(room, socket.id);
    if (rooms.has(room.code)) broadcastRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`🐺 السيرفر شغّال: http://localhost:${PORT}`));
