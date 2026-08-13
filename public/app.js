const socket = io();
const roomId = decodeURIComponent(window.location.pathname).split('/').filter(Boolean).pop().toUpperCase().replace(/[^A-Z0-9]/g, '');
const nameModal = document.getElementById('nameModal');
const nameInput = document.getElementById('nameInput');
const joinBtn = document.getElementById('joinBtn');
const currentTitle = document.getElementById('currentTitle');
const playlistEl = document.getElementById('playlist');
const viralList = document.getElementById('viralList');
const searchInput = document.getElementById('searchInput');
const searchButton = document.getElementById('searchButton');
const suggestionsEl = document.getElementById('searchSuggestions');
const banner = document.getElementById('banner');
const videoFrame = document.getElementById('videoFrame');
const qrCode = document.getElementById('qrCode');
const shareLinkBtn = document.getElementById('shareLinkBtn');
const userListEl = document.getElementById('userList');
const chatList = document.getElementById('chatList');
const chatInput = document.getElementById('chatInput');
const sendChat = document.getElementById('sendChat');
const nextBtn = document.getElementById('nextBtn');
const stopBtn = document.getElementById('stopBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const emojiButtons = document.querySelectorAll('.emoji-btn');
const videoOverlay = document.querySelector('.video-overlay');

let userName = localStorage.getItem('idsR06Name') || '';
let ytPlayer = null;
let youtubeReady = false;
let pendingVideoId = null;
let scoreDismissTimer = null;
let userIsHost = false;
let currentRoom = null;
let currentSong = null;
let joining = false;
let connectionAttempts = 0;
let joinTimeout = null;
const MAX_CONNECTION_ATTEMPTS = 5;

let viralSongs = [];
let oldSongs = [];
let duetSongs = [];
let searchResults = [];
let pendingAdds = new Set();
let currentPlaylist = [];
let pendingTimeouts = new Map();
let viralLimit = 12;
let oldLimit = 12;
let duetLimit = 12;
let duetRefresh = 0;
let searchLimit = 12;
let activeSearchQuery = 'karaoke';
let searchController = null;
let suggestionsController = null;
let suggestionTimer = null;
let autoAdvancePending = false;

function setShareLink() {
  const shareUrl = `${window.location.origin}/room/${roomId}`;
  const roomCodeDisplay = document.getElementById('roomCodeDisplay');
  if (roomCodeDisplay) roomCodeDisplay.textContent = roomId;
  qrCode.src = `/qr/${roomId}`;
  const linkInput = document.getElementById('roomLinkInput');
  if (linkInput) {
    linkInput.value = shareUrl;
  }
  shareLinkBtn.textContent = 'Copy';
  shareLinkBtn.onclick = async () => {
    await navigator.clipboard.writeText(shareUrl).catch(() => null);
    shareLinkBtn.textContent = 'Copied!';
    setTimeout(() => {
      shareLinkBtn.textContent = 'Copy';
    }, 1600);
  };
}

function showModal() {
  nameModal.style.display = 'flex';
  nameInput.focus();
}

function hideModal() {
  nameModal.style.display = 'none';
}

function safeText(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span.innerHTML;
}

function setHostControls() {
  nextBtn.style.display = userIsHost ? '' : 'none';
  stopBtn.style.display = userIsHost ? '' : 'none';
  fullscreenBtn.style.display = userIsHost ? '' : 'none';
  nextBtn.title = userIsHost ? 'Host only control' : 'Participants cannot skip';
  stopBtn.title = userIsHost ? 'Host only control' : 'Participants cannot stop';
}

function renderPlaylist(playlist) {
  currentPlaylist = playlist || [];
  playlistEl.innerHTML = '';
  if (!playlist.length) {
    playlistEl.innerHTML = '<div class="song-card"><div class="song-copy"><strong>No reserved songs yet</strong><span>Search for karaoke videos to add.</span></div></div>';
    return;
  }
  // determine which song is next (for label)
  let nextVideoId = null;
  try {
    if (currentSong) {
      const idx = currentPlaylist.findIndex((i) => i.videoId === currentSong.videoId);
      if (idx >= 0 && idx + 1 < currentPlaylist.length) nextVideoId = currentPlaylist[idx + 1].videoId;
    }
  } catch (e) {}
  playlist.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'song-card';
    const canRemove = userIsHost || item.addedBy === userName;
    const singerLabel = item.singer ? `<span class="playlist-singer">Singer: ${safeText(item.singer)}</span>` : '';
    const playingLabel = (currentSong && item.videoId === currentSong.videoId) ? `<span class="playing-label">Playing</span>` : '';
    const upnextLabel = (nextVideoId && item.videoId === nextVideoId) ? `<span class="upnext-label">Up next</span>` : '';
    card.innerHTML = `
      <div class="song-copy">
        <strong>${safeText(item.title)}</strong>
        <span>requested by ${safeText(item.addedBy || 'Guest')}</span>
        ${singerLabel}
        <div style="display: flex; gap: 8px; margin-top: 6px;">
          ${playingLabel}
          ${upnextLabel}
        </div>
      </div>
      <div class="song-card-meta"></div>
    `;
    if (currentSong && item.videoId === currentSong.videoId) card.classList.add('playing');
    const meta = card.querySelector('.song-card-meta');
    if (userIsHost) {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-secondary';
      editBtn.textContent = 'Edit Singer';
      editBtn.addEventListener('click', () => {
        const newSinger = prompt('Edit singer name', item.singer || item.addedBy || '');
        if (newSinger !== null) {
          socket.emit('edit-singer', { roomId, songId: item.id, singer: newSinger.trim() });
        }
      });
      meta.appendChild(editBtn);
    }
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-secondary';
    removeBtn.textContent = canRemove ? 'Remove' : 'Added';
    removeBtn.disabled = !canRemove;
    removeBtn.addEventListener('click', () => {
      if (canRemove) {
        socket.emit('remove-song', { roomId, songId: item.id });
      }
    });
    meta.appendChild(removeBtn);
    playlistEl.appendChild(card);
  });
}

function renderUsers(users) {
  userListEl.innerHTML = '';
  users.forEach((user) => {
    const chip = document.createElement('div');
    chip.className = 'user-chip';
    chip.innerHTML = `<strong>${safeText(user.name)}</strong><span>${user.isHost ? 'Host' : 'Participant'}</span>`;
    userListEl.appendChild(chip);
  });
}

function isSongAdded(videoId) {
  return currentPlaylist.some((item) => item.videoId === videoId);
}

function makeSongCard(song, options = {}) {
  const isAdded = isSongAdded(song.videoId);
  const isPending = pendingAdds.has(song.videoId);
  const card = document.createElement('div');
  card.className = 'song-card';
  const singerInput = options.allowSinger ? `<input class="singer-name-input" placeholder="Singer name (optional)" value="${safeText(userName)}" />` : '';
  const actionButton = isAdded ? `<span class="added-label">Added</span>` : (isPending ? `<span class="added-label">Reserving...</span>` : `<button class="btn btn-secondary small">Add</button>`);
  card.innerHTML = `
    <img src="${safeText(song.thumbnail)}" alt="${safeText(song.title)}" loading="lazy" decoding="async" />
    <div class="song-copy">
      <strong>${safeText(song.title)}</strong>
      <span>Youtube karaoke</span>
    </div>
    ${singerInput}
    <div class="song-card-meta">${actionButton}</div>
  `;
  if (!isAdded && !isPending) {
    const button = card.querySelector('button');
    button.addEventListener('click', () => {
      const singer = options.allowSinger ? card.querySelector('.singer-name-input').value.trim() || userName : userName;
      // mark pending locally and update UI
      pendingAdds.add(song.videoId);
      const meta = card.querySelector('.song-card-meta');
      if (meta) meta.innerHTML = '<span class="added-label">Reserving...</span>';
      addSong({ ...song, singer });
    });
  }
  return card;
}

function notify(text, timeout = 2200) {
  let t = document.getElementById('toastNotify');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toastNotify';
    t.className = 'toast-notify';
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.classList.add('visible');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('visible'), timeout);
}

function renderSearchResults(results) {
  searchResults = results || [];
  const searchResultsEl = document.getElementById('searchResults');
  searchResultsEl.innerHTML = '';
  if (!results.length) {
    searchResultsEl.innerHTML = '<div class="song-card"><strong>No search results found.</strong></div>';
    return;
  }
  results.forEach((song) => {
    searchResultsEl.appendChild(makeSongCard(song, { allowSinger: true }));
  });
}

function renderViralSongs() {
  const viralContainer = document.getElementById('viralList');
  viralContainer.innerHTML = '';
  if (!viralSongs.length) {
    viralContainer.innerHTML = '<div class="song-card"><strong>Loading viral karaoke...</strong></div>';
    return;
  }
  viralSongs.forEach((song) => {
    viralContainer.appendChild(makeSongCard(song));
  });
}

function renderOldSongs() {
  const oldContainer = document.getElementById('oldSongsList');
  oldContainer.innerHTML = '';
  if (!oldSongs.length) {
    oldContainer.innerHTML = '<div class="song-card"><strong>Loading old karaoke hits...</strong></div>';
    return;
  }
  oldSongs.forEach((song) => {
    oldContainer.appendChild(makeSongCard(song));
  });
}

function renderDuetSongs() {
  const duetContainer = document.getElementById('duetSongsList');
  duetContainer.innerHTML = '';
  if (!duetSongs.length) {
    duetContainer.innerHTML = '<div class="song-card"><strong>Loading duet karaoke...</strong></div>';
    return;
  }
  duetSongs.forEach((song) => {
    duetContainer.appendChild(makeSongCard(song));
  });
}

function renderChat(chat) {
  chatList.innerHTML = '';
  chat.slice(-40).forEach((item) => {
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    if (item.name === userName) bubble.classList.add('me');
    const time = item.ts ? new Date(item.ts) : new Date();
    const hh = time.getHours().toString().padStart(2, '0');
    const mm = time.getMinutes().toString().padStart(2, '0');
    const stamp = `${hh}:${mm}`;
    const reactions = item.reactions || {};
    const reactionHtml = Object.keys(reactions).length ?
      `<div class="reactions">${Object.entries(reactions).map(([emo, users]) => `<span class="reaction-pill">${emo} ${users.length}</span>`).join('')}</div>` : '';
    bubble.innerHTML = `
      <div class="chat-head"><strong>${safeText(item.name)}</strong><span class="chat-time">${stamp}</span></div>
      <div class="chat-msg">${safeText(item.message)}</div>
      ${reactionHtml}
      <div class="chat-reactors">
        <button class="react-emoji">👍</button>
        <button class="react-emoji">😂</button>
        <button class="react-emoji">❤️</button>
        <button class="react-emoji">🔥</button>
      </div>
    `;
    // attach reaction handlers
    bubble.querySelectorAll('.react-emoji').forEach((btn) => {
      btn.addEventListener('click', () => {
        const emo = btn.textContent.trim();
        if (!item.id) {
          notify('Unable to react to this message');
          return;
        }
        socket.emit('react-message', { roomId, messageId: item.id, emoji: emo });
      });
    });
    chatList.appendChild(bubble);
  });
  chatList.scrollTop = chatList.scrollHeight;
}

function updateCurrent(current) {
  if (scoreDismissTimer) {
    clearTimeout(scoreDismissTimer);
    scoreDismissTimer = null;
  }

  const participantPlaceholder = document.querySelector('#playerContainer .video-placeholder');
  const isCurrentSongAlreadyRendered = current && currentSong?.id === current.id && document.getElementById('playerContainer') &&
    ((userIsHost && ytPlayer) || (!userIsHost && !ytPlayer && participantPlaceholder));
  currentSong = current;
  if (isCurrentSongAlreadyRendered) {
    currentTitle.textContent = current.title;
    return;
  }
  if (!current) {
    if (ytPlayer?.destroy) ytPlayer.destroy();
    ytPlayer = null;
    currentTitle.textContent = 'Waiting for host to start';
    videoFrame.innerHTML = '<div class="video-placeholder">Host will start the karaoke video soon.</div>';
    return;
  }
  currentTitle.textContent = current.title;

  // The player is tied to its container. Destroy it before replacing the
  // container so the next reserved song always receives a live player.
  if (ytPlayer?.destroy) ytPlayer.destroy();
  ytPlayer = null;

  const emojis = getScoreEmojis(current.score);
  videoFrame.innerHTML = `
    ${userIsHost ? '<div class="host-watermark" aria-hidden="true">Ultra Karaoke</div>' : ''}
    <div class="score-panel" id="scorePanel">
      <h3>Stage applause!</h3>
      <div class="score-value">${current.score}</div>
      <p class="score-comment">${getScoreComment(current.score)}</p>
      <div class="score-emojis">${emojis.map((emoji) => `<span>${safeText(emoji)}</span>`).join('')}</div>
    </div>
    <div id="playerContainer"></div>
  `;

  const scorePanel = document.getElementById('scorePanel');
  if (scorePanel) {
    scorePanel.classList.remove('visible');
    scorePanel.style.opacity = '0';
  }

  pendingVideoId = current.videoId;
  if (youtubeReady && userIsHost) {
    loadKaraokeVideo(current.videoId);
  } else if (userIsHost) {
    ensureYouTubeApi();
  } else if (!userIsHost) {
    const placeholder = document.getElementById('playerContainer');
    if (placeholder) {
      placeholder.innerHTML = '<div class="video-placeholder">Host controls the karaoke stage. Add songs or cheer with emojis.</div>';
    }
  }
  showBanner();
}

function ensureYouTubeApi() {
  if (youtubeReady || document.getElementById('youtubeIframeApi')) return;
  const script = document.createElement('script');
  script.id = 'youtubeIframeApi';
  script.src = 'https://www.youtube.com/iframe_api';
  script.async = true;
  document.head.appendChild(script);
}

function getScoreComment(score) {
  if (score >= 95) return 'Legendary performance — the crowd is cheering!';
  if (score >= 90) return 'Amazing delivery — you nailed every note.';
  if (score >= 85) return 'Fantastic stage presence and vocal energy.';
  if (score >= 80) return 'Great job — your karaoke shines!';
  return 'Sweet voice — you brought the song to life.';
}

function getScoreEmojis(score) {
  if (score >= 95) return ['🎤', '✨', '🔥'];
  if (score >= 90) return ['🎉', '💖', '🌟'];
  if (score >= 85) return ['👏', '🎶', '😊'];
  if (score >= 80) return ['👍', '🎵', '💫'];
  return ['💖', '🎤', '🌈'];
}

function createOrUpdatePlayer(videoId) {
  if (ytPlayer && ytPlayer.loadVideoById) {
    ytPlayer.loadVideoById({ videoId, startSeconds: 0, suggestedQuality: 'large', autoplay: 1 });
    return;
  }
  ytPlayer = new YT.Player('playerContainer', {
    height: '100%',
    width: '100%',
    videoId,
    playerVars: {
      autoplay: 1,
      controls: 0,
      disablekb: 1,
      modestbranding: 1,
      rel: 0,
      playsinline: 1,
      mute: 1,
      // Never request YouTube closed captions/subtitles for karaoke playback.
      cc_load_policy: 0,
      cc_lang_pref: ''
    },
    events: {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange,
      onError: onPlayerError,
      onApiChange: onPlayerApiChange
    }
  });
}

function loadKaraokeVideo(videoId) {
  if (!window.YT || !youtubeReady) {
    pendingVideoId = videoId;
    return;
  }
  createOrUpdatePlayer(videoId);
}

function onPlayerReady(event) {
  disableYouTubeCaptions(event.target);
  event.target.mute();
  event.target.playVideo();
  try {
    event.target.setVolume(100);
    event.target.unMute();
  } catch (err) {
    // autoplay policy may prevent unmute; keep the video playing muted instead.
  }
  if (pendingVideoId) {
    pendingVideoId = null;
  }
}

function disableYouTubeCaptions(player) {
  try {
    // Unload YouTube's optional captions module even when the viewer's
    // YouTube preference would normally enable it.
    player.unloadModule('captions');
  } catch (err) {
    // The captions module is not available for every video.
  }
}

function onPlayerApiChange() {
  disableYouTubeCaptions(ytPlayer);
}

function advanceToNextSong(delay = 0) {
  if (!userIsHost || autoAdvancePending) return;
  autoAdvancePending = true;
  setTimeout(() => {
    socket.emit('next-song', { roomId });
  }, delay);
}

function onPlayerError() {
  notify('This YouTube video cannot play here. Skipping to the next song.');
  advanceToNextSong(800);
}

function showScoreOverlay() {
  const scorePanel = document.getElementById('scorePanel');
  if (!scorePanel) return;
  scorePanel.classList.add('visible');
  scorePanel.style.opacity = '1';
  triggerScoreBurst();
}

function hideScoreOverlay() {
  const scorePanel = document.getElementById('scorePanel');
  if (!scorePanel) return;
  scorePanel.classList.remove('visible');
  scorePanel.style.opacity = '0';
}

function triggerScoreBurst() {
  const scorePanel = document.getElementById('scorePanel');
  if (!scorePanel) return;
  for (const emo of scorePanel.querySelectorAll('.score-emojis span')) {
    const burst = document.createElement('span');
    burst.textContent = emo.textContent;
    burst.style.position = 'absolute';
    burst.style.left = `${50 + (Math.random() * 24 - 12)}%`;
    burst.style.top = '50%';
    burst.style.fontSize = `${18 + Math.random() * 14}px`;
    burst.style.opacity = '1';
    burst.style.transform = 'translate(-50%, -50%) scale(0.9)';
    burst.style.transition = 'transform 1.4s ease-out, opacity 1.4s ease-out';
    scorePanel.appendChild(burst);
    requestAnimationFrame(() => {
      burst.style.transform = `translate(-50%, -180%) scale(1.2)`;
      burst.style.opacity = '0';
    });
    setTimeout(() => burst.remove(), 1400);
  }
}

function onPlayerStateChange(event) {
  if (event.data === YT.PlayerState.PLAYING) disableYouTubeCaptions(event.target);
  if (event.data === YT.PlayerState.ENDED) {
    showScoreOverlay();
    if (scoreDismissTimer) {
      clearTimeout(scoreDismissTimer);
    }
    scoreDismissTimer = setTimeout(() => {
      hideScoreOverlay();
      advanceToNextSong();
    }, 3200);
  }
}

window.onYouTubeIframeAPIReady = () => {
  youtubeReady = true;
  if (pendingVideoId) {
    loadKaraokeVideo(pendingVideoId);
  }
};

function showBanner() {
  const title = currentSong?.title || '';
  const singer = currentSong?.singer ? ` Singer: ${currentSong.singer}` : '';
  banner.textContent = `Now Playing: ${title}${singer}`;
  banner.classList.add('visible');
  setTimeout(() => banner.classList.remove('visible'), 4000);
}

function updateParticipantView() {
  const mainPanel = document.querySelector('main');
  if (!mainPanel) return;
  if (!userIsHost) {
    mainPanel.classList.add('participant-view');
  } else {
    mainPanel.classList.remove('participant-view');
  }
}

function clearScorePanelAfterDelay() {
  setTimeout(() => {
    const scorePanel = document.getElementById('scorePanel');
    if (scorePanel) {
      scorePanel.classList.remove('visible');
      scorePanel.style.transition = 'opacity 0.8s ease';
      scorePanel.style.opacity = '0';
    }
  }, 3200);
}

function addSong(song) {
  if (!song || !song.videoId) return;
  pendingAdds.add(song.videoId);
  const timeoutId = setTimeout(() => {
    pendingAdds.delete(song.videoId);
    pendingTimeouts.delete(song.videoId);
    try { renderSearchResults(searchResults || []); } catch (e) {}
    renderViralSongs();
    renderOldSongs();
    renderDuetSongs();
    renderPlaylist(currentPlaylist || []);
  }, 8000);
  pendingTimeouts.set(song.videoId, timeoutId);
  socket.emit('add-song', {
    roomId,
    song: {
      videoId: song.videoId,
      title: song.title,
      addedBy: userName,
      singer: song.singer || userName
    }
  });
}

async function fetchSearch(query, limit = 12) {
  if (!query) {
    await fetchViralSongs();
    return;
  }
  const searchResultsEl = document.getElementById('searchResults');
  if (searchResultsEl) searchResultsEl.innerHTML = '<div class="song-card"><strong>Searching…</strong></div>';
  if (searchButton) searchButton.disabled = true;
  if (searchController) searchController.abort();
  const controller = new AbortController();
  searchController = controller;
  activeSearchQuery = query;
  searchLimit = limit;
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`, { signal: controller.signal });
    if (!response.ok) {
      if (searchButton) searchButton.disabled = false;
      await fetchViralSongs();
      return;
    }
    const results = await response.json();
    suggestionsEl.innerHTML = '';
    renderSearchResults(results);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.warn('Search failed', err);
    await fetchViralSongs();
  } finally {
    if (searchController === controller && searchButton) searchButton.disabled = false;
  }
}

async function fetchViralSongs() {
  viralSongs = [];
  renderViralSongs();
  const response = await fetch(`/api/viral?limit=${viralLimit}&room=${encodeURIComponent(roomId)}`);
  if (!response.ok) {
    viralList.innerHTML = '<div class="song-card"><strong>Unable to load viral karaoke.</strong></div>';
    return;
  }
  viralSongs = await response.json();
  renderViralSongs();
}

async function fetchOldSongs() {
  oldSongs = [];
  renderOldSongs();
  const response = await fetch(`/api/old-songs?limit=${oldLimit}&room=${encodeURIComponent(roomId)}`);
  if (!response.ok) {
    oldSongs = [];
    renderOldSongs();
    return;
  }
  oldSongs = await response.json();
  renderOldSongs();
}

async function fetchDuetSongs() {
  duetSongs = [];
  renderDuetSongs();
  const response = await fetch(`/api/duet-songs?limit=${duetLimit}&room=${encodeURIComponent(roomId)}&refresh=${duetRefresh}`);
  if (!response.ok) {
    duetSongs = [];
    renderDuetSongs();
    return;
  }
  duetSongs = await response.json();
  renderDuetSongs();
}

function setActiveTab(tabName) {
  const tabs = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel');
  tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabName));
  panels.forEach((panel) => panel.classList.toggle('hide-panel', panel.id !== `${tabName}Panel`));
  if (tabName === 'viral' && !viralSongs.length) {
    fetchViralSongs();
    fetchOldSongs();
  }
  if (tabName === 'duet' && !duetSongs.length) fetchDuetSongs();
}

function triggerEmojiEffect(emoji) {
  const container = document.createElement('div');
  container.style.position = 'absolute';
  container.style.inset = '0';
  container.style.pointerEvents = 'none';
  container.style.overflow = 'hidden';
  videoFrame.appendChild(container);
  const count = 20;
  for (let i = 0; i < count; i += 1) {
    const drop = document.createElement('div');
    drop.textContent = emoji;
    drop.style.position = 'absolute';
    drop.style.left = `${20 + Math.random() * 60}%`;
    drop.style.top = `${80 + Math.random() * 20}%`;
    drop.style.fontSize = `${20 + Math.random() * 18}px`;
    drop.style.opacity = '0.95';
    drop.style.transform = `translateY(0px) rotate(${Math.random() * 90 - 45}deg)`;
    drop.style.transition = `transform 2.2s ease-out, opacity 1.2s ease-out`;
    container.appendChild(drop);
    requestAnimationFrame(() => {
      drop.style.transform = `translateY(-${120 + Math.random() * 80}px) rotate(${Math.random() * 140 - 70}deg)`;
      drop.style.opacity = '0';
    });
  }
  setTimeout(() => container.remove(), 2500);
}

function setupListeners() {
  shareLinkBtn.addEventListener('click', setShareLink);
  sendChat.addEventListener('click', () => {
    const message = chatInput.value.trim();
    if (!message) return;
    socket.emit('send-chat', { roomId, message });
    chatInput.value = '';
  });
  chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') sendChat.click();
  });
  nextBtn.addEventListener('click', () => socket.emit('next-song', { roomId }));
  stopBtn.addEventListener('click', () => socket.emit('stop-play', { roomId }));
  fullscreenBtn.addEventListener('click', async () => {
    const target = videoFrame;
    if (target.requestFullscreen) {
      await target.requestFullscreen();
    }
  });
  emojiButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const emoji = button.dataset.emoji;
      socket.emit('trigger-emoji', { roomId, emoji });
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.fullscreenElement) {
      document.exitFullscreen();
    }
  });
  searchButton.addEventListener('click', () => {
    const query = searchInput.value.trim();
    if (!query) return;
    fetchSearch(query, 12);
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      searchButton.click();
    }
  });
  searchInput.addEventListener('input', () => {
    const query = searchInput.value.trim();
    clearTimeout(suggestionTimer);
    if (suggestionsController) suggestionsController.abort();
    if (!query) {
      suggestionsEl.innerHTML = '';
      return;
    }
    suggestionTimer = setTimeout(async () => {
      suggestionsController = new AbortController();
      try {
        const response = await fetch(`/api/suggestions?q=${encodeURIComponent(query)}`, { signal: suggestionsController.signal });
        if (!response.ok) return;
        const suggestions = await response.json();
        if (searchInput.value.trim() !== query) return;
        suggestionsEl.innerHTML = '';
        suggestions.slice(0, 6).forEach((text) => {
          const item = document.createElement('div');
          item.className = 'search-suggestion';
          item.innerHTML = `<span>${safeText(text)}</span>`;
          item.addEventListener('click', () => {
            searchInput.value = text;
            searchButton.click();
          });
          suggestionsEl.appendChild(item);
        });
      } catch (err) {
        if (err.name !== 'AbortError') console.warn('Suggestions failed', err);
      }
    }, 300);
  });
  const tabButtons = document.querySelectorAll('.tab-btn');
  tabButtons.forEach((button) => {
    button.addEventListener('click', () => setActiveTab(button.dataset.tab));
  });
  setActiveTab('viral');
  const refreshViralBtn = document.getElementById('refreshViralBtn');
  const loadMoreViralBtn = document.getElementById('loadMoreViralBtn');
  const loadMoreSearchBtn = document.getElementById('loadMoreSearchBtn');
  const loadMoreDuetBtn = document.getElementById('loadMoreDuetBtn');
  const refreshDuetBtn = document.getElementById('refreshDuetBtn');
  loadMoreSearchBtn?.addEventListener('click', () => {
    fetchSearch(activeSearchQuery || 'karaoke', Math.min(30, searchLimit + 6));
  });
  refreshViralBtn?.addEventListener('click', async () => {
    await fetchViralSongs();
  });
  loadMoreViralBtn?.addEventListener('click', async () => {
    viralLimit = Math.min(30, viralLimit + 6);
    await fetchViralSongs();
  });
  loadMoreDuetBtn?.addEventListener('click', async () => {
    duetLimit = Math.min(30, duetLimit + 6);
    await fetchDuetSongs();
  });
  refreshDuetBtn?.addEventListener('click', async () => {
    duetRefresh += 1;
    await fetchDuetSongs();
  });
}

function clearJoinTimeout() {
  if (joinTimeout) {
    clearTimeout(joinTimeout);
    joinTimeout = null;
  }
}

function scheduleJoinTimeout() {
  clearJoinTimeout();
  joinTimeout = setTimeout(() => {
    if (joining) {
      notify('Room join is taking longer than expected...');
    }
  }, 5000);
}

function emitJoin() {
  joining = true;
  scheduleJoinTimeout();
  socket.emit('join-room', { roomId, name: userName });
}

joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) return;
  userName = name;
  localStorage.setItem('idsR06Name', userName);
  hideModal();
  if (socket.connected) {
    emitJoin();
  } else {
    joining = true;
  }
});

socket.on('connect', () => {
  connectionAttempts = 0;
  if (userName) {
    hideModal();
    emitJoin();
  } else {
    showModal();
  }
});

socket.on('room-state', (state) => {
  clearJoinTimeout();
  joining = false;
  autoAdvancePending = false;
  currentRoom = state;
  const wasHost = userIsHost;
  userIsHost = state.hostId === socket.id;
  if (wasHost && !userIsHost && ytPlayer?.destroy) {
    ytPlayer.destroy();
    ytPlayer = null;
  }
  setHostControls();
  updateParticipantView();
  renderPlaylist(state.playlist);
  renderUsers(state.users);
  renderChat(state.chat);
  updateCurrent(state.current);
});

socket.on('room-error', (message) => {
  clearJoinTimeout();
  joining = false;
  alert(message);
  window.location.href = '/';
});

socket.on('connect_error', () => {
  connectionAttempts += 1;
  if (connectionAttempts >= MAX_CONNECTION_ATTEMPTS) {
    notify('Connection lost. Please reload the page.');
  }
});

socket.on('disconnect', () => {
  notify('Disconnected from server. Trying to reconnect...');
});

socket.on('reconnect', () => {
  if (userName) {
    hideModal();
    emitJoin();
  }
});

socket.on('playlist-updated', (playlist) => {
  if (currentRoom) currentRoom = { ...currentRoom, playlist: playlist || [] };
  renderPlaylist(playlist);
  try {
    (playlist || []).forEach((it) => {
      pendingAdds.delete(it.videoId);
      const tid = pendingTimeouts.get(it.videoId);
      if (tid) {
        clearTimeout(tid);
        pendingTimeouts.delete(it.videoId);
      }
    });
  } catch (e) {}
  try { renderSearchResults(searchResults || []); } catch (e) {}
  renderViralSongs();
  renderOldSongs();
  renderDuetSongs();
});

setShareLink();
setupListeners();
fetchSearch('karaoke', 12);
