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
 * مكتبة الأغاني تُجلب من رابط خارجي (افتراضياً https://loupmusic.surge.sh) بدل فولدر محلي:
 *  1) يجرب أولاً يقرا صفحة الرابط كاملة (HTML) ويلقط كل الروابط اللي تنتهي بامتداد صوت
 *     (.mp3, .wav, .ogg, .m4a, .flac, .aac, .opus) — هاذي تخدم تلقائياً إذا عندك index.html
 *     فصفحة surge يحتوي روابط لكل الأغاني (<a href="song1.mp3">...</a>).
 *  2) إذا ما لقاش شي حاجة، يجرب يقرا ملف manifest باسم songs.json أو music.json فنفس الرابط
 *     (مثال: https://loupmusic.surge.sh/songs.json) يحتوي مصفوفة JSON بأسماء/روابط الأغاني.
 *  3) النتائج تتخزن فكاش لمدة قصيرة (CACHE_TTL_MS) باش ما تولّيش تطلب من surge فكل بحث.
 *
 *  ملاحظة: يحتاج Node.js 18+ (باش fetch تكون موجودة بصفة built-in). إذا عندك نسخة أقدم،
 *  ثبت node-fetch وبدّل fetch(...) بـ require('node-fetch')(...).
 *
 * الاستخدام في server.js متاعك:
 *
 *   const { attachMusicServer } = require('./music-server');
 *   const io = new Server(httpServer, { ... });
 *   attachMusicServer(io, {
 *     remoteMusicUrl: 'https://loupmusic.surge.sh', // رابط فيه الأغاني (اختياري، هاذا الافتراضي)
 *   });
 *
 */

const REMOTE_AUDIO_EXT_REGEX = /\.(mp3|wav|ogg|m4a|flac|aac|opus)(?:[?#]|$)/i;
const HREF_REGEX = /href\s*=\s*["']([^"']+)["']/gi;

function attachMusicServer(io, options = {}) {
  // الحالة الحالية لكل غرفة: roomId -> { trackId, trackUrl, title, cover, addedByName, startedAt, isPlaying, queue }
  const roomStates = new Map();

  // باش تحدد شكون يقدر يبدّل الأغنية: 'anyone' | 'host-only'
  const permission = options.permission || 'anyone';

  // الرابط اللي فيه الأغاني
  const remoteMusicUrl = (options.remoteMusicUrl || 'https://loupmusic.surge.sh').replace(/\/$/, '');

  // كاش داخلي للمكتبة باش ما نطلبوش من surge فكل بحث
  let libraryCache = [];
  let libraryCacheAt = 0;
  const CACHE_TTL_MS = options.cacheTtlMs || 20000; // يعاود يجلب كل 20 ثانية بالكثير

  function fileNameFromUrl(u) {
    try {
      const clean = u.split('?')[0].split('#')[0];
      return decodeURIComponent(clean.split('/').filter(Boolean).pop() || '');
    } catch {
      return u;
    }
  }

  function titleFromFileName(fileName) {
    return fileName.replace(/\.[^./]+$/, '');
  }

  function normalizeManifestEntry(entry) {
    if (typeof entry === 'string') {
      const url = new URL(entry, remoteMusicUrl + '/').toString();
      const fileName = fileNameFromUrl(url);
      return { id: url, title: titleFromFileName(fileName), url, cover: null };
    }
    if (entry && typeof entry === 'object') {
      const rawUrl = entry.url || entry.file || entry.src || '';
      if (!rawUrl) return null;
      const url = new URL(rawUrl, remoteMusicUrl + '/').toString();
      const fileName = fileNameFromUrl(url);
      return {
        id: entry.id || url,
        title: entry.title || titleFromFileName(fileName),
        url,
        cover: entry.cover || null,
      };
    }
    return null;
  }

  // يحاول يقرا manifest (songs.json أو music.json) فجذر الرابط
  async function fetchManifestLibrary() {
    for (const name of ['songs.json', 'music.json']) {
      try {
        const res = await fetch(remoteMusicUrl + '/' + name);
        if (!res.ok) continue;
        const data = await res.json();
        if (Array.isArray(data)) {
          return data.map(normalizeManifestEntry).filter(Boolean);
        }
      } catch {
        // تجاهل ونجرب التالي
      }
    }
    return [];
  }

  // يحاول يقرا صفحة HTML فجذر الرابط ويلقط كل الروابط اللي تؤدي لملفات صوت
  async function fetchHtmlLinkedLibrary() {
    try {
      const res = await fetch(remoteMusicUrl + '/');
      if (!res.ok) return [];
      const html = await res.text();
      const found = new Map();
      let m;
      HREF_REGEX.lastIndex = 0;
      while ((m = HREF_REGEX.exec(html))) {
        const href = m[1];
        if (!REMOTE_AUDIO_EXT_REGEX.test(href)) continue;
        const url = new URL(href, remoteMusicUrl + '/').toString();
        if (found.has(url)) continue;
        const fileName = fileNameFromUrl(url);
        found.set(url, { id: url, title: titleFromFileName(fileName), url, cover: null });
      }
      return [...found.values()];
    } catch (err) {
      console.warn(`[music-server] تعذر جلب المكتبة من ${remoteMusicUrl}:`, err.message);
      return [];
    }
  }

  async function scanMusicLibrary() {
    const now = Date.now();
    if (now - libraryCacheAt < CACHE_TTL_MS && libraryCache.length) {
      return libraryCache;
    }

    const [manifestTracks, htmlTracks] = await Promise.all([
      fetchManifestLibrary(),
      fetchHtmlLinkedLibrary(),
    ]);

    const merged = new Map();
    [...manifestTracks, ...htmlTracks].forEach((t) => {
      if (t && t.url && !merged.has(t.url)) merged.set(t.url, t);
    });

    libraryCache = [...merged.values()];
    libraryCacheAt = now;

    if (!libraryCache.length) {
      console.warn(`[music-server] ما لقيتش أي أغاني فـ ${remoteMusicUrl} — تأكد كاين index.html فيه روابط للأغاني أو ملف songs.json`);
    }
    return libraryCache;
  }

  // يجلب المكتبة مرة أول عند تشغيل السيرفر باش تكون جاهزة قبل أول بحث
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

    // البحث عن أغاني: يجلب من loupmusic.surge.sh (أو الرابط اللي حددتو) ويرجع كل الأغاني
    // (أو المطابقة للكلمة المكتوبة إذا كتب المستخدم شي حاجة)
    socket.on('music:search', async ({ query } = {}) => {
      const lib = await scanMusicLibrary();
      const q = (query || '').trim().toLowerCase();
      const results = !q
        ? lib // بلا بحث: يبعث كل الأغاني الموجودة فالرابط
        : lib.filter((t) => t.title.toLowerCase().includes(q));
      socket.emit('music:searchResults', { results });
    });

    // يرجع المكتبة كاملة مباشرة (بلا بحث) — مفيد عند فتح لوحة البحث لأول مرة
    socket.on('music:library', async () => {
      socket.emit('music:searchResults', { results: await scanMusicLibrary() });
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
