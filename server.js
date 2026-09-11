/* =========================================================
   Loup Garou — server.js
   يطابق البروتوكول اللي كيستعملو olders.html (room:*, game:*, night:*, vote:*, chat:*)
   + نظام Creator آمن (السر فالسيرفر فقط، عبر متغير بيئة)
   =========================================================- */
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(__dirname));

/* ------------------------------------------------------------
   Creator auth (آمن): السر كيتقارن فالسيرفر فقط.
   ⚠️ هادشي هو السر الحقيقي ديالك، مكتوب هنا كـ fallback باش
   يخدم حتى إلا ماكانتش environment variable معرفة.
   إلا بغيتي تبدلو من متغير بيئة، دير:
     CREATOR_SECRET=IAM-ALAA-DEVOFLOUPPY node server.js
   ------------------------------------------------------------ */
const CREATOR_SECRET = process.env.CREATOR_SECRET || 'IAM-ALAA-DEVOFLOUPPY';
console.log('[creator] CREATOR_SECRET جاهز:', CREATOR_SECRET ? '✅' : '❌ غير معرف!');

/* ------------------------------------------------------------
   Creator device-lock: نظام قفل الكود لأول جهاز ينجح بيه
   ------------------------------------------------------------ */
const fs = require('fs');
const path = require('path');
const STATE_FILE = path.join(__dirname, 'creator-state.json');
const BANS_FILE  = path.join(__dirname, 'permanent-bans.json');

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('فشل الحفظ:', file, e); }
}

// { deviceToken: string|null, name: string|null }
let creatorState = loadJSON(STATE_FILE, { deviceToken: null, name: null });
// [{ id, name, deviceToken, ip, reason, bannedAt }]
let permanentBans = loadJSON(BANS_FILE, []);

// socket.id ديال أي واحد أثبت أنه Creator فهاد الجلسة الحالية
const creatorSockets = new Set();
// مرجع للسوكيت الحالي ديال الكرييتور (باش نبعثو ليه إشعارات الاختراق)
let creatorSocketRef = null;

// IPs محظورة بشكل دائم / مؤقت (session)
const permBannedIPs = new Set(permanentBans.map(b => b.ip).filter(Boolean));
const sessionBannedIPs = new Set();

function getClientIP(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return socket.handshake.address;
}

function isBannedIP(ip) {
  return permBannedIPs.has(ip) || sessionBannedIPs.has(ip);
}

function isPermanentlyBannedDevice({ id, deviceToken, ip }) {
  return permanentBans.some(b =>
    (deviceToken && b.deviceToken === deviceToken) ||
    (ip && b.ip === ip) ||
    (id && b.id === id)
  );
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

const MIN_PLAYERS = 5;
const BOT_NAMES = ['سعيد', 'فاطمة', 'يوسف', 'خديجة', 'رشيد', 'سميرة', 'كريم', 'ليلى', 'عادل', 'نادية', 'حمزة', 'أمينة'];
const BOT_AVATARS = ['🤖', '👽', '🐺', '🦊', '🐻', '🦁', '🐯', '🐸'];

function shuffle(arr) { return arr.map(v => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map(x => x[1]); }
function makeId(prefix) { return prefix + '-' + Math.random().toString(36).slice(2, 10); }
function roleInfo(key) { return ROLES_INFO[key] || ROLES_INFO.VILLAGER; }

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
    plagueSickId: null,
    lovers: null,          // [id1, id2]
    thiefSwapped: false,
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
  return {
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    alive: p.alive,
    isBot: !!p.isBot,
    isCreator: creatorSockets.has(p.id), // ✅ الفرونت كيستعمل هاد العلم باش يبين شارة التوثيق
  };
}

function roomPublicState(room) {
  return {
    code: room.code,
    state: room.state,
    phase: room.phase,
    day: room.day,
    host: room.hostId,
    players: room.players.map(publicPlayer),
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room:update', roomPublicState(room));
}

function addBotsToRoom(room) {
  const humanCount = room.players.filter(p => !p.isBot).length;
  if (humanCount < 2) return;
  const needed = Math.max(0, MIN_PLAYERS - room.players.length);
  const usedNames = new Set(room.players.map(p => p.name));
  const usedAvatars = new Set(room.players.map(p => p.avatar));
  for (let i = 0; i < needed; i++) {
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
  room.players.forEach(p => { p.votedFor = null; });
  room.nightQueue = nightActingOrder(room);
  room.nightIndex = 0;
  room.nightEvents = [];
  io.to(room.code).emit('phase:night', { day: room.day });
  broadcastRoom(room);
  advanceNightStep(room);
}

function botAutoNightAction(room, role) {
  if (role === 'WEREWOLF') {
    const candidates = villagersOf(room);
    if (candidates.length) room.nightKillTarget = candidates[Math.floor(Math.random() * candidates.length)].id;
  } else if (role === 'BODYGUARD') {
    const candidates = alivePlayers(room);
    if (candidates.length) room.guardedId = candidates[Math.floor(Math.random() * candidates.length)].id;
  } else if (role === 'PLAGUE_DR') {
    const candidates = alivePlayers(room);
    if (candidates.length && Math.random() > 0.5) room.plagueSickId = candidates[Math.floor(Math.random() * candidates.length)].id;
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

  botHolders.forEach(() => botAutoNightAction(room, role));

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
      events.push(`☠️ الساحرة سمّت ${t.name}!`);
      killLoverIfNeeded(room, t, events);
      if (t.role === 'HUNTER') notifyHunter(room, t);
    }
    room._witchPoisonTarget = null;
  }

  if (!events.length) events.push('🌙 ليلة هادئة، لم يمت أحد.');

  room.nightEvents = events;
  io.to(room.code).emit('phase:dawn', { events, day: room.day });

  const win = checkWin(room);
  broadcastRoom(room);
  if (win) { endGame(room, win); return; }

  setTimeout(() => startDay(room), 4000);
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
  setTimeout(() => openVote(room), 45000);
}

function openVote(room) {
  if (room.state !== 'playing') return;
  const candidates = alivePlayers(room).map(publicPlayer);
  alivePlayers(room).filter(p => !p.isBot).forEach(p => {
    io.to(p.id).emit('vote:open', { candidates: candidates.filter(c => c.id !== p.id) });
  });
  alivePlayers(room).filter(p => p.isBot).forEach(p => {
    const options = alivePlayers(room).filter(x => x.id !== p.id);
    if (options.length) p.votedFor = options[Math.floor(Math.random() * options.length)].id;
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
  if (!sorted.length) { setTimeout(() => startNight2(room), 2000); return; }

  const [condemnedId] = sorted[0];
  const condemned = room.players.find(p => p.id === condemnedId);
  if (condemned && condemned.alive) {
    condemned.alive = false;
    io.to(room.code).emit('vote:condemned', { player: { ...publicPlayer(condemned), roleInfo: roleInfo(condemned.role) } });
    if (condemned.role === 'HUNTER') notifyHunter(room, condemned);
    const evts = [];
    killLoverIfNeeded(room, condemned, evts);
    if (evts.length) io.to(room.code).emit('phase:dawn', { events: evts, day: room.day });
  }
  broadcastRoom(room);
  const win = checkWin(room);
  if (win) { endGame(room, win); return; }
  setTimeout(() => startNight2(room), 3000);
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
  io.to(room.code).emit('game:end', {
    winner,
    players: room.players.map(p => ({ ...publicPlayer(p), role: p.role, roleInfo: roleInfo(p.role) })),
  });
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
    if (room.players.length >= 12) { socket.emit('room:error', 'الغرفة ممتلئة'); return; }
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
    broadcastRoom(room);
    sendRolesToPlayers(room);
    setTimeout(() => startNight(room), 5000);
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

  socket.on('chat:send', ({ text }) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.alive) return;
    if (!text || !String(text).trim()) return;
    const isWolfChat = room.phase === 'night' && roleInfo(player.role).wolf;
    const msg = {
      sender: player.name,
      senderId: player.id, // ✅ الفرونت كيستعملو باش يتأكد واش المرسل هو الكرييتور
      avatar: player.avatar,
      text: String(text).slice(0, 300),
      isWolfOnly: isWolfChat,
    };
    if (isWolfChat) {
      wolvesOf(room).filter(w => !w.isBot).forEach(w => io.to(w.id).emit('chat:message', msg));
    } else {
      io.to(room.code).emit('chat:message', msg);
    }
  });

  /* ======================================================
     Creator auth & tools — نظام واحد نظيف (بلا تضارب)
     ====================================================== */

  // الفرونت كيبعث { code, deviceToken } — كنقبلو كذلك string وحدها للتوافق القديم
  socket.on('creator:auth', (payload) => {
    const code = (typeof payload === 'string') ? payload : ((payload && payload.code) || '');
    const deviceToken = (payload && typeof payload === 'object') ? (payload.deviceToken || null) : null;

    if (isPermanentlyBannedDevice({ id: socket.id, deviceToken, ip })) {
      socket.emit('creator:error', 'أنت محظور نهائياً.');
      return;
    }

    if (!CREATOR_SECRET) {
      socket.emit('creator:error', 'ميزة المطور غير مفعّلة على هاد السيرفر');
      return;
    }
    if (code !== CREATOR_SECRET) {
      socket.emit('creator:error', 'الكود غير صحيح');
      return;
    }

    // ── الحالة 1: ماكاينش جهاز مسجل بعد → هذا أول واحد، يتسجل كالكرييتور الرسمي
    if (!creatorState.deviceToken) {
      creatorState.deviceToken = deviceToken;
      creatorState.name = 'Alaa Dev';
      saveJSON(STATE_FILE, creatorState);
      acceptAsCreator(socket);
      return;
    }

    // ── الحالة 2: نفس الجهاز المسجل من قبل (أو ماكاينش deviceToken أصلاً، توافق قديم) → نقبلو
    if (!deviceToken || creatorState.deviceToken === deviceToken) {
      acceptAsCreator(socket);
      return;
    }

    // ── الحالة 3: جهاز آخر عرف الكود → رفض + إشعار للكرييتور الحقيقي
    socket.emit('creator:error', 'هاد الكود مربوط بجهاز آخر.');
    if (creatorSocketRef && creatorSocketRef.connected) {
      const room = findRoomBySocket(socket.id);
      const playerRec = room && room.players.find(p => p.id === socket.id);
      creatorSocketRef.emit('creator:intrusion', {
        id: socket.id,
        name: (playerRec && playerRec.name) || null,
        deviceToken,
        ip,
      });
    }
  });

  function acceptAsCreator(sock) {
    creatorSockets.add(sock.id);
    creatorSocketRef = sock;
    sock.emit('creator:ok', { id: sock.id, name: creatorState.name || 'Alaa Dev' });
    console.log(`👑 Creator authenticated: ${sock.id} (${ip})`);
    const room = findRoomBySocket(sock.id);
    if (room) broadcastRoom(room);
  }

  // استرجاع صفة الكرييتور تلقائياً بعد Reload بلا إعادة إدخال الكود
  socket.on('creator:resume', (payload) => {
    const deviceToken = (payload && payload.deviceToken) || null;
    if (deviceToken && creatorState.deviceToken && creatorState.deviceToken === deviceToken) {
      acceptAsCreator(socket);
    }
    // إذا ماكانش معروف، صامت — بلا رسالة خطأ
  });

  socket.on('creator:addBots', ({ count }) => {
    requireCreator(socket, () => {
      const room = findRoomBySocket(socket.id);
      if (!room) return;
      const n = Math.max(1, Math.min(parseInt(count, 10) || 1, 10));
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
      broadcastRoom(room);
    });
  });

  // حظر: type = 'session' (يقدر يرجع يدخل) أو 'permanent' (مسجل بالملف، ما كيضيعش عند إعادة التشغيل)
  socket.on('creator:ban', ({ targetId, deviceToken, type, reason }) => {
    requireCreator(socket, () => {
      const room = findRoomBySocket(socket.id);
      const targetSocket = io.sockets.sockets.get(targetId);
      const targetIP = targetSocket ? getClientIP(targetSocket) : null;
      const targetName = room ? (room.players.find(p => p.id === targetId) || {}).name : null;

      if (type === 'permanent') {
        permanentBans.push({
          id: targetId || null,
          name: targetName || null,
          deviceToken: deviceToken || null,
          ip: targetIP || null,
          reason: reason || 'creator_ban',
          bannedAt: Date.now(),
        });
        saveJSON(BANS_FILE, permanentBans);
        if (targetIP) permBannedIPs.add(targetIP);
      } else if (targetIP) {
        sessionBannedIPs.add(targetIP);
      }

      io.to(targetId).emit('room:error', type === 'permanent' ? 'تم حظرك بشكل دائم' : 'تم حظرك من قِبل المطور');
      if (targetSocket) targetSocket.disconnect(true);

      if (room) {
        const idx = room.players.findIndex(p => p.id === targetId);
        if (idx !== -1) room.players.splice(idx, 1);
        broadcastRoom(room);
      }
    });
  });

  socket.on('creator:unban', (ip2) => {
    requireCreator(socket, () => {
      permBannedIPs.delete(ip2);
      sessionBannedIPs.delete(ip2);
      permanentBans = permanentBans.filter(b => b.ip !== ip2);
      saveJSON(BANS_FILE, permanentBans);
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
      room.state = 'lobby'; room.phase = 'night'; room.day = 1;
      room.players.forEach(p => { p.role = null; p.alive = true; p.votedFor = null; p.lover = false; });
      broadcastRoom(room);
    });
  });

  socket.on('disconnect', () => {
    creatorSockets.delete(socket.id);
    if (creatorSocketRef === socket) creatorSocketRef = null;
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;
    const left = room.players[idx];
    room.players.splice(idx, 1);
    console.log(`❌ ${left.name} غادر الغرفة ${room.code}`);
    if (room.players.length === 0) {
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id;
    }
    broadcastRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`🐺 السيرفر شغّال: http://localhost:${PORT}`));
