const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const vm = require('vm');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map();
const ROOM_INACTIVITY_MS = 2 * 60 * 60 * 1000;
const ROOMS_STORE_FILE = path.join(__dirname, 'data', 'rooms.json');
let roomSaveTimer = null;

function saveRoomsSoon() {
  if (roomSaveTimer) return;
  roomSaveTimer = setTimeout(() => {
    roomSaveTimer = null;
    try {
      fs.mkdirSync(path.dirname(ROOMS_STORE_FILE), { recursive: true });
      const savedRooms = [...rooms.values()].map(({ users, hostId, ...room }) => room);
      fs.writeFileSync(ROOMS_STORE_FILE, JSON.stringify(savedRooms), 'utf8');
    } catch (err) {
      console.warn('Unable to save karaoke rooms:', err.message);
    }
  }, 250);
  roomSaveTimer.unref();
}

function loadSavedRooms() {
  try {
    const savedRooms = JSON.parse(fs.readFileSync(ROOMS_STORE_FILE, 'utf8'));
    if (!Array.isArray(savedRooms)) return;
    const now = Date.now();
    savedRooms.forEach((room) => {
      if (!room?.id || now - (room.lastActiveAt || 0) >= ROOM_INACTIVITY_MS) return;
      rooms.set(room.id, { ...room, users: {}, hostId: null, lastActiveAt: now });
    });
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Unable to load saved karaoke rooms:', err.message);
  }
}

function makeRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i += 1) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function createRoom() {
  let id = makeRoomId();
  while (rooms.has(id)) {
    id = makeRoomId();
  }
  const room = {
    id,
    users: {},
    playlist: [],
    current: null,
    bannerVisible: false,
    hostId: null,
    chat: [],
    lastActiveAt: Date.now()
  };
  rooms.set(id, room);
  saveRoomsSoon();
  return room;
}

function roomState(room) {
  return {
    roomId: room.id,
    current: room.current,
    playlist: room.playlist,
    users: Object.values(room.users),
    hostId: room.hostId,
    chat: room.chat,
    bannerVisible: room.bannerVisible
  };
}

function startNextSong(room) {
  if (!room) return;
  if (room.playlist.length === 0) {
    room.current = null;
    room.bannerVisible = false;
    return;
  }
  const next = room.playlist.shift();
  room.current = {
    id: next.id,
    title: next.title,
    videoId: next.videoId,
    singer: next.singer || next.addedBy || 'Guest',
    score: Math.floor(80 + Math.random() * 21)
  };
  room.bannerVisible = true;
}

loadSavedRooms();
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use(express.json());

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const searchCache = new Map();
const videoValidationCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const VALIDATION_CACHE_TTL = 15 * 60 * 1000;
const MAX_CACHE_SIZE = 100;
const FETCH_TIMEOUT_MS = 10000;
const NON_SONG_PATTERN = /\b(?:playlist|mix|compilation|medley|mashup|top\s*\d+|best\s+(?:karaoke|songs)|greatest\s+hits|\d+\s+(?:karaoke\s+)?songs|hours?\s+of|nonstop|tutorial|how\s+to|lesson|tips?|vlog|reaction|review|challenge|ranking|countdown)\b/i;

function cleanupCache(cache, maxSize) {
  if (cache.size > maxSize) {
    const entries = Array.from(cache.entries()).sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
    const toRemove = entries.length - maxSize;
    for (let i = 0; i < toRemove; i++) {
      cache.delete(entries[i][0]);
    }
  }
}

async function fetchYouTubeApi(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Accept: 'application/json'
      }
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      throw new Error(`YouTube API request failed with ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('YouTube API request timeout');
    }
    throw err;
  }
}

function isKaraokeTitle(title) {
  const lower = title.toLowerCase();
  return (lower.includes('karaoke') || lower.includes('カラオケ') || lower.includes('karaoké')) && !NON_SONG_PATTERN.test(title);
}

function isDuetKaraokeTitle(title) {
  const lower = title.toLowerCase();
  return isKaraokeTitle(title) && lower.includes('duet') && lower.includes('karaoke');
}

function touchRoom(room) {
  if (room) {
    room.lastActiveAt = Date.now();
    saveRoomsSoon();
  }
}

async function verifyYouTubeVideo(videoId, thumbnail) {
  if (!videoId || !thumbnail) return null;
  const cached = videoValidationCache.get(videoId);
  if (cached && Date.now() - cached.createdAt < VALIDATION_CACHE_TTL) return cached.value;
  const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Accept: 'application/json'
      }
    });
    clearTimeout(timeoutId);
    
    if (!response.ok) return null;
    const data = await response.json();
    const thumbnailUrl = data.thumbnail_url || thumbnail;
    
    const controller2 = new AbortController();
    const timeoutId2 = setTimeout(() => controller2.abort(), 5000);
    const thumbnailResponse = await fetch(thumbnailUrl, {
      method: 'HEAD',
      signal: controller2.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    clearTimeout(timeoutId2);
    
    const value = thumbnailResponse.ok ? { videoId, thumbnail: thumbnailUrl } : null;
    videoValidationCache.set(videoId, { createdAt: Date.now(), value });
    cleanupCache(videoValidationCache, MAX_CACHE_SIZE);
    return value;
  } catch (err) {
    if (err.name !== 'AbortError') {
      videoValidationCache.set(videoId, { createdAt: Date.now(), value: null });
      cleanupCache(videoValidationCache, MAX_CACHE_SIZE);
    }
    return null;
  }
}

function mapSearchItems(items) {
  return items
    .filter((item) => item.id?.videoId)
    .map((item) => {
      const snippet = item.snippet || {};
      const title = snippet.title || 'Unknown karaoke';
      return {
        videoId: item.id.videoId,
        title,
        thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url
      };
    })
    .filter((item) => item.thumbnail && isKaraokeTitle(item.title));
}

async function verifySearchResults(items, limit = 8) {
  const candidates = items.slice(0, Math.min(50, Math.max(16, limit * 2)));
  const results = await Promise.allSettled(
    candidates.map(async (item) => {
      const valid = await verifyYouTubeVideo(item.videoId, item.thumbnail);
      return valid ? { ...item, thumbnail: valid.thumbnail } : null;
    })
  );
  return results
    .filter((result) => result.status === 'fulfilled' && result.value)
    .map((result) => result.value);
}

async function fetchYouTubeViews(videoIds) {
  if (!YOUTUBE_API_KEY || !videoIds.length) return {};
  const idList = encodeURIComponent(videoIds.join(','));
  const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${idList}&key=${YOUTUBE_API_KEY}`;
  const data = await fetchYouTubeApi(url);
  return (data.items || []).reduce((map, item) => {
    if (item.id && item.statistics?.viewCount) {
      map[item.id] = Number(item.statistics.viewCount);
    }
    return map;
  }, {});
}

function sortByViewCount(items, statsMap) {
  return items.slice().sort((a, b) => (statsMap[b.videoId] || 0) - (statsMap[a.videoId] || 0));
}

app.post('/api/create-room', (req, res) => {
  const room = createRoom();
  res.json({ roomId: room.id, url: `/room/${room.id}` });
});

app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.get('/qr/:roomId', async (req, res) => {
  const roomId = String(req.params.roomId || '').trim().toUpperCase();
  const forwardedProtocol = req.get('x-forwarded-proto')?.split(',')[0];
  const baseUrl = `${forwardedProtocol || req.protocol}://${req.get('host')}`;
  const url = `${baseUrl}/room/${roomId}`;
  try {
    const svg = await QRCode.toString(url, { type: 'svg', width: 240 });
    res.type('image/svg+xml').send(svg);
  } catch (err) {
    res.status(500).send('QR generation failed');
  }
});

function extractJsonValue(html, key) {
  const index = html.indexOf(key);
  if (index === -1) return null;
  const start = html.indexOf('{', index);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let currentQuote = null;
  let escape = false;
  for (let i = start; i < html.length; i += 1) {
    const char = html[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (inString) {
      if (char === currentQuote) {
        inString = false;
        currentQuote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      currentQuote = char;
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return html.slice(start, i + 1);
      }
    }
  }
  return null;
}

function parseYouTubeResults(html) {
  const jsonString = extractJsonValue(html, 'ytInitialData');
  if (!jsonString) return [];
  let data;
  try {
    data = new vm.Script(`(${jsonString})`).runInNewContext({});
  } catch (err) {
    return [];
  }

  const foundVideos = [];
  let recursionDepth = 0;
  const MAX_RECURSION_DEPTH = 50;
  
  function collectVideoRenderers(node) {
    if (recursionDepth > MAX_RECURSION_DEPTH) return;
    if (!node || typeof node !== 'object') return;
    
    if (node.videoRenderer?.videoId) {
      foundVideos.push(node.videoRenderer);
    }
    
    recursionDepth += 1;
    for (const key of Object.keys(node)) {
      if (foundVideos.length >= 100) break;
      collectVideoRenderers(node[key]);
    }
    recursionDepth -= 1;
  }

  collectVideoRenderers(data);

  const items = foundVideos
    .map((video) => {
      const title = video.title?.runs?.map((run) => run.text).join('') || video.title?.simpleText || '';
      const thumbnails = video.thumbnail?.thumbnails || [];
      return {
        videoId: video.videoId,
        title: title.trim(),
        thumbnail: thumbnails[thumbnails.length - 1]?.url
      };
    })
    .filter((item) => item.thumbnail && isKaraokeTitle(item.title));

  return items;
}

app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 12));
  if (!query) {
    res.json([]);
    return;
  }
  const cacheKey = `${query.toLowerCase()}:${limit}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL) {
    res.json(cached.results);
    return;
  }
  const searchPhrase = `${query} karaoke`;
  try {
    if (YOUTUBE_API_KEY) {
      try {
        const encoded = encodeURIComponent(searchPhrase);
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encoded}&maxResults=50&key=${YOUTUBE_API_KEY}`;
        const apiData = await fetchYouTubeApi(url);
        let results = mapSearchItems(apiData.items || []);
        const stats = await fetchYouTubeViews(results.map((item) => item.videoId));
        results = sortByViewCount(results, stats).slice(0, 50);
        const verified = await verifySearchResults(results, limit);
        const resultPayload = verified.slice(0, limit);
        searchCache.set(cacheKey, { createdAt: Date.now(), results: resultPayload });
        cleanupCache(searchCache, MAX_CACHE_SIZE);
        res.json(resultPayload);
        return;
      } catch (err) {
        console.warn('YouTube API search failed:', err.message);
      }
    }
  } catch (err) {
    console.warn('Search error:', err.message);
  }

  const encoded = encodeURIComponent(searchPhrase);
  const url = `https://www.youtube.com/results?search_query=${encoded}`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Accept: 'text/html'
      }
    });
    clearTimeout(timeoutId);
    
    const html = await response.text();
    const results = parseYouTubeResults(html);
    const verified = await verifySearchResults(results, limit);
    const resultPayload = verified.slice(0, limit);
    searchCache.set(cacheKey, { createdAt: Date.now(), results: resultPayload });
    cleanupCache(searchCache, MAX_CACHE_SIZE);
    res.json(resultPayload);
  } catch (err) {
    console.warn('Fallback search error:', err.message);
    res.json([]);
  }
});

app.get('/api/viral', async (req, res) => {
  try {
    const limit = Math.min(30, parseInt(req.query.limit, 10) || 12);
    const roomId = String(req.query.room || '');
    const viralQueries = [
      'karaoke popular hits',
      'karaoke sing along hits',
      'best karaoke songs lyrics',
      'popular karaoke versions'
    ];
    const queryIndex = hashRoomId(roomId) % viralQueries.length;
    try {
      if (YOUTUBE_API_KEY) {
        const query = encodeURIComponent(viralQueries[queryIndex]);
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${query}&maxResults=${Math.min(limit * 2, 50)}&order=viewCount&key=${YOUTUBE_API_KEY}`;
        const apiData = await fetchYouTubeApi(url);
        let results = mapSearchItems(apiData.items || []);
        const stats = await fetchYouTubeViews(results.map((item) => item.videoId));
        results = sortByViewCount(results, stats).slice(0, limit);
        const verified = await verifySearchResults(results);
        res.json(verified.slice(0, limit));
        return;
      }
    } catch (err) {
      console.warn('YouTube API viral search failed:', err.message);
    }

    const query = viralQueries[queryIndex];
    const encoded = encodeURIComponent(query);
    const url = `https://www.youtube.com/results?search_query=${encoded}`;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          Accept: 'text/html'
        }
      });
      clearTimeout(timeoutId);
      
      const html = await response.text();
      const results = parseYouTubeResults(html);
      const verified = await verifySearchResults(results);
      res.json(verified.slice(0, limit));
    } catch (err) {
      console.warn('Viral search fallback error:', err.message);
      res.json([]);
    }
  } catch (err) {
    console.error('Viral endpoint error:', err.message);
    res.status(500).json([]);
  }
});

function hashRoomId(roomId) {
  return [...String(roomId)].reduce((hash, character) => ((hash * 31) + character.charCodeAt(0)) >>> 0, 0);
}

function rotateSongs(songs, roomId, limit) {
  if (!songs.length) return [];
  const offset = hashRoomId(roomId) % songs.length;
  return [...songs.slice(offset), ...songs.slice(0, offset)].slice(0, limit);
}

function sampleSongs(type, roomId, limit = 8) {
  const samples = {
    old: [
      { videoId: '3HAN0Xbqigc', title: 'Bohemian Rhapsody - Karaoke Version', thumbnail: 'https://i.ytimg.com/vi/3HAN0Xbqigc/hqdefault.jpg' },
      { videoId: 'E1vHZfcgXV8', title: 'Billie Jean Karaoke', thumbnail: 'https://i.ytimg.com/vi/E1vHZfcgXV8/hqdefault.jpg' },
      { videoId: '43A8cA7N4fs', title: 'I Will Survive Karaoke', thumbnail: 'https://i.ytimg.com/vi/43A8cA7N4fs/hqdefault.jpg' },
      { videoId: 'ZYd0dJvSbdM', title: 'Livin’ On A Prayer Karaoke', thumbnail: 'https://i.ytimg.com/vi/ZYd0dJvSbdM/hqdefault.jpg' },
      { videoId: 'YQHsXMglC9A', title: 'Hello Karaoke', thumbnail: 'https://i.ytimg.com/vi/YQHsXMglC9A/hqdefault.jpg' },
      { videoId: 'C1RzR5tR9tw', title: 'Sweet Caroline Karaoke', thumbnail: 'https://i.ytimg.com/vi/C1RzR5tR9tw/hqdefault.jpg' },
      { videoId: 'L_jWHffIx5E', title: 'I Want It That Way Karaoke', thumbnail: 'https://i.ytimg.com/vi/L_jWHffIx5E/hqdefault.jpg' },
      { videoId: 'fJ9rUzIMcZQ', title: 'Yesterday Karaoke', thumbnail: 'https://i.ytimg.com/vi/fJ9rUzIMcZQ/hqdefault.jpg' }
    ],
    duet: [
      { videoId: 'x2T11rZqzrg', title: 'Shallow Karaoke Duet', thumbnail: 'https://i.ytimg.com/vi/x2T11rZqzrg/hqdefault.jpg' },
      { videoId: 'g6fs4vNygMg', title: 'A Whole New World Duet Karaoke', thumbnail: 'https://i.ytimg.com/vi/g6fs4vNygMg/hqdefault.jpg' },
      { videoId: 'Do0qFqjAqvI', title: 'Endless Love Duet Karaoke', thumbnail: 'https://i.ytimg.com/vi/Do0qFqjAqvI/hqdefault.jpg' },
      { videoId: 'G27RDW5sJjo', title: 'Say Something Duet Karaoke', thumbnail: 'https://i.ytimg.com/vi/G27RDW5sJjo/hqdefault.jpg' },
      { videoId: '8UVNT4wvIGY', title: 'Senorita Karaoke', thumbnail: 'https://i.ytimg.com/vi/8UVNT4wvIGY/hqdefault.jpg' },
      { videoId: 'wXhTHyIgQ_U', title: 'Can’t Help Falling In Love Duet Karaoke', thumbnail: 'https://i.ytimg.com/vi/wXhTHyIgQ_U/hqdefault.jpg' },
      { videoId: 'pLJgTbOw534', title: 'Beauty and the Beast Duet Karaoke', thumbnail: 'https://i.ytimg.com/vi/pLJgTbOw534/hqdefault.jpg' },
      { videoId: 'e-ORhEE9VVg', title: 'Love The Way You Lie Karaoke', thumbnail: 'https://i.ytimg.com/vi/e-ORhEE9VVg/hqdefault.jpg' }
    ]
  };
  return rotateSongs(samples[type] || [], roomId, limit);
}

async function verifiedSampleSongs(type, roomId, limit) {
  const samples = sampleSongs(type, roomId, limit);
  const verified = await verifySearchResults(samples, limit);
  return verified.slice(0, limit);
}

app.get('/api/old-songs', async (req, res) => {
  try {
    const limit = Math.min(30, parseInt(req.query.limit, 10) || 12);
    res.json(await verifiedSampleSongs('old', String(req.query.room || ''), limit));
  } catch (err) {
    console.error('Old songs error:', err.message);
    res.status(500).json([]);
  }
});

app.get('/api/suggestions', async (req, res) => {
  try {
    const query = (req.query.q || '').trim();
    if (!query) {
      res.json([]);
      return;
    }
    const encoded = encodeURIComponent(query);
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encoded}`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
      });
      clearTimeout(timeoutId);
      
      const text = await response.text();
      const data = JSON.parse(text);
      const suggestions = (data[1] || []).filter((item) => typeof item === 'string');
      res.json(suggestions.slice(0, 6));
    } catch (err) {
      clearTimeout(timeoutId);
      console.warn('Suggestions error:', err.message);
      res.json([]);
    }
  } catch (err) {
    console.error('Suggestions endpoint error:', err.message);
    res.status(500).json([]);
  }
});

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, name }) => {
    try {
      const normalizedRoomId = String(roomId || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!/^[A-HJ-NP-Z2-9]{6}$/.test(normalizedRoomId)) {
        socket.emit('room-error', 'Invalid room code');
        return;
      }
      const room = rooms.get(normalizedRoomId);
      if (!room) {
        socket.emit('room-error', 'This room has expired or is unavailable. Ask the host for a new link.');
        return;
      }
      touchRoom(room);

      const isHost = !room.hostId;
      if (isHost) {
        room.hostId = socket.id;
      }

      room.users[socket.id] = {
        id: socket.id,
        name: name || 'Guest',
        isHost
      };

      socket.join(normalizedRoomId);
      io.to(normalizedRoomId).emit('room-state', roomState(room));
      io.to(normalizedRoomId).emit('user-list', Object.values(room.users));
      io.to(normalizedRoomId).emit('chat-update', room.chat);
    } catch (err) {
      console.error('join-room error:', err.message);
      socket.emit('room-error', 'Failed to join room');
    }
  });

  socket.on('add-song', ({ roomId, song }) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !song) return;
      touchRoom(room);
      room.playlist.push({
        id: `${song.videoId}-${Date.now()}`,
        videoId: song.videoId,
        title: song.title,
        addedBy: song.addedBy || 'Guest',
        singer: song.singer || song.addedBy || 'Guest'
      });
      if (!room.current) {
        startNextSong(room);
        io.to(roomId).emit('room-state', roomState(room));
        return;
      }
      io.to(roomId).emit('playlist-updated', room.playlist);
    } catch (err) {
      console.error('add-song error:', err.message);
    }
  });

  socket.on('remove-song', ({ roomId, songId }) => {
    try {
      const room = rooms.get(roomId);
      if (!room) return;
      touchRoom(room);
      const user = room.users[socket.id];
      if (!user) return;
      const target = room.playlist.find((song) => song.id === songId);
      if (!target) return;
      if (!user.isHost && target.addedBy !== user.name) return;
      room.playlist = room.playlist.filter((song) => song.id !== songId);
      io.to(roomId).emit('playlist-updated', room.playlist);
    } catch (err) {
      console.error('remove-song error:', err.message);
    }
  });

  socket.on('next-song', ({ roomId }) => {
    try {
      const room = rooms.get(roomId);
      if (!room) return;
      touchRoom(room);
      const user = room.users[socket.id];
      if (!user?.isHost) return;
      startNextSong(room);
      io.to(roomId).emit('room-state', roomState(room));
    } catch (err) {
      console.error('next-song error:', err.message);
    }
  });

  socket.on('stop-play', ({ roomId }) => {
    try {
      const room = rooms.get(roomId);
      if (!room) return;
      touchRoom(room);
      const user = room.users[socket.id];
      if (!user?.isHost) return;
      room.current = null;
      room.bannerVisible = false;
      io.to(roomId).emit('room-state', roomState(room));
    } catch (err) {
      console.error('stop-play error:', err.message);
    }
  });

  socket.on('trigger-emoji', ({ roomId, emoji }) => {
    try {
      const room = rooms.get(roomId);
      if (!room) return;
      touchRoom(room);
      const user = room.users[socket.id];
      if (!user) return;
      io.to(roomId).emit('emoji-rain', emoji);
    } catch (err) {
      console.error('trigger-emoji error:', err.message);
    }
  });

  socket.on('edit-singer', ({ roomId, songId, singer }) => {
    try {
      const room = rooms.get(roomId);
      if (!room) return;
      touchRoom(room);
      const user = room.users[socket.id];
      if (!user?.isHost) return;
      const target = room.playlist.find((song) => song.id === songId);
      if (!target) return;
      target.singer = singer?.trim() || target.addedBy || 'Guest';
      io.to(roomId).emit('playlist-updated', room.playlist);
    } catch (err) {
      console.error('edit-singer error:', err.message);
    }
  });

  socket.on('request-next', ({ roomId }) => {
    try {
      const room = rooms.get(roomId);
      if (!room) return;
      touchRoom(room);
      const user = room.users[socket.id];
      if (!user?.isHost) return;
      startNextSong(room);
      io.to(roomId).emit('room-state', roomState(room));
    } catch (err) {
      console.error('request-next error:', err.message);
    }
  });

  socket.on('send-chat', ({ roomId, message }) => {
    try {
      const room = rooms.get(roomId);
      const user = room?.users[socket.id];
      if (!room || !user) return;
      touchRoom(room);
      const chatItem = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: user.name,
        message: message.trim(),
        timestamp: Date.now()
      };
      room.chat.push(chatItem);
      if (room.chat.length > 100) room.chat.shift();
      io.to(roomId).emit('chat-update', room.chat);
    } catch (err) {
      console.error('send-chat error:', err.message);
    }
  });

  socket.on('disconnect', () => {
    try {
      for (const room of rooms.values()) {
        if (room.users[socket.id]) {
          delete room.users[socket.id];
          if (room.hostId === socket.id) {
            const remaining = Object.keys(room.users);
            room.hostId = remaining.length ? remaining[0] : null;
            if (room.hostId && room.users[room.hostId]) {
              room.users[room.hostId].isHost = true;
            }
          }
          if (Object.keys(room.users).length === 0) {
            touchRoom(room);
            continue;
          }
          io.to(room.id).emit('user-list', Object.values(room.users));
          io.to(room.id).emit('room-state', roomState(room));
        }
      }
    } catch (err) {
      console.error('disconnect error:', err.message);
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (Object.keys(room.users).length === 0 && now - room.lastActiveAt >= ROOM_INACTIVITY_MS) {
      rooms.delete(room.id);
      saveRoomsSoon();
    }
  }
  // Cleanup expired cache entries
  cleanupCache(searchCache, MAX_CACHE_SIZE);
  cleanupCache(videoValidationCache, MAX_CACHE_SIZE);
}, 10 * 60 * 1000).unref();

// Global error handlers to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  // Don't exit on error - allow the server to continue running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason, 'Promise:', promise);
  // Don't exit on error - allow the server to continue running
});

process.on('warning', (warning) => {
  console.warn('WARNING:', warning.name, warning.message);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`IDS R06 Karaoke server running on port ${PORT}`);
});
