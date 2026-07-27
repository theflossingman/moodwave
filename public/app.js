let currentPlaylist = [];
let currentPlaylistName = '';
let currentIndex = -1;
let isPlaying = false;
let shuffleOn = false;
let repeatOn = false;
let audio = null;
let selectedSongCount = 20;
let authToken = localStorage.getItem('moodwave_token');
let currentUser = null;

// ─── Auth Helpers ───

function authHeaders() {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

async function apiFetch(url, opts = {}) {
  opts.headers = { ...authHeaders(), ...opts.headers };
  const res = await fetch(url, opts);
  if (res.status === 401) {
    logout();
    throw new Error('Session expired');
  }
  return res;
}

// ─── Init ───

document.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => {
      for (const reg of regs) reg.unregister();
    }).catch(() => {});
  }

  audio = document.getElementById('audioEl');
  audio.addEventListener('timeupdate', onTimeUpdate);
  audio.addEventListener('ended', onTrackEnd);
  audio.addEventListener('loadedmetadata', onMetadataLoaded);

  if (authToken) {
    checkAuth();
  } else {
    showLogin();
  }
});

async function checkAuth() {
  try {
    const res = await apiFetch('/api/auth/whoami');
    if (!res.ok) throw new Error();
    currentUser = await res.json();
    showApp();
  } catch {
    logout();
  }
}

function showLogin() {
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

function showApp() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  const userEl = document.getElementById('sidebarUser');
  userEl.innerHTML = `<span class="user-name">${escHtml(currentUser.username)}</span>${currentUser.isAdmin ? '<span class="user-badge">Admin</span>' : ''}`;

  document.querySelectorAll('.admin-nav-btn').forEach(el => {
    el.classList.toggle('hidden', !currentUser.isAdmin);
  });

  document.getElementById('adminSettingsCard').classList.toggle('hidden', !currentUser.isAdmin);

  loadSettings();
  loadPlaylists();
  loadDailyPlaylist();
}

function logout() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem('moodwave_token');
  showLogin();
}

// ─── Login ───

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errorEl = document.getElementById('loginError');

  errorEl.classList.add('hidden');

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');

    authToken = data.token;
    currentUser = { userId: data.userId, username: data.username, isAdmin: data.isAdmin };
    localStorage.setItem('moodwave_token', authToken);
    showApp();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
}

function handleLogout() {
  logout();
}

// ─── Navigation ───

function switchView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.mobile-nav-btn').forEach(b => b.classList.remove('active'));

  const viewEl = document.getElementById(`view-${view}`);
  const btnEl = document.querySelector(`.nav-btn[data-view="${view}"]`);
  const mobileBtn = document.querySelector(`.mobile-nav-btn[data-view="${view}"]`);
  if (viewEl) viewEl.classList.add('active');
  if (btnEl) btnEl.classList.add('active');
  if (mobileBtn) mobileBtn.classList.add('active');

  if (view === 'playlists') loadPlaylists();
  if (view === 'daily') loadDailyPlaylist();
}

function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  setTimeout(() => { el.className = 'toast'; }, 3000);
}

// ─── Generate ───

async function generatePlaylist() {
  const input = document.getElementById('promptInput');
  const prompt = input.value.trim();
  if (!prompt) return;

  const btn = document.getElementById('generateBtn');
  const result = document.getElementById('generateResult');

  btn.disabled = true;
  result.innerHTML = `
    <div class="generating-indicator">
      <div class="spinner"></div>
      <div class="generating-text">Generating your playlist...</div>
      <div class="generating-sub">Talking to Ollama, searching your library</div>
    </div>
  `;
  result.classList.remove('hidden');

  try {
    const res = await apiFetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, songCount: selectedSongCount }),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error);

    renderPlaylistResult(result, data);
    loadPlaylists();
    toast('Playlist generated!', 'success');
  } catch (err) {
    result.innerHTML = `<div class="empty-state"><p style="color:var(--error)">Error: ${err.message}</p></div>`;
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function quickPrompt(prompt) {
  document.getElementById('promptInput').value = prompt;
  document.getElementById('promptInput').focus();
}

function setSongCount(count) {
  selectedSongCount = count;
  document.querySelectorAll('.count-buttons button').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.count) === count);
  });
}

function renderPlaylistResult(container, playlist) {
  currentPlaylist = playlist.songs;
  currentPlaylistName = playlist.name;

  let songsHtml = '';
  playlist.songs.forEach((song, i) => {
    const dur = formatDuration(song.duration);
    const artUrl = song.albumId ? `/api/cover/${song.albumId}?token=${encodeURIComponent(authToken)}` : '';
    songsHtml += `
      <div class="song-item" onclick="playSong(${i})" data-index="${i}">
        <div class="track-num">${i + 1}</div>
        <img class="track-art" src="${artUrl}" alt="" onerror="this.style.display='none'">
        <div class="track-info">
          <div class="track-name">${escHtml(song.title || 'Unknown')}</div>
          <div class="track-artist">${escHtml(song.artist || 'Unknown')}</div>
        </div>
        <div class="track-duration">${dur}</div>
      </div>
    `;
  });

  const actionBtn = playlist.isDaily
    ? `<button class="btn-primary" onclick="playSong(0)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Play All
      </button>`
    : `<button class="btn-primary" onclick="addPlaylistToNavidrome()" id="addToNavBtn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add to Navidrome
      </button>`;

  container.innerHTML = `
    <div class="playlist-header">
      <div class="playlist-header-info">
        <h2>${escHtml(playlist.name)}</h2>
        <div class="meta">${playlist.songs.length} songs ${playlist.isDaily ? ' | Auto-generated daily' : ''}</div>
      </div>
      <div class="playlist-header-actions">
        ${actionBtn}
      </div>
    </div>
    <div class="song-list">${songsHtml}</div>
  `;
}

async function generateDaily() {
  const result = document.getElementById('dailyResult');
  result.innerHTML = `
    <div class="generating-indicator">
      <div class="spinner"></div>
      <div class="generating-text">Generating today's mix...</div>
      <div class="generating-sub">AI is curating based on the time of day</div>
    </div>
  `;

  try {
    const res = await apiFetch('/api/generate-daily', { method: 'POST' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderPlaylistResult(result, data);
    loadPlaylists();
    toast('Daily mix refreshed!', 'success');
  } catch (err) {
    result.innerHTML = `<div class="empty-state"><p style="color:var(--error)">Error: ${err.message}</p></div>`;
    toast(err.message, 'error');
  }
}

async function loadDailyPlaylist() {
  const result = document.getElementById('dailyResult');
  try {
    const res = await apiFetch('/api/playlists');
    const playlists = await res.json();
    const daily = playlists.find(p => p.isDaily);
    if (daily) {
      renderPlaylistResult(result, daily);
    } else {
      result.innerHTML = `
        <div class="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <p>No daily mix yet. Generate one!</p>
        </div>
      `;
    }
  } catch {
    result.innerHTML = `<div class="empty-state"><p>Connect to Navidrome first</p></div>`;
  }
}

async function loadPlaylists() {
  try {
    const res = await apiFetch('/api/playlists');
    const playlists = await res.json();

    const grid = document.getElementById('playlistsList');
    if (playlists.length === 0) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <p>No playlists yet. Generate one above!</p>
        </div>
      `;
      return;
    }

    grid.innerHTML = playlists.map(p => `
      <div class="playlist-card" onclick="openPlaylist('${p.id}')">
        ${p.isDaily ? '<div class="card-badge">Daily</div>' : ''}
        <h3>${escHtml(p.name)}</h3>
        <div class="card-meta">${p.songs.length} songs <span>| ${timeAgo(p.createdAt)}</span></div>
        <button class="card-delete" onclick="event.stopPropagation();deletePlaylist('${p.id}')" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    `).join('');
  } catch { }
}

async function addPlaylistToNavidrome() {
  const btn = document.getElementById('addToNavBtn');
  if (!btn || currentPlaylist.length === 0) return;

  btn.disabled = true;
  btn.innerHTML = `<div class="spinner" style="width:16px;height:16px;border-width:2px"></div> Adding...`;

  try {
    const songIds = currentPlaylist.map(s => s.id);
    const res = await apiFetch('/api/navidrome-playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: currentPlaylistName, songIds }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Added to Navidrome`;
    btn.className = 'btn-primary btn-synced';
    toast('Playlist added to Navidrome!', 'success');
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add to Navidrome`;
    toast(err.message, 'error');
  }
}

async function openPlaylist(id) {
  try {
    const res = await apiFetch(`/api/playlists/${id}`);
    const playlist = await res.json();
    if (playlist.error) throw new Error(playlist.error);

    switchView('generate');
    const result = document.getElementById('generateResult');
    renderPlaylistResult(result, playlist);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deletePlaylist(id) {
  if (!confirm('Delete this playlist?')) return;
  try {
    await apiFetch(`/api/playlists/${id}`, { method: 'DELETE' });
    loadPlaylists();
    toast('Playlist deleted');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ─── Daily Settings ───

function openDailySettings() {
  document.getElementById('dailySettingsModal').classList.remove('hidden');
  loadDailySettings();
}

function closeDailySettings() {
  document.getElementById('dailySettingsModal').classList.add('hidden');
}

async function loadDailySettings() {
  try {
    const res = await apiFetch('/api/daily-settings');
    const cfg = await res.json();
    document.getElementById('dailySongCount').value = cfg.songCount || 20;
    const hour24 = cfg.generateHour ?? 6;
    const ampm = hour24 >= 12 ? 'PM' : 'AM';
    const hour12 = hour24 === 0 ? 12 : hour24 > 12 ? hour24 - 12 : hour24;
    document.getElementById('dailyGenerateHour').value = hour12;
    document.getElementById('dailyGenerateAmPm').value = ampm;
    document.getElementById('dailyTimezone').value = cfg.timezone || 'America/New_York';
  } catch { }
}

async function saveDailySettings() {
  let hour12 = parseInt(document.getElementById('dailyGenerateHour').value) || 6;
  const ampm = document.getElementById('dailyGenerateAmPm').value;
  if (hour12 < 1) hour12 = 1;
  if (hour12 > 12) hour12 = 12;
  let hour24 = ampm === 'PM' && hour12 !== 12 ? hour12 + 12 : hour12;
  if (ampm === 'AM' && hour12 === 12) hour24 = 0;

  const body = {
    songCount: parseInt(document.getElementById('dailySongCount').value) || 20,
    generateHour: hour24,
    timezone: document.getElementById('dailyTimezone').value,
  };
  try {
    const res = await apiFetch('/api/daily-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    toast('Daily settings saved!', 'success');
    closeDailySettings();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ─── Player ───

function playSong(index) {
  if (index < 0 || index >= currentPlaylist.length) return;

  currentIndex = index;
  const song = currentPlaylist[index];

  audio.src = `/api/stream/${song.id}?token=${encodeURIComponent(authToken)}`;
  audio.play().catch(() => {});
  isPlaying = true;

  document.getElementById('player').classList.remove('hidden');
  document.getElementById('main').classList.add('player-active');
  updatePlayerUI(song);
  highlightCurrent();
  updatePlayPauseIcon();
}

function togglePlay() {
  if (!audio.src) return;
  if (isPlaying) {
    audio.pause();
    isPlaying = false;
  } else {
    audio.play().catch(() => {});
    isPlaying = true;
  }
  updatePlayPauseIcon();
}

function nextTrack() {
  if (currentPlaylist.length === 0) return;

  let next;
  if (shuffleOn) {
    next = Math.floor(Math.random() * currentPlaylist.length);
  } else {
    next = (currentIndex + 1) % currentPlaylist.length;
  }
  playSong(next);
}

function prevTrack() {
  if (currentPlaylist.length === 0) return;
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  let prev = (currentIndex - 1 + currentPlaylist.length) % currentPlaylist.length;
  playSong(prev);
}

function onTrackEnd() {
  if (repeatOn) {
    audio.currentTime = 0;
    audio.play();
  } else {
    nextTrack();
  }
}

function onTimeUpdate() {
  if (!audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  document.getElementById('playerProgressBar').style.width = pct + '%';
  document.getElementById('playerCurrentTime').textContent = formatTime(audio.currentTime);
}

function onMetadataLoaded() {
  document.getElementById('playerTotalTime').textContent = formatTime(audio.duration);
}

function seekTo(e) {
  if (!audio.duration) return;
  const bar = document.getElementById('playerProgress');
  const rect = bar.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  audio.currentTime = pct * audio.duration;
}

function setVolume(val) {
  audio.volume = val / 100;
}

function toggleShuffle() {
  shuffleOn = !shuffleOn;
  document.getElementById('shuffleBtn').classList.toggle('active', shuffleOn);
}

function toggleRepeat() {
  repeatOn = !repeatOn;
  document.getElementById('repeatBtn').classList.toggle('active', repeatOn);
}

function updatePlayerUI(song) {
  document.getElementById('playerTrackName').textContent = song.title || 'Unknown';
  document.getElementById('playerTrackArtist').textContent = song.artist || 'Unknown';

  const artContainer = document.getElementById('playerArt');
  if (song.albumId) {
    artContainer.innerHTML = `<img src="/api/cover/${song.albumId}?token=${encodeURIComponent(authToken)}" alt="" onerror="this.remove()">`;
  } else {
    artContainer.innerHTML = '';
  }
}

function updatePlayPauseIcon() {
  document.getElementById('playIcon').classList.toggle('hidden', isPlaying);
  document.getElementById('pauseIcon').classList.toggle('hidden', !isPlaying);
}

function highlightCurrent() {
  document.querySelectorAll('.song-item').forEach(el => el.classList.remove('playing'));
  const el = document.querySelector(`.song-item[data-index="${currentIndex}"]`);
  if (el) {
    el.classList.add('playing');
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ─── Settings ───

async function loadSettings() {
  try {
    const res = await apiFetch('/api/config');
    const cfg = await res.json();
    document.getElementById('settingNdUrl').value = cfg.navidromeUrl || '';
    document.getElementById('settingNdUser').value = cfg.navidromeUser || '';
    document.getElementById('settingOllamaUrl').value = cfg.ollamaUrl || '';
    document.getElementById('settingOllamaModel').value = cfg.ollamaModel || '';

    applyTheme(cfg.theme);

    if (cfg.hasNavidrome) checkNavidrome();
    if (cfg.hasOllama) checkOllama();
  } catch { }
}

function setTheme(theme) {
  if (theme === 'default') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  document.querySelectorAll('.theme-option').forEach(el => {
    el.classList.toggle('active', el.dataset.themeVal === theme);
  });
  apiFetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme })
  }).catch(() => {});
}

function applyTheme(theme) {
  if (theme && theme !== 'default') {
    document.documentElement.setAttribute('data-theme', theme);
  }
  document.querySelectorAll('.theme-option').forEach(el => {
    el.classList.toggle('active', el.dataset.themeVal === (theme || 'default'));
  });
}

function toggleSection(id) {
  const body = document.getElementById(`section-${id}`);
  const chevron = document.getElementById(`chevron-${id}`);
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open');
  chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
  if (id === 'admin' && !isOpen) loadAdminUsers();
}

async function saveNavidrome() {
  const body = {
    navidromeUrl: document.getElementById('settingNdUrl').value.trim(),
    navidromeUser: document.getElementById('settingNdUser').value.trim(),
    navidromePassword: document.getElementById('settingNdPass').value,
  };
  try {
    await apiFetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    toast('Navidrome settings saved!', 'success');
    checkNavidrome();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function saveOllama() {
  const body = {
    ollamaUrl: document.getElementById('settingOllamaUrl').value.trim(),
    ollamaModel: document.getElementById('settingOllamaModel').value.trim(),
  };
  try {
    await apiFetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    toast('Ollama settings saved!', 'success');
    checkOllama();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function checkNavidrome() {
  const el = document.getElementById('ndStatus');
  el.className = 'status-badge pending';
  el.textContent = 'Checking...';
  try {
    const res = await apiFetch('/api/ping');
    const data = await res.json();
    if (data.ok) {
      el.className = 'status-badge ok';
      el.textContent = `Connected (v${data.version})`;
    } else {
      throw new Error(data.error);
    }
  } catch (err) {
    el.className = 'status-badge err';
    el.textContent = err.message || 'Connection failed';
  }
}

async function checkOllama() {
  const el = document.getElementById('ollamaStatus');
  el.className = 'status-badge pending';
  el.textContent = 'Checking...';
  try {
    const res = await apiFetch('/api/ollama-status');
    const data = await res.json();
    if (data.ok) {
      el.className = 'status-badge ok';
      el.textContent = `Connected (${data.models?.length || 0} models)`;
    } else {
      throw new Error(data.error);
    }
  } catch (err) {
    el.className = 'status-badge err';
    el.textContent = err.message || 'Connection failed';
  }
}

async function changePassword() {
  const current = document.getElementById('currentPassword').value;
  const newPass = document.getElementById('newPassword').value;
  if (!current || !newPass) return toast('Fill in both password fields', 'error');

  try {
    const res = await apiFetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: current, newPassword: newPass }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    toast('Password changed!', 'success');
    document.getElementById('currentPassword').value = '';
    document.getElementById('newPassword').value = '';
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ─── Admin ───

async function loadAdminUsers() {
  try {
    const res = await apiFetch('/api/admin/users');
    const users = await res.json();

    const list = document.getElementById('adminUsersList');
    list.innerHTML = users.map(u => `
      <div class="admin-user-item">
        <div class="admin-user-top">
          <input type="text" class="admin-rename-input" id="rename-${u.id}" value="${escHtml(u.username)}">
          <button class="btn-secondary" style="padding:6px 14px;font-size:0.8rem" onclick="adminRenameUser('${u.id}')">Save</button>
          ${u.id !== currentUser.userId ? `<button class="btn-danger" style="padding:6px 14px;font-size:0.8rem" onclick="adminDeleteUser('${u.id}','${escHtml(u.username)}')">Delete</button>` : ''}
        </div>
        <div class="admin-user-meta">
          ${u.isAdmin ? '<span class="admin-badge">Admin</span>' : ''}
          <span class="user-date">Created ${timeAgo(u.createdAt)}</span>
        </div>
      </div>
    `).join('');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function adminCreateUser() {
  const username = document.getElementById('adminNewUsername').value.trim();
  const password = document.getElementById('adminNewPassword').value;
  if (!username || !password) return toast('Username and password required', 'error');

  try {
    const res = await apiFetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    toast(`User "${username}" created!`, 'success');
    document.getElementById('adminNewUsername').value = '';
    document.getElementById('adminNewPassword').value = '';
    loadAdminUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function adminDeleteUser(userId, username) {
  if (!confirm(`Delete user "${username}"?`)) return;
  try {
    const res = await apiFetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    toast(`User "${username}" deleted`, 'success');
    loadAdminUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function adminRenameUser(userId) {
  const input = document.getElementById(`rename-${userId}`);
  const newUsername = input.value.trim();
  if (!newUsername) return toast('Username cannot be empty', 'error');

  try {
    const res = await apiFetch(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: newUsername }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    toast('User renamed!', 'success');
    if (userId === currentUser.userId) {
      currentUser.username = newUsername;
      document.getElementById('sidebarUser').innerHTML = `<span class="user-name">${escHtml(newUsername)}</span>${currentUser.isAdmin ? '<span class="user-badge">Admin</span>' : ''}`;
    }
    loadAdminUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ─── Utilities ───

function formatDuration(sec) {
  if (!sec) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
