const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(__dirname));

// ══════════════════════════════════════
//  الأدوار
// ══════════════════════════════════════
const ROLES = {
  VILLAGER:  { name:'فلاح',         emoji:'🧑‍🌾', color:'#2ecc71', desc:'يصوّت نهارًا فقط',       wolf:false },
  WEREWOLF:  { name:'مستذئب',       emoji:'🐺',   color:'#e74c3c', desc:'يقتل كل ليلة',           wolf:true  },
  ALPHA_WOLF:{ name:'ذئب ألفا',     emoji:'🔥🐺', color:'#ff4444', desc:'الذئب الأقوى',           wolf:true  },
  SEER:      { name:'عرّافة',       emoji:'🔮',   color:'#9b59b6', desc:'ترى هوية لاعب كل ليلة',  wolf:false },
  WITCH:     { name:'ساحرة',        emoji:'🧙',   color:'#1abc9c', desc:'ترياق + سم مرة واحدة',   wolf:false },
  HUNTER:    { name:'صيّاد',        emoji:'🏹',   color:'#f1c40f', desc:'سهم أخير عند الموت',     wolf:false },
  BODYGUARD: { name:'حارس',         emoji:'🛡️',  color:'#3498db', desc:'يحمي لاعبًا كل ليلة',    wolf:false },
  CUPID:     { name:'كيوبيد',       emoji:'💘',   color:'#e91e63', desc:'يربط عاشقَين',           wolf:false },
  ELDER:     { name:'شيخ القرية',   emoji:'👴',   color:'#a0522d', desc:'يتحمل ضربة من الذئاب',   wolf:false },
  FOOL:      { name:'المجنون',      emoji:'🃏',   color:'#00bcd4', desc:'يفوز إن أُعدم نهارًا',   wolf:false },
  PLAGUE_DR: { name:'طبيب الطاعون', emoji:'⚗️',  color:'#7f8c8d', desc:'يمرّض لاعبًا',           wolf:false },
  THIEF:     { name:'اللص',         emoji:'🥷',   color:'#e67e22', desc:'يسرق دور لاعب آخر',      wolf:false },
};

const BASE_ROLES = {
  4:  ['WEREWOLF','SEER','WITCH','VILLAGER'],
  5:  ['WEREWOLF','SEER','WITCH','HUNTER','VILLAGER'],
  6:  ['WEREWOLF','WEREWOLF','SEER','WITCH','ELDER','VILLAGER'],
  7:  ['WEREWOLF','WEREWOLF','SEER','WITCH','HUNTER','ELDER','VILLAGER'],
  8:  ['WEREWOLF','WEREWOLF','SEER','WITCH','HUNTER','BODYGUARD','CUPID','VILLAGER'],
  9:  ['WEREWOLF','WEREWOLF','ALPHA_WOLF','SEER','WITCH','HUNTER','BODYGUARD','CUPID','VILLAGER'],
  10: ['WEREWOLF','WEREWOLF','ALPHA_WOLF','SEER','WITCH','HUNTER','BODYGUARD','CUPID','FOOL','VILLAGER'],
  11: ['WEREWOLF','WEREWOLF','ALPHA_WOLF','SEER','WITCH','HUNTER','BODYGUARD','CUPID','FOOL','THIEF','VILLAGER'],
  12: ['WEREWOLF','WEREWOLF','ALPHA_WOLF','SEER','WITCH','HUNTER','BODYGUARD','CUPID','FOOL','THIEF','ELDER','PLAGUE_DR'],
};

function rolesForCount(n) {
  if (n <= 4) return BASE_ROLES[4];
  if (n >= 12) {
    const roles = [...BASE_ROLES[12]];
    while (roles.length < n) roles.push('VILLAGER');
    return roles;
  }
  return BASE_ROLES[n];
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const AVATARS = ['🧑','👩','🧔','👨‍🦰','👩‍🦰','🧑‍🦱','👨‍🦳','👩‍🦳','🧑‍🦲','👨‍🎓','👩‍🎓','🧑‍🌾'];

// ══════════════════════════════════════
//  مكافحة السبام
// ══════════════════════════════════════
const RATE_LIMIT_WINDOW_MS = 4000;
const RATE_LIMIT_MAX_EVENTS = 15;
const WARN_THRESHOLD = 2;
const socketMeta = new Map();

function getMeta(socketId) {
  if (!socketMeta.has(socketId)) socketMeta.set(socketId, { events: [], warnings: 0 });
  return socketMeta.get(socketId);
}

function checkRateLimit(socket, eventName) {
  const meta = getMeta(socket.id);
  const now = Date.now();
  meta.events = meta.events.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  meta.events.push(now);

  if (meta.events.length > RATE_LIMIT_MAX_EVENTS) {
    meta.warnings++;
    meta.events = [];
    console.log(`⚠️ سبام مرصود من ${socket.id} (${eventName}) — تحذير رقم ${meta.warnings}`);
    if (meta.warnings >= WARN_THRESHOLD) {
      socket.emit('room:error', 'يبدو انك قمت بمخالفة سياسات الأحكام مرة أخرى. تم طردك بسبب رسائل سريعة جداً.');
      const room = findRoomBySocket(socket.id);
      if (room) removePlayerFromRoom(room, socket.id, true);
      socket.disconnect(true);
      return false;
    }
    socket.emit('room:error', `رسائلك سريعة جداً. سيتم طردك إذا تكررت. (${meta.warnings}/${WARN_THRESHOLD})`);
    return false;
  }
  return true;
}

// ══════════════════════════════════════
//  فلترة الدردشة
// ══════════════════════════════════════
const SOCIAL_PLATFORM_WORDS = [
  'instagram','insta','ig','facebook','fb','whatsapp','wa','wsp','telegram','tg','tele',
  'snapchat','snap','tiktok','tik tok','twitter','x','discord','disc','dc',
  'messenger','msngr','youtube','yt','linkedin','wechat','line','viber','skype',
  'signal','imo','kik','reddit','pinterest','threads',
  'انستغرام','انستقرام','انستجرام','انستا','انستاجرام',
  'فيسبوك','فايسبوك','فيس بوك','فيس',
  'واتساب','واتس اب','واتسأب','وتساب',
  'تيليجرام','تليجرام','تيلجرام','تلغرام',
  'سناب شات','سناب',
  'تيك توك','تكتوك','تيكتوك',
  'ديسكورد','ديسكرد','ديس',
  'ماسنجر','مسنجر',
  'سكايب','فايبر','سيجنال','ثريدز','ريديت',
  'انستا','سناپ','واتس','تيلي','ديسكورت',
  'دسكراد','دسكرادود','دوسكرا','ديسكرادود','دساكر',
  'دوس','دوسرا','دورادوس','ديسوداد','ديس ديس'
];

const BAD_WORDS = [];
function filterProfanity(text) {
  let cleaned = text;
  BAD_WORDS.forEach(w => {
    if (!w) return;
    cleaned = cleaned.replace(new RegExp(w, 'gi'), '*'.repeat(w.length));
  });
  return cleaned;
}

function normalizeForFilter(text) {
  return text.toLowerCase().replace(/[\s\-_.*()\[\]{}|\\/+~`^!@#$%&=:;'"،,؛]+/g, '');
}

function containsExternalContact(text) {
  const normalized = normalizeForFilter(text);
  const linkPatterns = [/https?:\/\//i, /www\./i, /\.(com|net|org|me|ly|gg)\b/i];
  if (linkPatterns.some(p => p.test(text))) return true;
  if (SOCIAL_PLATFORM_WORDS.some(w => normalized.includes(w.toLowerCase()))) return true;
  if (/@[a-zA-Z0-9_]{3,}/.test(text)) return true;
  if (/\d{7,}/.test(normalized)) return true;
  return false;
}

// ══════════════════════════════════════
//  الغرف
// ══════════════════════════════════════
const rooms = new Map(); // code -> room

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function newRoom(code, hostId) {
  return {
    code,
    host: hostId,
    state: 'lobby', // lobby | playing | ended
    phase: 'night',
    day: 1,
    players: [], // { id, name, avatar, role, alive, protected, sick, lover, elderLives, votedFor }
    nightKill: null,        // wolf target id
    nightGuard: null,       // bodyguard target id
    witchHeal: true,
    witchKill: true,
    witchSaved: false,      // did witch heal tonight
    witchPoisonTarget: null,
    seerDone: false,
    guardDone: false,
    wolfDone: false,
    witchDone: false,
    cupidDone: false,
    plagueDone: false,
    plagueTarget: null,
    nightEvents: [],
    votingOpen: false,
    voteTimeout: null,
  };
}

function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.some(p => p.id === socketId)) return room;
  }
  return null;
}

function roomPublicState(room) {
  return {
    code: room.code,
    host: room.host,
    state: room.state,
    phase: room.phase,
    day: room.day,
    players: room.players.map(p => ({
      id: p.id, name: p.name, avatar: p.avatar, alive: p.alive,
    })),
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room:update', roomPublicState(room));
}

function alivePlayers(room) { return room.players.filter(p => p.alive); }
function aliveWolves(room) { return alivePlayers(room).filter(p => ROLES[p.role].wolf); }
function aliveVillageSide(room) { return alivePlayers(room).filter(p => !ROLES[p.role].wolf); }

function playerPublic(p) {
  return { id: p.id, name: p.name, avatar: p.avatar };
}

function playerFull(p) {
  return { id: p.id, name: p.name, avatar: p.avatar, role: p.role, alive: p.alive };
}

function checkWin(room) {
  const wolves = aliveWolves(room);
  const villagers = aliveVillageSide(room);
  if (!wolves.length) return 'village';
  if (wolves.length >= villagers.length) return 'wolves';
  return null;
}

function endGame(room, winner) {
  room.state = 'ended';
  room.phase = 'end';
  io.to(room.code).emit('game:end', {
    winner,
    players: room.players.map(playerFull),
  });
}

function removePlayerFromRoom(room, socketId, silent) {
  const idx = room.players.findIndex(p => p.id === socketId);
  if (idx === -1) return;
  const [left] = room.players.splice(idx, 1);
  const sock = io.sockets.sockets.get(socketId);
  if (sock) sock.leave(room.code);

  if (room.players.length === 0) {
    if (room.voteTimeout) clearTimeout(room.voteTimeout);
    rooms.delete(room.code);
    return;
  }
  if (room.host === socketId) {
    room.host = room.players[0].id;
  }
  if (!silent) {
    io.to(room.code).emit('chat:message', {
      sender: 'النظام', avatar: '📢', text: `${left.name} غادر اللعبة`, system: true,
    });
  }
  if (room.state === 'playing') {
    const win = checkWin(room);
    if (win) { endGame(room, win); return; }
  }
  broadcastRoom(room);
}

// ══════════════════════════════════════
//  تدفق اللعبة
// ══════════════════════════════════════
function startGame(room) {
  const n = room.players.length;
  let roles = shuffle(rolesForCount(n)).slice(0, n);
  while (roles.length < n) roles.push('VILLAGER');
  roles = shuffle(roles);

  room.players.forEach((p, i) => {
    p.role = roles[i];
    p.alive = true;
    p.protected = false;
    p.sick = false;
    p.lover = null;
    p.elderLives = 1;
    p.votedFor = null;
  });

  room.state = 'playing';
  room.day = 1;
  room.phase = 'night';

  room.players.forEach(p => {
    const wolfMates = ROLES[p.role].wolf
      ? room.players.filter(x => ROLES[x.role].wolf && x.id !== p.id).map(x => x.name)
      : [];
    io.to(p.id).emit('game:role', { role: p.role, roleInfo: ROLES[p.role], wolfMates });
  });

  broadcastRoom(room);
  setTimeout(() => { if (room.state === 'playing') startNight(room); }, 4000);
}

function startNight(room) {
  room.phase = 'night';
  room.nightKill = null;
  room.nightGuard = null;
  room.witchSaved = false;
  room.witchPoisonTarget = null;
  room.seerDone = false;
  room.guardDone = false;
  room.wolfDone = false;
  room.witchDone = false;
  room.cupidDone = false;
  room.plagueDone = false;
  room.plagueTarget = null;
  room.nightEvents = [];
  room.players.forEach(p => { p.protected = false; });

  io.to(room.code).emit('phase:night', { day: room.day });

  // ترتيب النداءات الليلية
  requestCupid(room, () => {
    requestBodyguard(room, () => {
      requestSeer(room, () => {
        requestWolves(room, () => {
          requestWitch(room, () => {
            requestPlagueDoctor(room, () => {
              resolveNight(room);
            });
          });
        });
      });
    });
  });
}

function requestCupid(room, next) {
  if (room.day !== 1) return next();
  const cupid = alivePlayers(room).find(p => p.role === 'CUPID');
  if (!cupid) return next();
  const targets = alivePlayers(room).map(playerPublic);
  io.to(cupid.id).emit('night:action', { type: 'cupid', targets });
  room._cupidNext = next;
  room._cupidRoom = room;
  waitForAction(room, cupid.id, 'cupid', 25000, next);
}

function requestBodyguard(room, next) {
  const bg = alivePlayers(room).find(p => p.role === 'BODYGUARD');
  if (!bg) return next();
  const targets = alivePlayers(room).map(playerPublic);
  io.to(bg.id).emit('night:action', { type: 'bodyguard', targets });
  waitForAction(room, bg.id, 'bodyguard', 20000, next);
}

function requestSeer(room, next) {
  const seer = alivePlayers(room).find(p => p.role === 'SEER');
  if (!seer) return next();
  const targets = alivePlayers(room).filter(p => p.id !== seer.id).map(playerPublic);
  io.to(seer.id).emit('night:action', { type: 'seer_check', targets });
  waitForAction(room, seer.id, 'seer_check', 20000, next);
}

function requestWolves(room, next) {
  const wolves = aliveWolves(room);
  if (!wolves.length) return next();
  const targets = alivePlayers(room).filter(p => !ROLES[p.role].wolf).map(playerPublic);
  wolves.forEach(w => io.to(w.id).emit('night:action', { type: 'wolf_kill', targets }));
  waitForGroupAction(room, wolves.map(w => w.id), 'wolf_kill', 25000, next);
}

function requestWitch(room, next) {
  const witch = alivePlayers(room).find(p => p.role === 'WITCH');
  if (!witch) return next();
  const killTarget = room.nightKill ? room.players.find(p => p.id === room.nightKill) : null;
  const killTargets = alivePlayers(room).filter(p => p.id !== witch.id).map(playerPublic);
  io.to(witch.id).emit('night:action', {
    type: 'witch',
    killTarget: killTarget ? playerPublic(killTarget) : null,
    canHeal: room.witchHeal && !!room.nightKill,
    canKill: room.witchKill,
    killTargets,
  });
  waitForAction(room, witch.id, 'witch', 25000, next);
}

function requestPlagueDoctor(room, next) {
  const dr = alivePlayers(room).find(p => p.role === 'PLAGUE_DR');
  if (!dr) return next();
  const targets = alivePlayers(room).filter(p => p.id !== dr.id).map(playerPublic);
  io.to(dr.id).emit('night:action', { type: 'plague_dr', targets });
  waitForAction(room, dr.id, 'plague_dr', 20000, next);
}

// ── انتظار أفعال الليل ──
const pendingActions = new Map(); // socketId -> { type, resolve }

function waitForAction(room, socketId, type, timeoutMs, next) {
  let resolved = false;
  const timer = setTimeout(() => {
    if (resolved) return;
    resolved = true;
    pendingActions.delete(socketId);
    next();
  }, timeoutMs);

  pendingActions.set(socketId, {
    type,
    room,
    resolve: () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      pendingActions.delete(socketId);
      next();
    },
  });
}

function waitForGroupAction(room, socketIds, type, timeoutMs, next) {
  let remaining = new Set(socketIds);
  let resolved = false;
  const finish = () => {
    if (resolved) return;
    resolved = true;
    clearTimeout(timer);
    socketIds.forEach(id => pendingActions.delete(id));
    next();
  };
  const timer = setTimeout(finish, timeoutMs);

  socketIds.forEach(id => {
    pendingActions.set(id, {
      type,
      room,
      resolve: () => {
        remaining.delete(id);
        pendingActions.delete(id);
        if (remaining.size === 0) finish();
      },
    });
  });
}

function killPlayer(room, player, reason) {
  if (!player || !player.alive) return;
  if (player.role === 'ELDER' && player.elderLives > 0) {
    player.elderLives--;
    room.nightEvents.push(`🛡️ ${player.name} نجا من الهجوم (شيخ القرية)!`);
    return;
  }
  player.alive = false;
  room.nightEvents.push(`💀 ${player.name} (${ROLES[player.role].name}) وُجد ميتاً — ${reason}`);
  io.to(player.id).emit('player:died', { reason });

  if (player.lover) {
    const lover = room.players.find(p => p.id === player.lover);
    if (lover && lover.alive) {
      lover.alive = false;
      room.nightEvents.push(`💔 ${lover.name} مات حزناً على حبيبه!`);
      io.to(lover.id).emit('player:died', { reason: 'مات حزناً على حبيبه' });
    }
  }

  if (player.role === 'HUNTER') {
    triggerHunterShot(room, player);
  }
}

function triggerHunterShot(room, hunter) {
  const targets = alivePlayers(room).filter(p => p.id !== hunter.id).map(playerPublic);
  if (!targets.length) return;
  io.to(hunter.id).emit('hunter:shot', { targets });
  waitForAction(room, hunter.id, 'hunter_shot', 20000, () => {});
}

function resolveNight(room) {
  // تنفيذ هجوم الذئاب مع الحماية والترياق
  if (room.nightKill) {
    const target = room.players.find(p => p.id === room.nightKill);
    if (target && target.alive) {
      const guarded = target.protected;
      const healed = room.witchSaved;
      if (guarded) {
        room.nightEvents.push(`🛡️ ${target.name} نجا بفضل الحارس!`);
      } else if (healed) {
        room.nightEvents.push(`🧪 الساحرة أنقذت ${target.name} بالترياق!`);
      } else {
        killPlayer(room, target, 'هجوم الذئاب');
      }
    }
  }

  // تنفيذ سم الساحرة
  if (room.witchPoisonTarget) {
    const t = room.players.find(p => p.id === room.witchPoisonTarget);
    if (t && t.alive) killPlayer(room, t, 'سم الساحرة');
  }

  // مرض طبيب الطاعون (يُعدم تلقائياً في الفجر التالي لو لم يُشفَ — هنا نبسّطها كقتل مباشر خفيف الاحتمال)
  if (room.plagueTarget) {
    const t = room.players.find(p => p.id === room.plagueTarget);
    if (t && t.alive) {
      t.sick = true;
      room.nightEvents.push(`⚗️ ${t.name} أُصيب بالطاعون!`);
    }
  }

  room.nightKill = null;
  room.witchPoisonTarget = null;

  const win = checkWin(room);
  if (win) { announceDawn(room, () => endGame(room, win)); return; }

  announceDawn(room, () => startDay(room));
}

function announceDawn(room, next) {
  io.to(room.code).emit('phase:dawn', { events: room.nightEvents, day: room.day });
  setTimeout(next, 6000);
}

function startDay(room) {
  room.phase = 'day';
  room.players.forEach(p => { p.votedFor = null; });
  io.to(room.code).emit('phase:day', { day: room.day });
  broadcastRoom(room);

  setTimeout(() => {
    if (room.state !== 'playing' || room.phase !== 'day') return;
    openVote(room);
  }, 45000);
}

function openVote(room) {
  room.votingOpen = true;
  const candidates = alivePlayers(room).map(playerPublic);
  io.to(room.code).emit('vote:open', { candidates });

  room.voteTimeout = setTimeout(() => tallyVotes(room), 30000);
}

function tallyVotes(room) {
  if (!room.votingOpen) return;
  room.votingOpen = false;
  if (room.voteTimeout) { clearTimeout(room.voteTimeout); room.voteTimeout = null; }

  const alive = alivePlayers(room);
  const tally = {};
  alive.forEach(p => { if (p.votedFor) tally[p.votedFor] = (tally[p.votedFor] || 0) + 1; });

  io.to(room.code).emit('vote:result', { tally });

  const entries = Object.entries(tally);
  if (entries.length) {
    entries.sort((a, b) => b[1] - a[1]);
    const [maxId, maxCount] = entries[0];
    const tiedTop = entries.filter(([, c]) => c === maxCount);
    if (tiedTop.length === 1) {
      const condemned = room.players.find(p => p.id === maxId);
      if (condemned && condemned.alive) {
        const wasFool = condemned.role === 'FOOL';
        killPlayer(room, condemned, 'حُكم عليه بالإعدام');
        io.to(room.code).emit('vote:condemned', { player: playerFull(condemned) });
        if (wasFool) { endGame(room, 'fool'); return; }
      }
    }
  }

  const win = checkWin(room);
  if (win) { endGame(room, win); return; }

  room.day++;
  setTimeout(() => { if (room.state === 'playing') startNight(room); }, 4000);
}

// ══════════════════════════════════════
//  اتصالات Socket.IO
// ══════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`✅ متصل: ${socket.id}`);
  socketMeta.set(socket.id, { events: [], warnings: 0 });

  socket.use((packet, next) => {
    const [eventName] = packet;
    if (checkRateLimit(socket, eventName)) next();
  });

  socket.on('room:create', ({ playerName }) => {
    const name = (playerName || 'مضيف').toString().slice(0, 24).trim() || 'مضيف';
    const code = makeRoomCode();
    const room = newRoom(code, socket.id);
    room.players.push({
      id: socket.id, name, avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
      role: null, alive: true, protected: false, sick: false, lover: null, elderLives: 1, votedFor: null,
    });
    rooms.set(code, room);
    socket.join(code);
    socket.emit('room:created', { code });
    broadcastRoom(room);
  });

  socket.on('room:join', ({ code, playerName }) => {
    code = (code || '').toString().toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) { socket.emit('room:error', 'كود الغرفة غير صحيح'); return; }
    if (room.state !== 'lobby') { socket.emit('room:error', 'اللعبة بدأت بالفعل'); return; }
    if (room.players.length >= 16) { socket.emit('room:error', 'الغرفة ممتلئة'); return; }
    if (room.players.some(p => p.id === socket.id)) return;

    const name = (playerName || 'لاعب').toString().slice(0, 24).trim() || 'لاعب';
    room.players.push({
      id: socket.id, name, avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
      role: null, alive: true, protected: false, sick: false, lover: null, elderLives: 1, votedFor: null,
    });
    socket.join(code);
    socket.emit('room:joined', { code });
    broadcastRoom(room);
  });

  socket.on('game:start', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    if (room.host !== socket.id) { socket.emit('room:error', 'فقط المضيف يمكنه بدء اللعبة'); return; }
    if (room.state !== 'lobby') return;
    if (room.players.length < 5) { socket.emit('room:error', 'يجب 5 لاعبين على الأقل'); return; }
    startGame(room);
  });

  socket.on('night:submit', (data) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.state !== 'playing' || room.phase !== 'night') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.alive) return;

    const pending = pendingActions.get(socket.id);
    if (!pending || pending.room !== room) return;

    switch (data.type) {
      case 'cupid': {
        if (pending.type !== 'cupid') return;
        const p1 = room.players.find(p => p.id === data.lover1);
        const p2 = room.players.find(p => p.id === data.lover2);
        if (p1 && p2 && p1.id !== p2.id) {
          p1.lover = p2.id; p2.lover = p1.id;
          room.nightEvents.push(`💘 كيوبيد ربط ${p1.name} و ${p2.name}!`);
        }
        break;
      }
      case 'bodyguard': {
        if (pending.type !== 'bodyguard') return;
        if (data.targetId) {
          const t = room.players.find(p => p.id === data.targetId);
          if (t) { t.protected = true; room.nightGuard = t.id; }
        }
        break;
      }
      case 'seer_check': {
        if (pending.type !== 'seer_check') return;
        if (data.targetId) {
          const t = room.players.find(p => p.id === data.targetId);
          if (t) {
            socket.emit('seer:result', { targetName: t.name, role: t.role, roleInfo: ROLES[t.role] });
          }
        }
        break;
      }
      case 'wolf_kill': {
        if (pending.type !== 'wolf_kill') return;
        if (data.targetId) room.nightKill = data.targetId;
        break;
      }
      case 'witch': {
        if (pending.type !== 'witch') return;
        if (data.heal && room.witchHeal && room.nightKill) {
          room.witchHeal = false;
          room.witchSaved = true;
          room.nightEvents.push('🧪 الساحرة استخدمت الترياق!');
        } else if (data.killTargetId && room.witchKill) {
          room.witchKill = false;
          room.witchPoisonTarget = data.killTargetId;
        }
        break;
      }
      case 'plague_dr': {
        if (pending.type !== 'plague_dr') return;
        if (data.targetId) room.plagueTarget = data.targetId;
        break;
      }
      default:
        return;
    }
    pending.resolve();
  });

  socket.on('hunter:submit', ({ targetId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const pending = pendingActions.get(socket.id);
    if (!pending || pending.type !== 'hunter_shot' || pending.room !== room) return;
    const target = room.players.find(p => p.id === targetId);
    if (target && target.alive) {
      killPlayer(room, target, 'سهم الصيّاد الأخير');
      const win = checkWin(room);
      if (win) { pending.resolve(); endGame(room, win); return; }
    }
    pending.resolve();
  });

  socket.on('vote:submit', ({ targetId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.state !== 'playing' || room.phase !== 'day' || !room.votingOpen) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.alive) return;
    const target = room.players.find(p => p.id === targetId);
    if (!target || !target.alive) return;

    player.votedFor = targetId;
    const alive = alivePlayers(room);
    const votedCount = alive.filter(p => p.votedFor).length;
    io.to(room.code).emit('vote:update', { count: votedCount, total: alive.length });

    if (votedCount === alive.length) {
      tallyVotes(room);
    }
  });

  socket.on('chat:send', ({ text }) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    if (room.state === 'playing' && !player.alive) return;
    if (typeof text !== 'string' || !text.trim()) return;
    if (text.length > 300) { socket.emit('room:error', 'الرسالة طويلة جداً!'); return; }
    if (containsExternalContact(text)) {
      socket.emit('room:error', 'لا يُسمح بمشاركة روابط أو حسابات تواصل اجتماعي بالدردشة.');
      return;
    }
    text = filterProfanity(text.trim());

    const isWolfChat = room.state === 'playing' && room.phase === 'night' && ROLES[player.role]?.wolf;
    const msg = {
      sender: player.name, avatar: player.avatar, text,
      isWolfOnly: !!isWolfChat, color: isWolfChat ? '#e74c3c' : '#ecf0f1',
    };
    if (isWolfChat) {
      aliveWolves(room).forEach(w => io.to(w.id).emit('chat:message', msg));
    } else {
      io.to(room.code).emit('chat:message', msg);
    }
  });

  socket.on('disconnect', () => {
    socketMeta.delete(socket.id);
    pendingActions.delete(socket.id);
    const room = findRoomBySocket(socket.id);
    if (room) removePlayerFromRoom(room, socket.id, false);
    console.log(`❌ غادر: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`🐺 السيرفر شغّال: http://localhost:${PORT}`));