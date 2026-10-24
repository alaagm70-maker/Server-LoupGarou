/**
 * music-server.js
 * نظام أغاني متزامن (Synced Jukebox) — يُستخدم مع Socket.io الموجود في server.js متاعك
 *
 * الفكرة:
 *  - السيرفر يحتفظ بحالة "الأغنية الحالية" لكل غرفة (room): رابط الأغنية، وقت البداية، حالة التشغيل/التوقف.
 *  - كل مرة لاعب يبدّل الأغنية أو يوقفها، يتبدّل الـ state ويتبعث لكل اللاعبين في نفس الغرفة.
 *  - أي لاعب يدخل جديد (أو عنده refresh) يطلب الحالة الحالية فيتزامن مباشرة مع البقية
 *    (السيرفر يحسب الوقت المنقضي من وقت البداية ويرسله، باش الكلاينت يقدر "يقفز" لنفس النقطة).
 *
 * الاستخدام في server.js متاعك:
 *
 *   const { attachMusicServer } = require('./music-server');
 *   const io = new Server(httpServer, { ... });
 *   attachMusicServer(io);
 *
 */

function attachMusicServer(io, options = {}) {
  // الحالة الحالية لكل غرفة: roomId -> { trackId, trackUrl, title, cover, addedByName, startedAt, isPlaying, queue }
  const roomStates = new Map();

  // باش تحدد شكون يقدر يبدّل الأغنية: 'anyone' | 'host-only'
  const permission = options.permission || 'anyone';

  // مكتبة الأغاني المتاحة للبحث — زيد/بدّل هاذ المصفوفة بأغانيك
  // كل عنصر: { id, title, url, cover }
  const library = options.library || [];

  function getOrCreateRoom(roomId) {
    if (!roomStates.has(roomId)) {
      roomStates.set(roomId, {
        trackId: null,
        trackUrl: null,
        title: null,
        cover: null,
        addedByName: null,
        startedAt: null, // Date.now() وقت ما بدات الأغنية
        pausedAt: null,  // إذا متوقفة، شحال كانت الثانية اللي وقفت فيها
        isPlaying: false,
        queue: [],        // قائمة انتظار بسيطة: [{trackId, trackUrl, title, addedBy}]
        hostId: null,     // socket.id متاع أول واحد دخل (إذا host-only)
      });
    }
    return roomStates.get(roomId);
  }

  // يحسب الوقت الحالي للأغنية (بالثواني) باش الكلاينت يتزامن معاه
  function computeElapsedSeconds(state) {
    if (!state.isPlaying || !state.startedAt) {
      return state.pausedAt || 0;
    }
    return (Date.now() - state.startedAt) / 1000;
  }

  function broadcastState(roomId) {
    const state = roomStates.get(roomId);
    if (!state) return;
    io.to(roomId).emit('music:state', {
      trackId: state.trackId,
      trackUrl: state.trackUrl,
      title: state.title,
      cover: state.cover,
      addedByName: state.addedByName,
      isPlaying: state.isPlaying,
      elapsedSeconds: computeElapsedSeconds(state),
      queue: state.queue,
    });
  }

  function canControl(socket, state) {
    if (permission === 'anyone') return true;
    return state.hostId === socket.id;
  }

  io.on('connection', (socket) => {
    // اللاعب يدخل غرفة ويطلب يتزامن مع الأغنية الحالية
    socket.on('music:join', ({ roomId }) => {
      if (!roomId) return;
      socket.join(roomId);
      const state = getOrCreateRoom(roomId);
      if (!state.hostId) state.hostId = socket.id; // أول واحد يدخل يصير host

      // يرسل الحالة الحالية فقط لهاذ اللاعب (مزامنة فورية)
      socket.emit('music:state', {
        trackId: state.trackId,
        trackUrl: state.trackUrl,
        title: state.title,
        cover: state.cover,
        addedByName: state.addedByName,
        isPlaying: state.isPlaying,
        elapsedSeconds: computeElapsedSeconds(state),
        queue: state.queue,
      });
    });

    // تبديل الأغنية: يبدأ من 0
    socket.on('music:change', ({ roomId, trackId, trackUrl, title, cover, addedByName }) => {
      const state = getOrCreateRoom(roomId);
      if (!canControl(socket, state)) return;

      state.trackId = trackId;
      state.trackUrl = trackUrl;
      state.title = title || null;
      state.cover = cover || null;
      state.addedByName = addedByName || null;
      state.startedAt = Date.now();
      state.pausedAt = null;
      state.isPlaying = true;

      broadcastState(roomId);
    });

    // البحث عن أغاني في مكتبة السيرفر
    socket.on('music:search', ({ query } = {}) => {
      const q = (query || '').trim().toLowerCase();
      const results = !q
        ? library.slice(0, 20)
        : library.filter((t) => (t.title || '').toLowerCase().includes(q)).slice(0, 20);
      socket.emit('music:searchResults', { results });
    });

    // إيقاف مؤقت
    socket.on('music:pause', ({ roomId }) => {
      const state = roomStates.get(roomId);
      if (!state || !canControl(socket, state)) return;
      if (state.isPlaying) {
        state.pausedAt = computeElapsedSeconds(state);
        state.isPlaying = false;
        broadcastState(roomId);
      }
    });

    // استئناف التشغيل من نفس النقطة
    socket.on('music:resume', ({ roomId }) => {
      const state = roomStates.get(roomId);
      if (!state || !canControl(socket, state)) return;
      if (!state.isPlaying && state.trackUrl) {
        state.startedAt = Date.now() - (state.pausedAt || 0) * 1000;
        state.isPlaying = true;
        broadcastState(roomId);
      }
    });

    // إضافة أغنية لقائمة الانتظار (اختياري)
    socket.on('music:queueAdd', ({ roomId, trackId, trackUrl, title }) => {
      const state = getOrCreateRoom(roomId);
      state.queue.push({ trackId, trackUrl, title, addedBy: socket.id });
      broadcastState(roomId);
    });

    // الانتقال للأغنية الجاية فالقائمة
    socket.on('music:next', ({ roomId }) => {
      const state = roomStates.get(roomId);
      if (!state || !canControl(socket, state)) return;
      const next = state.queue.shift();
      if (next) {
        state.trackId = next.trackId;
        state.trackUrl = next.trackUrl;
        state.title = next.title || null;
        state.startedAt = Date.now();
        state.pausedAt = null;
        state.isPlaying = true;
        broadcastState(roomId);
      }
    });

    socket.on('disconnect', () => {
      // إذا الـ host خرج، نعطي الصلاحية لأي واحد باقي فالغرفة (تبسيط)
      for (const [roomId, state] of roomStates.entries()) {
        if (state.hostId === socket.id) {
          const clients = io.sockets.adapter.rooms.get(roomId);
          state.hostId = clients ? [...clients].find((id) => id !== socket.id) || null : null;
        }
      }
    });
  });

  return { roomStates };
}

module.exports = { attachMusicServer };