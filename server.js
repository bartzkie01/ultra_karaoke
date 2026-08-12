const path = require('path');
const express = require('express');
const http = require('http');
const vm = require('vm');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map();

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
    chat: []
  };
  rooms.set(id, room);
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

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';

async function fetchYouTubeApi(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Accept: 'application/json'
    }
  });
  if (!response.ok) {
    throw new Error(`YouTube API request failed with ${response.status}`);
  }
  return await response.json();
}

function isKaraokeTitle(title) {
  const lower = title.toLowerCase();
  return lower.includes('karaoke') || lower.includes('カラオケ') || lower.includes('karaoké');
}

async function verifyYouTubeVideo(videoId) {
  if (!videoId) return false;
  const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Accept: 'application/json'
      }
    });
    return response.ok;
  } catch (err) {
    return false;
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
        thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || `https://i.ytimg.com/vi/${item.id.videoId}/hqdefault.jpg`
      };
    })
    .filter((item) => isKaraokeTitle(item.title));
}

async function verifySearchResults(items) {
  const candidates = items.slice(0, 16);
  const results = await Promise.allSettled(
    candidates.map(async (item) => {
      const valid = await verifyYouTubeVideo(item.videoId);
      return valid ? item : null;
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
  const roomId = req.params.roomId;
  const baseUrl = `${req.protocol}://${req.get('host')}`;
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
  function collectVideoRenderers(node) {
    if (!node || typeof node !== 'object') return;
    if (node.videoRenderer?.videoId) {
      foundVideos.push(node.videoRenderer);
    }
    for (const key of Object.keys(node)) {
      collectVideoRenderers(node[key]);
    }
  }

  collectVideoRenderers(data);

  const items = foundVideos
    .map((video) => {
      const title = video.title?.runs?.map((run) => run.text).join('') || video.title?.simpleText || '';
      const thumbnails = video.thumbnail?.thumbnails || [];
      return {
        videoId: video.videoId,
        title: title.trim(),
        thumbnail: thumbnails[thumbnails.length - 1]?.url || `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`
      };
    })
    .filter((item) => isKaraokeTitle(item.title));

  return items;
}

app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) {
    res.json([]);
    return;
  }
  const searchPhrase = `${query} karaoke`;
  try {
    if (YOUTUBE_API_KEY) {
      const encoded = encodeURIComponent(searchPhrase);
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encoded}&maxResults=16&key=${YOUTUBE_API_KEY}`;
      const apiData = await fetchYouTubeApi(url);
      let results = mapSearchItems(apiData.items || []);
      const stats = await fetchYouTubeViews(results.map((item) => item.videoId));
      results = sortByViewCount(results, stats).slice(0, 12);
      const verified = await verifySearchResults(results);
      res.json(verified.slice(0, 10));
      return;
    }
  } catch (err) {
    console.warn('YouTube API search failed:', err.message);
  }

  const encoded = encodeURIComponent(searchPhrase);
  const url = `https://www.youtube.com/results?search_query=${encoded}`;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Accept: 'text/html'
      }
    });
    const html = await response.text();
    const results = parseYouTubeResults(html);
    const verified = await verifySearchResults(results);
    res.json(verified.slice(0, 8));
  } catch (err) {
    res.json([]);
  }
});

app.get('/api/viral', async (req, res) => {
  const limit = Math.min(20, parseInt(req.query.limit, 10) || 8);
  try {
    if (YOUTUBE_API_KEY) {
      const query = encodeURIComponent('karaoke popular hits');
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${query}&maxResults=${Math.min(limit, 16)}&order=viewCount&key=${YOUTUBE_API_KEY}`;
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

  const query = 'popular karaoke hits';
  const encoded = encodeURIComponent(query);
  const url = `https://www.youtube.com/results?search_query=${encoded}`;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Accept: 'text/html'
      }
    });
    const html = await response.text();
    const results = parseYouTubeResults(html);
    const verified = await verifySearchResults(results);
    res.json(verified.slice(0, limit));
  } catch (err) {
    res.json([]);
  }
});

function sampleSongs(type, limit = 8) {
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
  return (samples[type] || []).slice(0, limit);
}

app.get('/api/old-songs', (req, res) => {
  const limit = Math.min(12, parseInt(req.query.limit, 10) || 6);
  res.json(sampleSongs('old', limit));
});

app.get('/api/duet-songs', (req, res) => {
  const limit = Math.min(12, parseInt(req.query.limit, 10) || 6);
  res.json(sampleSongs('duet', limit));
});

app.get('/api/suggestions', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) {
    res.json([]);
    return;
  }
  const encoded = encodeURIComponent(query);
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encoded}`;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });
    const text = await response.text();
    const data = JSON.parse(text);
    const suggestions = (data[1] || []).filter((item) => typeof item === 'string');
    res.json(suggestions.slice(0, 6));
  } catch (err) {
    res.json([]);
  }
});

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, name }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('room-error', 'Room not found');
      return;
    }

    const isHost = !room.hostId;
    if (isHost) {
      room.hostId = socket.id;
    }

    room.users[socket.id] = {
      id: socket.id,
      name: name || 'Guest',
      isHost
    };

    socket.join(roomId);
    io.to(roomId).emit('room-state', roomState(room));
    io.to(roomId).emit('user-list', Object.values(room.users));
    io.to(roomId).emit('chat-update', room.chat);
  });

  socket.on('add-song', ({ roomId, song }) => {
    const room = rooms.get(roomId);
    if (!room || !song) return;
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
  });

  socket.on('remove-song', ({ roomId, songId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const user = room.users[socket.id];
    if (!user) return;
    const target = room.playlist.find((song) => song.id === songId);
    if (!target) return;
    if (!user.isHost && target.addedBy !== user.name) return;
    room.playlist = room.playlist.filter((song) => song.id !== songId);
    io.to(roomId).emit('playlist-updated', room.playlist);
  });

  socket.on('next-song', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const user = room.users[socket.id];
    if (!user?.isHost) return;
    startNextSong(room);
    io.to(roomId).emit('room-state', roomState(room));
  });

  socket.on('stop-play', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const user = room.users[socket.id];
    if (!user?.isHost) return;
    room.current = null;
    room.bannerVisible = false;
    io.to(roomId).emit('room-state', roomState(room));
  });

  socket.on('trigger-emoji', ({ roomId, emoji }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const user = room.users[socket.id];
    if (!user) return;
    io.to(roomId).emit('emoji-rain', emoji);
  });

  socket.on('edit-singer', ({ roomId, songId, singer }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const user = room.users[socket.id];
    if (!user?.isHost) return;
    const target = room.playlist.find((song) => song.id === songId);
    if (!target) return;
    target.singer = singer?.trim() || target.addedBy || 'Guest';
    io.to(roomId).emit('playlist-updated', room.playlist);
  });

  socket.on('request-next', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const user = room.users[socket.id];
    if (!user?.isHost) return;
    startNextSong(room);
    io.to(roomId).emit('room-state', roomState(room));
  });

  socket.on('send-chat', ({ roomId, message }) => {
    const room = rooms.get(roomId);
    const user = room?.users[socket.id];
    if (!room || !user) return;
    const chatItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: user.name,
      message: message.trim(),
      timestamp: Date.now()
    };
    room.chat.push(chatItem);
    if (room.chat.length > 100) room.chat.shift();
    io.to(roomId).emit('chat-update', room.chat);
  });

  socket.on('disconnect', () => {
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
          rooms.delete(room.id);
          continue;
        }
        io.to(room.id).emit('user-list', Object.values(room.users));
        io.to(room.id).emit('room-state', roomState(room));
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`IDS R06 Karaoke server running on port ${PORT}`);
});
