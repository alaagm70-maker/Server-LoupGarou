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
 * مكتبة الأغاني تُقرأ مباشرة من فولدر "music" الموجود جنب هاذ الملف (أو مسار تحدده إنت):
 *   music/
 *     اغنية1.mp3
 *     اغنية2.mp3
 *     ...
 * السيرفر يفحص الفولدر، ياخذ أسماء الملفات (بلا الامتداد) كعناوين، ويخدمها كـ static files
 * باش الكلاينت يقدر يشغّلها من رابط زي: /music/اغنية1.mp3
 *
 * الاستخدام في server.js متاعك:
 *
 *   const path = require('path');
 *   const { attachMusicServer } = require('./music-server');
 *
 *   // 1) يخدم ملفات الأغاني بصفة static باش الكلاينت يقدر يشغّلها عبر رابط
 *   app.use('/music', express.static(path.join(__dirname, 'music')));
 *
 *   // 2) يربط منطق المزامنة + البحث
 *   const io = new Server(httpServer, { ... });
 *   attachMusicServer(io, {
 *     musicDir: path.join(__dirname, 'music'), // الفولدر اللي فيه الأغاني
 *     musicBaseUrl: '/music',                  // نفس المسار اللي خدمتو بـ express.static
 *   });
 *
 */

const fs = require('fs');
const path = require('path');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus']);

function attachMusicServer(io, options = {}) {
  // الحالة الحالية لكل غرفة: roomId -> { trackId, trackUrl, title, cover, addedByName, startedAt, isPlaying, queue }
  const roomStates = new Map();

  // باش تحدد شكون يقدر يبدّل الأغنية: 'anyone' | 'host-only'
  const permission = options.permission || 'anyone';

  // فولدر الأغاني على القرص، والمسار اللي تُخدم بيه (لازم يطابق express.static متاعك)
  const musicDir = options.musicDir || path.join(__dirname, 'music');
  const musicBaseUrl = options.musicBaseUrl || '/music';

  // كاش داخلي للمكتبة باش ما نقراوش الفولدر فكل طلب بحث
  let libraryCache = [];
  let libraryCacheAt = 0;
  const CACHE_TTL_MS = 5000; // يعاود يقرا الفولدر كل 5 ثواني بالكثير (باش يكتشف أغاني جداد تزادو)

  function scanMusicLibrary() {
    const now = Date.now();
    if (now - libraryCacheAt < CACHE_TTL_MS && libraryCache.length) {
      return libraryCache;
    }
    let files = [];
    try {
      files = fs.readdirSync(musicDir);
    } catch (err) {
      console.warn(`[music-server] تعذر قراءة فولدر الأغاني (${musicDir}):`, err.message);
      libraryCache = [];
      libraryCacheAt = now;
      return libraryCache;
    }

    libraryCache = files
      .filter((f) => AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase()))
      .map((f) => {
        const title = path.basename(f, path.extname(f));
        return {
          id: f,                                  // اسم الملف كاملاً = معرّف فريد
          title,                                   // اسم الأغنية بلا الامتداد
          url: musicBaseUrl + '/' + encodeURIComponent(f),
          cover: null,                             // حط رابط صورة هنا إذا عندك واحدة بنفس الاسم
        };
      });
    libraryCacheAt = now;
    return libraryCache;
  }

  // نقرا الفولدر مرة أول باش الكاش ما يكونش فارغ قبل أول بحث
  scanMusicLibrary();

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

    // البحث عن أغاني: يقرا فولدر music ويرجع كل الأغاني (أو المطابقة للكلمة المكتوبة)
    socket.on('music:search', ({ query } = {}) => {
      const lib = scanMusicLibrary();
      const q = (query || '').trim().toLowerCase();
      const results = !q
        ? lib // بلا بحث: يبعث كل الأغاني الموجودة فالفولدر
        : lib.filter((t) => t.title.toLowerCase().includes(q));
      socket.emit('music:searchResults', { results });
    });

    // يرجع المكتبة كاملة مباشرة (بلا بحث) — مفيد عند فتح لوحة البحث لأول مرة
    socket.on('music:library', () => {
      socket.emit('music:searchResults', { results: scanMusicLibrary() });
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
