/*
  ═══════════════════════════════════════════════════════════════
  Creator Code — منطق السيرفر (Node.js + Socket.io)
  ═══════════════════════════════════════════════════════════════
  هاد الكود خاصك تلصقو فملف السيرفر ديالك (server.js أو المكان
  اللي كتعالج فيه أحداث السوكيت). كيبني على المتغيرات اللي
  كتستعملها دابا: CREATOR_SECRET (env var) و io / socket.

  المبدأ:
  - أول جهاز (deviceToken) يعرف الكود الصحيح، كيتسجل كـ "الجهاز
    الرسمي ديال الكرييتور" فملف/قاعدة بيانات بسيطة (JSON هنا،
    بدلها بقاعدة بيانات حقيقية إذا بغيتي).
  - أي محاولة بعدها بنفس الكود من جهاز آخر → كترفض + كتبعث
    إشعار creator:intrusion للكرييتور الحقيقي (إذا كان متصل).
  - creator:ban بنوع permanent كيسجل الحظر بـ id + deviceToken +
    IP (إذا متوفر) باش يبقى محظور حتى لو بدل الاسم.
*/

const fs = require('fs');
const path = require('path');

const CREATOR_SECRET = process.env.CREATOR_SECRET; // نفس السر المستعمل حالياً
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

// { deviceToken: string|null, name: string|null, socketId: string|null }
let creatorState = loadJSON(STATE_FILE, { deviceToken: null, name: null });

// [{ id, name, deviceToken, ip, reason, bannedAt }]
let permanentBans = loadJSON(BANS_FILE, []);

function isPermanentlyBanned({ id, deviceToken, ip }) {
  return permanentBans.some(b =>
    (deviceToken && b.deviceToken === deviceToken) ||
    (ip && b.ip === ip) ||
    (id && b.id === id)
  );
}

// كنخزنو مرجع للسوكيت الحالي ديال الكرييتور باش نقدرو نبعثو ليه الإشعارات
let creatorSocket = null;

function registerCreatorHandlers(io, socket) {

  // منع أي شخص محظور نهائياً من حتى الدخول للغرفة من الأساس
  // (زيدها فمكان انضمام اللاعب room:join / room:create عندك)
  // if (isPermanentlyBanned({ id: socket.id, ip: socket.handshake.address })) {
  //   socket.emit('room:error', 'أنت محظور من هاد اللعبة.');
  //   socket.disconnect(true);
  //   return;
  // }

  socket.on('creator:auth', (payload) => {
    const code = (payload && payload.code) || '';
    const deviceToken = (payload && payload.deviceToken) || null;
    const ip = socket.handshake.address;

    if (isPermanentlyBanned({ id: socket.id, deviceToken, ip })) {
      socket.emit('creator:error', 'أنت محظور نهائياً.');
      return;
    }

    if (!CREATOR_SECRET || code !== CREATOR_SECRET) {
      socket.emit('creator:error', 'كود خاطئ.');
      return;
    }

    // ── الحالة 1: ماكاينش جهاز مسجل بعد → هذا أول واحد، يتسجل كالكرييتور الرسمي
    if (!creatorState.deviceToken) {
      creatorState.deviceToken = deviceToken;
      creatorState.name = 'Alaa Dev';
      saveJSON(STATE_FILE, creatorState);
      creatorSocket = socket;
      socket.emit('creator:ok', { id: socket.id, name: creatorState.name });
      return;
    }

    // ── الحالة 2: كاين جهاز مسجل ونفسو لي عاود دخل (مثلاً بعد Reload) → نقبلو
    if (creatorState.deviceToken === deviceToken) {
      creatorSocket = socket;
      socket.emit('creator:ok', { id: socket.id, name: creatorState.name });
      return;
    }

    // ── الحالة 3: جهاز آخر عرف الكود → كنرفضو ونبعثو إشعار للكرييتور الحقيقي
    socket.emit('creator:error', 'هاد الكود مربوط بجهاز آخر.');
    if (creatorSocket && creatorSocket.connected) {
      creatorSocket.emit('creator:intrusion', {
        id: socket.id,
        name: (payload && payload.playerName) || socket.data?.playerName || null,
        deviceToken,
        ip
      });
    }
  });

  // استرجاع صفة الكرييتور تلقائياً (بلا إعادة إدخال الكود) بعد Reload
  socket.on('creator:resume', (payload) => {
    const deviceToken = (payload && payload.deviceToken) || null;
    if (deviceToken && creatorState.deviceToken === deviceToken) {
      creatorSocket = socket;
      socket.emit('creator:ok', { id: socket.id, name: creatorState.name });
    }
    // إذا ماكانش الجهاز معروف، ماكنديروش والو (بلا إشعار خطأ، الطلب صامت)
  });

  socket.on('creator:ban', (payload) => {
    // تأكد أن اللي طلب الحظر هو فعلاً الكرييتور المصادق عليه
    if (!creatorSocket || creatorSocket.id !== socket.id) return;

    const { targetId, deviceToken, type, reason } = payload || {};
    const targetSocket = io.sockets.sockets.get(targetId);
    const ip = targetSocket ? targetSocket.handshake.address : null;

    if (type === 'permanent') {
      permanentBans.push({
        id: targetId || null,
        name: targetSocket?.data?.playerName || null,
        deviceToken: deviceToken || null,
        ip,
        reason: reason || 'creator_ban',
        bannedAt: Date.now()
      });
      saveJSON(BANS_FILE, permanentBans);
    }

    if (targetSocket) {
      targetSocket.emit('room:error', 'تم حظرك من هاد اللعبة نهائياً.');
      targetSocket.disconnect(true);
    }
    // ... باقي منطق الحظر المؤقت (session) يبقى كيفما هو عندك
  });

  socket.on('disconnect', () => {
    if (creatorSocket === socket) creatorSocket = null;
  });
}

module.exports = { registerCreatorHandlers, isPermanentlyBanned };

/*
  الاستعمال فملف السيرفر الرئيسي:

  const { registerCreatorHandlers } = require('./creator-server-snippet');

  io.on('connection', (socket) => {
    // ... باقي أحداثك (room:create, room:join, ...)
    registerCreatorHandlers(io, socket);
  });
*/
