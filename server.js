require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const JWT_SECRET = process.env.JWT_SECRET || 'moodwave-change-this';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const JWT_EXPIRES = '7d';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── User Store ───
function loadUsers() {
  if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  return {};
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function getUserDir(userId) {
  const dir = path.join(DATA_DIR, userId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadUserConfig(userId) {
  const defaults = {
    navidromeUrl: '',
    navidromeUser: '',
    navidromePassword: '',
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'llama3',
    dailySongCount: 20,
    dailyGenerateHour: 6,
    dailyTimezone: 'America/New_York',
  };
  const cfgPath = path.join(getUserDir(userId), 'config.json');
  if (fs.existsSync(cfgPath)) {
    return { ...defaults, ...JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) };
  }
  return defaults;
}

function saveUserConfig(userId, cfg) {
  fs.writeFileSync(path.join(getUserDir(userId), 'config.json'), JSON.stringify(cfg, null, 2));
}

function loadUserPlaylists(userId) {
  const pPath = path.join(getUserDir(userId), 'playlists.json');
  if (fs.existsSync(pPath)) return JSON.parse(fs.readFileSync(pPath, 'utf-8'));
  return [];
}

function saveUserPlaylists(userId, playlists) {
  fs.writeFileSync(path.join(getUserDir(userId), 'playlists.json'), JSON.stringify(playlists, null, 2));
}

// ─── Seed Admin ───
function seedAdmin() {
  const users = loadUsers();
  const adminExists = Object.values(users).some(u => u.isAdmin);
  if (!adminExists) {
    const id = 'admin';
    users[id] = {
      username: 'admin',
      passwordHash: bcrypt.hashSync(ADMIN_PASS, 10),
      isAdmin: true,
      createdAt: new Date().toISOString(),
    };
    saveUsers(users);
    console.log(`[Auth] Admin account seeded (username: admin, password from .env ADMIN_PASS)`);
  }
}

// ─── Auth Middleware ───
function authMiddleware(req, res, next) {
  let token;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    token = header.slice(7);
  } else if (req.query.token) {
    token = req.query.token;
  }
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminMiddleware(req, res, next) {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ─── Subsonic Helpers ───
function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function subsonicAuth(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const token = md5(password + salt);
  return { token, salt };
}

async function subsonicRequest(userCfg, endpoint, params = {}) {
  if (!userCfg.navidromeUrl) throw new Error('Navidrome server not configured');

  const { token, salt } = subsonicAuth(userCfg.navidromePassword);
  const query = new URLSearchParams({
    u: userCfg.navidromeUser,
    t: token,
    s: salt,
    v: '1.16.1',
    c: 'MoodWave',
    f: 'json',
    ...params,
  });

  const url = `${userCfg.navidromeUrl}/rest/${endpoint}?${query}`;
  console.log(`[Subsonic] ${endpoint} -> ${url.replace(/t=[^&]+/, 't=***')}`);

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  } catch (fetchErr) {
    throw new Error(`Cannot reach Navidrome at ${userCfg.navidromeUrl} - ${fetchErr.message}`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Navidrome returned invalid JSON (status ${res.status}). Check your URL includes http://`);
  }

  if (data['subsonic-response']?.status === 'failed') {
    const err = data['subsonic-response'].error;
    throw new Error(`Subsonic ${err?.code || ''}: ${err?.message || 'Unknown error'}`);
  }

  return data['subsonic-response'];
}

// ─── Ollama Helpers ───
async function ollamaGenerate(userCfg, prompt, systemPrompt) {
  if (!userCfg.ollamaUrl) throw new Error('Ollama server not configured');

  const res = await fetch(`${userCfg.ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: userCfg.ollamaModel,
      prompt,
      system: systemPrompt,
      stream: false,
    }),
  });

  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = await res.json();
  return data.response;
}

// ─── Music Helpers ───
async function searchSongs(userCfg, query, count = 50) {
  try {
    const result = await subsonicRequest(userCfg, 'search2', { query, songCount: count });
    const songs = result?.searchResult2?.song || [];
    console.log(`[Search] "${query}" -> ${songs.length} results`);
    return songs;
  } catch (err) {
    console.log(`[Search] "${query}" -> ERROR: ${err.message}`);
    return [];
  }
}

async function getRandomSongs(userCfg, count = 50, genre = '', fromYear = '', toYear = '') {
  const params = { size: count };
  if (genre) params.genre = genre;
  if (fromYear) params.fromYear = fromYear;
  if (toYear) params.toYear = toYear;
  const result = await subsonicRequest(userCfg, 'getRandomSongs', params);
  return result?.randomSongs?.song || [];
}

async function buildTasteProfile(userCfg) {
  const artists = new Map();
  const genres = new Map();
  const decades = new Map();
  const sampleSongs = [];

  try {
    const starred = await subsonicRequest(userCfg, 'getStarred2');
    const songs = starred?.starred2?.song || [];
    for (const song of songs) {
      if (song.artist) artists.set(song.artist, (artists.get(song.artist) || 0) + 3);
      if (song.genre) genres.set(song.genre, (genres.get(song.genre) || 0) + 3);
      if (song.year) {
        const decade = `${Math.floor(song.year / 10) * 10}s`;
        decades.set(decade, (decades.get(decade) || 0) + 2);
      }
      if (sampleSongs.length < 20) sampleSongs.push(song);
    }
    console.log(`[Taste] Starred songs: ${songs.length}`);
  } catch (err) {
    console.log(`[Taste] Starred fetch failed: ${err.message}`);
  }

  try {
    const frequent = await subsonicRequest(userCfg, 'getAlbumList2', { type: 'frequent', size: 30 });
    const albums = frequent?.albumList2?.album || [];
    for (const album of albums) {
      if (album.artist) artists.set(album.artist, (artists.get(album.artist) || 0) + 2);
      if (album.genre) genres.set(album.genre, (genres.get(album.genre) || 0) + 2);
      if (album.year) {
        const decade = `${Math.floor(album.year / 10) * 10}s`;
        decades.set(decade, (decades.get(decade) || 0) + 1);
      }
    }
    console.log(`[Taste] Frequent albums: ${albums.length}`);
  } catch (err) {
    console.log(`[Taste] Frequent fetch failed: ${err.message}`);
  }

  try {
    const recent = await subsonicRequest(userCfg, 'getAlbumList2', { type: 'recent', size: 20 });
    const albums = recent?.albumList2?.album || [];
    for (const album of albums) {
      if (album.artist) artists.set(album.artist, (artists.get(album.artist) || 0) + 1);
      if (album.genre) genres.set(album.genre, (genres.get(album.genre) || 0) + 1);
    }
    console.log(`[Taste] Recent albums: ${albums.length}`);
  } catch (err) {
    console.log(`[Taste] Recent fetch failed: ${err.message}`);
  }

  try {
    const genresRes = await subsonicRequest(userCfg, 'getGenres');
    const genreList = genresRes?.genres?.genre || [];
    if (genreList.length > 0 && genres.size === 0) {
      for (const g of genreList.slice(0, 10)) {
        genres.set(g.name, 1);
      }
    }
  } catch { }

  const topArtists = [...artists.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([name]) => name);

  const topGenres = [...genres.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name]) => name);

  const topDecades = [...decades.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);

  const profile = {
    topArtists,
    topGenres,
    topDecades,
    sampleSongs: sampleSongs.map(s => `${s.artist} - ${s.title}`),
  };

  console.log('[Taste] Profile:', JSON.stringify({ topArtists: topArtists.length, topGenres, topDecades }));
  return profile;
}

function buildTasteString(profile) {
  const parts = [];
  if (profile.topArtists.length) parts.push(`Favorite artists: ${profile.topArtists.join(', ')}`);
  if (profile.topGenres.length) parts.push(`Preferred genres: ${profile.topGenres.join(', ')}`);
  if (profile.topDecades.length) parts.push(`Preferred eras: ${profile.topDecades.join(', ')}`);
  if (profile.sampleSongs.length) parts.push(`Some songs they love: ${profile.sampleSongs.slice(0, 10).join('; ')}`);
  return parts.join('\n');
}

function pickDiverse(songs, count) {
  const picked = [];
  const seenAlbums = new Set();
  const seenArtists = new Set();

  for (const song of songs) {
    if (picked.length >= count) break;
    const album = song.albumId || song.album || '';
    const artist = (song.artist || '').toLowerCase();
    if (seenAlbums.has(album)) continue;
    if (seenArtists.has(artist)) continue;
    picked.push(song);
    seenAlbums.add(album);
    seenArtists.add(artist);
  }

  if (picked.length < count) {
    for (const song of songs) {
      if (picked.length >= count) break;
      const album = song.albumId || song.album || '';
      if (seenAlbums.has(album)) continue;
      picked.push(song);
      seenAlbums.add(album);
    }
  }

  return picked;
}

async function getExactlyTwentyRandom(userCfg) {
  const songs = await getRandomSongs(userCfg, 100);
  const diverse = pickDiverse(songs, 20);
  if (diverse.length < 20) {
    const more = await getRandomSongs(userCfg, 100);
    const seenIds = new Set(diverse.map(s => s.id));
    const seenAlbums = new Set(diverse.map(s => s.albumId));
    for (const song of more) {
      if (diverse.length >= 20) break;
      if (seenIds.has(song.id)) continue;
      if (seenAlbums.has(song.albumId)) continue;
      diverse.push(song);
      seenIds.add(song.id);
      seenAlbums.add(song.albumId);
    }
  }
  return diverse.slice(0, 20);
}

async function generatePlaylistFromAI(userCfg, userPrompt, tasteProfile = null, targetCount = 20, excludeIds = new Set()) {
  let tasteBlock = '';
  if (tasteProfile && (tasteProfile.topArtists.length || tasteProfile.topGenres.length)) {
    tasteBlock = `

The listener has these musical preferences:
${buildTasteString(tasteProfile)}

IMPORTANT: You MUST incorporate their taste. Mix in artists and genres similar to what they already love. Generate some search terms that are similar-but-not-identical to their favorites (e.g. if they love "radiohead" also include "muse", "sigur ros", "alt-j"). Also include some wildcards that match the mood but stretch their comfort zone slightly.`;
  }

  const systemPrompt = `You are a music playlist curator AI. Given a user's request and their listening history, you must generate a JSON array of search terms that will find songs matching their request.

RULES:
- Return ONLY a valid JSON array of search query strings
- Each search term should be specific enough to find relevant songs (artist names, genres, moods, etc.)
- Generate 25-35 search terms to build a diverse playlist
- Consider mood, genre, tempo, era, and vibe
- Be creative but accurate with real music references
- Prioritize variety - different artists, genres, and eras
- No duplicate artists across search terms
- DO NOT include any explanation, just the JSON array
${tasteBlock}

IMPORTANT - ARTIST REQUESTS:
If the user mentions a specific artist by name (e.g. "bruno mars", "give me taylor swift songs"), that artist MUST be the primary focus. Generate most search terms around that artist:
- The artist's name itself
- Their album names (e.g. "bruno mars doo wops and hooligans", "bruno mars unorthodox jukebox", "bruno mars 24k magic", "bruno mars hollywood's bleeding")
- Their biggest song titles (e.g. "just the way you are bruno mars", "grenade bruno mars", "uptown funk bruno mars")
- Similar artists in the same genre (e.g. "the weeknd", "usher", "justin timberlake", "charlie puth")
- Only fill remaining slots with mood/vibe terms that match the requested style

Example:
User: "give me a playlist of bruno mars songs"
Response: ["bruno mars", "bruno mars doo wops and hooligans", "bruno mars unorthodox jukebox", "bruno mars 24k magic", "bruno mars hollywood's bleeding", "just the way you are bruno mars", "grenade bruno mars", "locked out of heaven bruno mars", "uptown funk bruno mars", "that's what i like bruno mars", "leave the door open bruno mars", "silky soul music", "charlie puth", "the weeknd", "usher", "justin timberlake", "ne-yo", "adam levine", "maroon 5", "pharrell williams", "feel good pop", "smooth r&b pop"]

Examples:
User: "chill evening vibes"
Response: ["lo-fi hip hop", "bon iver", "ambient electronic", "norah jones", "tycho", "chill wave", "dj okawari", "iron & wine", "julien baker", "phoebe bridgers", "beach house", "cigarettes after sex", "men i trust", "khalid", "daniel caesar", "sza", "frank ocean", "blood orange", "kelela", "jhené aiko"]

User: "pump up workout music"
Response: ["kanye west", "run the jewels", "metallica", "theProdigy", "deadmau5", "eminem", "rage against the machine", "imagine dragons", "travis scott", "lil wayne", "dmx", "meek mill", "kendrick lamar", "danny brown", "juice wrld", "ski mask", "playboi carti", "denzel curry", "busta rhymes", "meg thee stallion"]`;

  const aiResponse = await ollamaGenerate(userCfg, userPrompt, systemPrompt);
  console.log('[AI Response]', aiResponse.slice(0, 300));

  let searchTerms;
  try {
    const jsonMatch = aiResponse.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      searchTerms = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error('No JSON array found in response');
    }
  } catch {
    const lines = aiResponse.split('\n').filter(l => l.trim().startsWith('"') || l.trim().startsWith("'"));
    searchTerms = lines.map(l => l.replace(/^[\s"*']+|[\s"*']+$/g, '').replace(/,\s*$/, '')).filter(Boolean);
  }

  if (!searchTerms || searchTerms.length === 0) {
    console.log('[AI] No search terms, using fallback random songs');
    return await getExactlyTwentyRandom(userCfg);
  }

  console.log('[AI] Search terms:', searchTerms);

  const allCandidates = new Map();

  for (const term of searchTerms) {
    const songs = await searchSongs(userCfg, term, 20);
    for (const song of songs) {
      if (!allCandidates.has(song.id) && !excludeIds.has(song.id)) {
        allCandidates.set(song.id, song);
      }
    }
  }

  console.log(`[AI] Excluded ${excludeIds.size} previously used songs`);

  const candidates = Array.from(allCandidates.values());
  console.log(`[AI] Total candidates found: ${candidates.length}`);

  const picked = pickDiverse(candidates, targetCount);
  console.log(`[AI] After diversity pick: ${picked.length} songs`);

  if (picked.length < targetCount) {
    console.log('[AI] Not enough diverse songs, supplementing with random');
    const needed = targetCount - picked.length;
    const extra = await getRandomSongs(userCfg, needed * 4);
    const existingAlbums = new Set(picked.map(s => s.albumId));
    const existingArtists = new Set(picked.map(s => (s.artist || '').toLowerCase()));
    for (const song of extra) {
      if (picked.length >= targetCount) break;
      if (picked.some(s => s.id === song.id)) continue;
      if (existingAlbums.has(song.albumId)) continue;
      if (existingArtists.has((song.artist || '').toLowerCase())) continue;
      picked.push(song);
      existingAlbums.add(song.albumId);
      existingArtists.add((song.artist || '').toLowerCase());
    }
  }

  return picked.slice(0, targetCount);
}

function getMoodForTimeOfDay() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 9) return 'energetic morning coffee music, upbeat jazz, feel-good indie pop, morning motivation';
  if (hour >= 9 && hour < 12) return 'productive work focus music, lo-fi beats, electronic ambient, post-rock';
  if (hour >= 12 && hour < 14) return 'lunch break chill vibes, soul food music, neo-soul, R&B grooves';
  if (hour >= 14 && hour < 17) return 'afternoon energy boost, indie rock, synthwave, alt-pop';
  if (hour >= 17 && hour < 20) return 'sunset drive music, chillwave, dream pop, mellow electronic';
  if (hour >= 20 && hour < 23) return 'late night vibes, ambient, trip-hop, dark jazz, downtempo';
  return 'late night deep sleep ambient, drone music, meditation, relaxation';
}

function getDailyVibeShift() {
  const shifts = [
    'Explore lesser-known deep cuts and hidden gems. Avoid mainstream hits.',
    'Focus on live performances and acoustic/unplugged versions.',
    'Emphasize international music from different countries and cultures.',
    'Dig into vintage classics from the 60s, 70s, and 80s.',
    'Highlight underground and indie artists with raw, authentic sound.',
    'Mix in electronic remixes, covers, and reimagined versions.',
    'Prioritize instrumental tracks and compositions without vocals.',
    'Focus on artists from the same record labels or music scenes.',
    'Choose tracks with interesting time signatures or unusual structures.',
    'Highlight female-led bands and solo female artists.',
    'Mix genres unexpectedly - blend two or more styles together.',
    'Focus on music from a specific decade not yet well represented.',
    'Emphasize music with rich harmonies and layered production.',
    'Choose raw, lo-fi, and garage recordings over polished studio tracks.',
    'Highlight collaborative tracks featuring multiple artists.',
    'Focus on music from emerging scenes - new wave of genres.',
  ];
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  return shifts[dayOfYear % shifts.length];
}

function getRecentDailySongIds(userId, playlists) {
  const recentIds = new Set();
  for (const p of playlists) {
    if (!p.isDaily) continue;
    for (const s of (p.songs || [])) {
      recentIds.add(s.id);
    }
  }
  return recentIds;
}

// ─── Auth Routes ───
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const users = loadUsers();
  const user = Object.values(users).find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const userId = Object.keys(users).find(k => users[k] === user);
  const token = jwt.sign({ userId, username: user.username, isAdmin: user.isAdmin }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  res.json({ token, username: user.username, isAdmin: user.isAdmin, userId });
});

app.get('/api/auth/whoami', authMiddleware, (req, res) => {
  res.json({ userId: req.user.userId, username: req.user.username, isAdmin: req.user.isAdmin });
});

app.post('/api/auth/change-password', authMiddleware, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' });

  const users = loadUsers();
  const user = users[req.user.userId];
  if (!user || !bcrypt.compareSync(currentPassword, user.passwordHash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  saveUsers(users);
  res.json({ ok: true });
});

// ─── Admin Routes ───
app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  const users = loadUsers();
  const list = Object.entries(users).map(([id, u]) => ({
    id,
    username: u.username,
    isAdmin: u.isAdmin,
    createdAt: u.createdAt,
  }));
  res.json(list);
});

app.post('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  const { username, password, isAdmin = false } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const users = loadUsers();
  const exists = Object.values(users).some(u => u.username.toLowerCase() === username.toLowerCase());
  if (exists) return res.status(409).json({ error: 'Username already exists' });

  const id = username.toLowerCase().replace(/[^a-z0-9]/g, '-');
  users[id] = {
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    isAdmin: !!isAdmin,
    createdAt: new Date().toISOString(),
  };
  saveUsers(users);
  getUserDir(id);
  res.json({ ok: true, userId: id });
});

app.patch('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  const { username } = req.body;
  if (!username || !username.trim()) return res.status(400).json({ error: 'Username required' });

  const users = loadUsers();
  if (!users[req.params.id]) return res.status(404).json({ error: 'User not found' });

  const exists = Object.entries(users).some(([id, u]) => id !== req.params.id && u.username.toLowerCase() === username.trim().toLowerCase());
  if (exists) return res.status(409).json({ error: 'Username already exists' });

  users[req.params.id].username = username.trim();
  saveUsers(users);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  const users = loadUsers();
  if (!users[req.params.id]) return res.status(404).json({ error: 'User not found' });
  if (req.params.id === req.user.userId) return res.status(400).json({ error: 'Cannot delete yourself' });

  delete users[req.params.id];
  saveUsers(users);
  res.json({ ok: true });
});

// ─── Protected Routes ───
app.get('/api/config', authMiddleware, (req, res) => {
  const cfg = loadUserConfig(req.user.userId);
  res.json({
    navidromeUrl: cfg.navidromeUrl,
    navidromeUser: cfg.navidromeUser,
    ollamaUrl: cfg.ollamaUrl,
    ollamaModel: cfg.ollamaModel,
    theme: cfg.theme || 'default',
    hasNavidrome: !!cfg.navidromeUrl,
    hasOllama: !!cfg.ollamaUrl,
  });
});

app.post('/api/config', authMiddleware, (req, res) => {
  const cfg = loadUserConfig(req.user.userId);
  const { navidromeUrl, navidromeUser, navidromePassword, ollamaUrl, ollamaModel, theme } = req.body;
  if (navidromeUrl !== undefined) cfg.navidromeUrl = navidromeUrl;
  if (navidromeUser !== undefined) cfg.navidromeUser = navidromeUser;
  if (navidromePassword !== undefined) cfg.navidromePassword = navidromePassword;
  if (ollamaUrl !== undefined) cfg.ollamaUrl = ollamaUrl;
  if (ollamaModel !== undefined) cfg.ollamaModel = ollamaModel;
  if (theme !== undefined) cfg.theme = theme;
  saveUserConfig(req.user.userId, cfg);
  res.json({ ok: true });
});

app.get('/api/daily-settings', authMiddleware, (req, res) => {
  const cfg = loadUserConfig(req.user.userId);
  res.json({
    songCount: cfg.dailySongCount || 20,
    generateHour: cfg.dailyGenerateHour ?? 6,
    timezone: cfg.dailyTimezone || 'America/New_York',
  });
});

app.post('/api/daily-settings', authMiddleware, (req, res) => {
  const cfg = loadUserConfig(req.user.userId);
  const { songCount, generateHour, timezone } = req.body;
  if (songCount !== undefined) cfg.dailySongCount = Math.max(5, Math.min(50, parseInt(songCount) || 20));
  if (generateHour !== undefined) cfg.dailyGenerateHour = Math.max(0, Math.min(23, parseInt(generateHour) ?? 6));
  if (timezone !== undefined) cfg.dailyTimezone = timezone;
  saveUserConfig(req.user.userId, cfg);
  console.log(`[Settings] User ${req.user.username} daily: ${cfg.dailySongCount} songs at ${cfg.dailyGenerateHour}:00 ${cfg.dailyTimezone}`);
  res.json({ ok: true });
});

app.get('/api/ping', authMiddleware, async (req, res) => {
  try {
    const cfg = loadUserConfig(req.user.userId);
    const result = await subsonicRequest(cfg, 'ping');
    res.json({ ok: true, version: result?.version });
  } catch (err) {
    console.error('[Ping Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ollama-status', authMiddleware, async (req, res) => {
  try {
    const cfg = loadUserConfig(req.user.userId);
    const response = await fetch(`${cfg.ollamaUrl}/api/tags`);
    if (!response.ok) throw new Error('Ollama not reachable');
    const data = await response.json();
    res.json({ ok: true, models: data.models?.map(m => m.name) || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/search', authMiddleware, async (req, res) => {
  try {
    const cfg = loadUserConfig(req.user.userId);
    const { q = '', count = 5 } = req.query;
    const songs = await searchSongs(cfg, q, parseInt(count));
    res.json({ query: q, count: songs.length, songs: songs.map(s => ({ id: s.id, title: s.title, artist: s.artist, album: s.album })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/random', authMiddleware, async (req, res) => {
  try {
    const cfg = loadUserConfig(req.user.userId);
    const songs = await getRandomSongs(cfg, 5);
    res.json({ count: songs.length, songs: songs.map(s => ({ id: s.id, title: s.title, artist: s.artist, album: s.album })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/playlists', authMiddleware, (req, res) => {
  const playlists = loadUserPlaylists(req.user.userId);
  res.json(playlists.map(p => ({
    id: p.id,
    name: p.name,
    isDaily: p.isDaily,
    navidromePlaylistId: p.navidromePlaylistId || null,
    songCount: p.songs?.length || 0,
  })));
});

app.get('/api/artists', authMiddleware, async (req, res) => {
  try {
    const cfg = loadUserConfig(req.user.userId);
    const folders = await subsonicRequest(cfg, 'getMusicFolders');
    const musicFolder = folders?.musicFolder?.[0]?.id || '0';
    const indexes = await subsonicRequest(cfg, 'getIndexes', { musicFolderId: musicFolder });
    const artists = indexes?.indexes?.flatMap(i => i.artist) || [];
    res.json(artists);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/random', authMiddleware, async (req, res) => {
  try {
    const cfg = loadUserConfig(req.user.userId);
    const { count = 50, genre = '', fromYear = '', toYear = '' } = req.query;
    const songs = await getRandomSongs(cfg, parseInt(count), genre, fromYear, toYear);
    res.json(songs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/generate', authMiddleware, async (req, res) => {
  try {
    const cfg = loadUserConfig(req.user.userId);
    const { prompt, songCount = 20 } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    const songs = await generatePlaylistFromAI(cfg, prompt, null, songCount);

    const playlist = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: prompt.length > 50 ? prompt.slice(0, 50) + '...' : prompt,
      prompt,
      songs,
      createdAt: new Date().toISOString(),
      isDaily: false,
    };

    const playlists = loadUserPlaylists(req.user.userId);
    playlists.unshift(playlist);
    saveUserPlaylists(req.user.userId, playlists);

    res.json(playlist);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/generate-daily', authMiddleware, async (req, res) => {
  try {
    const cfg = loadUserConfig(req.user.userId);
    console.log(`[Daily] Building taste profile for ${req.user.username}...`);
    const tasteProfile = await buildTasteProfile(cfg);
    const mood = getMoodForTimeOfDay();
    const playlists = loadUserPlaylists(req.user.userId);
    const excludeIds = getRecentDailySongIds(req.user.userId, playlists);
    console.log(`[Daily] Excluding ${excludeIds.size} previously used songs`);
    const prompt = `Time of day: ${mood}\nCreate a daily playlist that matches this mood and the listener's taste. Pick completely different artists and songs than what has been used before.`;
    const songs = await generatePlaylistFromAI(cfg, prompt, tasteProfile, cfg.dailySongCount || 20, excludeIds);

    const tz = cfg.dailyTimezone || 'America/New_York';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const playlist = {
      id: `daily-${today}`,
      name: `Daily Mix - ${today}`,
      prompt: mood,
      songs,
      createdAt: new Date().toISOString(),
      isDaily: true,
    };

    const existingIdx = playlists.findIndex(p => p.id === playlist.id);
    if (existingIdx >= 0) {
      playlists[existingIdx] = playlist;
    } else {
      playlists.unshift(playlist);
    }
    saveUserPlaylists(req.user.userId, playlists);

    if (cfg.navidromeUrl) {
      try {
        const { token, salt } = subsonicAuth(cfg.navidromePassword);
        const params = new URLSearchParams();
        params.append('name', playlist.name);
        for (const s of songs) params.append('songId', s.id);
        params.append('u', cfg.navidromeUser);
        params.append('t', token);
        params.append('s', salt);
        params.append('v', '1.16.1');
        params.append('c', 'MoodWave');
        params.append('f', 'json');

        const url = `${cfg.navidromeUrl}/rest/createPlaylist?${params}`;
        console.log(`[Daily] Creating Navidrome playlist "${playlist.name}" with ${songs.length} songs`);
        const response = await fetch(url);
        const data = await response.json();

        if (data['subsonic-response']?.status === 'ok') {
          console.log(`[Daily] Created Navidrome playlist successfully`);
        } else {
          const err = data['subsonic-response']?.error;
          console.error(`[Daily] Navidrome create failed: ${err?.code} ${err?.message}`);
        }
      } catch (syncErr) {
        console.error('[Daily] Failed to create Navidrome playlist:', syncErr.message);
      }
    }

    res.json(playlist);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/navidrome-playlist', authMiddleware, async (req, res) => {
  try {
    const cfg = loadUserConfig(req.user.userId);
    const { name, songIds } = req.body;
    if (!name || !songIds?.length) return res.status(400).json({ error: 'Name and songIds required' });

    const { token, salt } = subsonicAuth(cfg.navidromePassword);
    const params = new URLSearchParams();
    params.append('name', name);
    for (const id of songIds) params.append('songId', id);
    params.append('u', cfg.navidromeUser);
    params.append('t', token);
    params.append('s', salt);
    params.append('v', '1.16.1');
    params.append('c', 'MoodWave');
    params.append('f', 'json');

    const url = `${cfg.navidromeUrl}/rest/createPlaylist?${params}`;
    console.log(`[Navidrome] Creating playlist "${name}" with ${songIds.length} songs`);
    const response = await fetch(url);
    const data = await response.json();

    if (data['subsonic-response']?.status === 'failed') {
      const err = data['subsonic-response'].error;
      throw new Error(`Subsonic ${err?.code}: ${err?.message}`);
    }

    console.log(`[Navidrome] Created playlist "${name}"`);
    res.json({ ok: true, message: `Playlist "${name}" created in Navidrome` });
  } catch (err) {
    console.error('[Navidrome Playlist Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/playlists', authMiddleware, (req, res) => {
  res.json(loadUserPlaylists(req.user.userId));
});

app.get('/api/playlists/:id', authMiddleware, (req, res) => {
  const playlists = loadUserPlaylists(req.user.userId);
  const playlist = playlists.find(p => p.id === req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Not found' });
  res.json(playlist);
});

app.delete('/api/playlists/:id', authMiddleware, (req, res) => {
  let playlists = loadUserPlaylists(req.user.userId);
  playlists = playlists.filter(p => p.id !== req.params.id);
  saveUserPlaylists(req.user.userId, playlists);
  res.json({ ok: true });
});

app.get('/api/stream/:id', authMiddleware, async (req, res) => {
  try {
    const cfg = loadUserConfig(req.user.userId);
    const { token, salt } = subsonicAuth(cfg.navidromePassword);
    const query = new URLSearchParams({
      u: cfg.navidromeUser,
      t: token,
      s: salt,
      v: '1.16.1',
      c: 'MoodWave',
      id: req.params.id,
    });

    const url = `${cfg.navidromeUrl}/rest/stream?${query}`;

    const range = req.headers.range;
    const headers = {};
    if (range) headers.Range = range;

    const upstream = await fetch(url, { headers });
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (['content-type', 'content-length', 'content-range', 'accept-ranges'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    const reader = upstream.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); return; }
        res.write(value);
      }
    };
    await pump();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cover/:id', authMiddleware, async (req, res) => {
  try {
    const cfg = loadUserConfig(req.user.userId);
    const { token, salt } = subsonicAuth(cfg.navidromePassword);
    const query = new URLSearchParams({
      u: cfg.navidromeUser,
      t: token,
      s: salt,
      v: '1.16.1',
      c: 'MoodWave',
      id: req.params.id,
    });

    const url = `${cfg.navidromeUrl}/rest/getCoverArt?${query}`;
    const upstream = await fetch(url);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'content-length') res.setHeader(key, value);
    });

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); return; }
      res.write(value);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Startup ───
seedAdmin();

let dailyCronJob = null;

async function runDailyCronForUser(userId, userCfg) {
  try {
    console.log(`[Cron] Generating daily playlist for user ${userId}...`);
    const tasteProfile = await buildTasteProfile(userCfg);
    const mood = getMoodForTimeOfDay();
    const playlists = loadUserPlaylists(userId);
    const excludeIds = getRecentDailySongIds(userId, playlists);
    console.log(`[Cron] Excluding ${excludeIds.size} previously used songs`);
    const prompt = `Time of day: ${mood}\nCreate a daily playlist that matches this mood and the listener's taste. Pick completely different artists and songs than what has been used before.`;
    const songs = await generatePlaylistFromAI(userCfg, prompt, tasteProfile, userCfg.dailySongCount || 20, excludeIds);
    const tz = userCfg.dailyTimezone || 'America/New_York';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const playlist = {
      id: `daily-${today}`,
      name: `Daily Mix - ${today}`,
      prompt: mood,
      songs,
      createdAt: new Date().toISOString(),
      isDaily: true,
    };
    const idx = playlists.findIndex(p => p.id === playlist.id);
    if (idx >= 0) playlists[idx] = playlist;
    else playlists.unshift(playlist);
    saveUserPlaylists(userId, playlists);

    if (userCfg.navidromeUrl) {
      try {
        const { token, salt } = subsonicAuth(userCfg.navidromePassword);
        const params = new URLSearchParams();
        params.append('name', playlist.name);
        for (const s of songs) params.append('songId', s.id);
        params.append('u', userCfg.navidromeUser);
        params.append('t', token);
        params.append('s', salt);
        params.append('v', '1.16.1');
        params.append('c', 'MoodWave');
        params.append('f', 'json');

        const url = `${userCfg.navidromeUrl}/rest/createPlaylist?${params}`;
        const response = await fetch(url);
        const data = await response.json();
        if (data['subsonic-response']?.status === 'ok') {
          console.log(`[Cron] Created Navidrome playlist for ${userId}`);
        }
      } catch (syncErr) {
        console.error(`[Cron] Failed Navidrome sync for ${userId}:`, syncErr.message);
      }
    }

    console.log(`[Cron] Daily playlist generated for ${userId} with ${songs.length} songs`);
  } catch (err) {
    console.error(`[Cron] Failed for ${userId}:`, err.message);
  }
}

async function runDailyCron() {
  console.log('[Cron] Checking all users for daily playlist generation...');
  const users = loadUsers();
  const now = new Date();

  for (const [userId, user] of Object.entries(users)) {
    if (user.isAdmin && Object.keys(users).length === 1) continue;
    const cfg = loadUserConfig(userId);
    if (!cfg.navidromeUrl) continue;

    try {
      const tz = cfg.dailyTimezone || 'America/New_York';
      const hour = cfg.dailyGenerateHour ?? 6;
      const localTime = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      if (localTime.getHours() === hour && localTime.getMinutes() === 0) {
        await runDailyCronForUser(userId, cfg);
      }
    } catch (err) {
      console.error(`[Cron] Timezone error for ${userId}:`, err.message);
    }
  }
}

function scheduleDailyCron() {
  if (dailyCronJob) {
    dailyCronJob.stop();
    dailyCronJob = null;
  }
  dailyCronJob = cron.schedule('* * * * *', runDailyCron);
  console.log(`[Cron] Checking all users every minute for scheduled daily playlists`);
}

scheduleDailyCron();

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║           MOODWAVE v2.0.0               ║
  ║   AI-Powered Mood Playlist Generator    ║
  ║                                          ║
  ║   http://localhost:${PORT}                  ║
  ╚══════════════════════════════════════════╝
  `);
});
