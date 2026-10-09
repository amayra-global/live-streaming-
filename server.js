/**
 * ScreenStream Cloud Relay Server
 * -------------------------------------------------------------
 * Ultra-lightweight, zero-dependency Node.js video streaming relay server.
 * Relays live Android screen broadcast frames to thousands of viewers worldwide.
 *
 * Endpoints:
 *   POST /publish/:channelId       - Broadcaster (Android Admin) pushes JPEG frames
 *   POST /publish-audio/:channelId - Broadcaster pushes real-time PCM audio chunks
 *   GET  /watch/:channelId         - Web browser player with live video, audio, chat & reactions
 *   GET  /stream/:channelId        - Infinite MJPEG video stream (RFC 2046 multipart)
 *   GET  /audio/:channelId         - Live Web Audio API PCM stream
 *   GET  /audio/:channelId.wav     - Live WAV audio stream fallback
 *   GET  /snapshot/:channelId      - Latest single JPEG frame (polled by remote Android apps)
 *   GET  /api/status               - Health check & server diagnostics
 *   GET  /api/channels             - List of active broadcast channels
 *   GET  /chat/messages            - Get recent chat messages
 *   POST /chat                     - Send a live chat message
 *   POST /reaction                 - Send emoji reaction
 */

const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 8080;

// In-memory channel stores
const channels = new Map();

function getOrCreateChannel(channelId) {
  if (!channels.has(channelId)) {
    channels.set(channelId, {
      id: channelId,
      latestFrame: null,
      latestAudioChunk: null,
      lastActive: 0,
      lastAudioActive: 0,
      frameCount: 0,
      viewers: new Set(),
      audioViewers: new Set(),
      chatMessages: [
        {
          id: 'welcome-1',
          sender: 'System',
          message: `Welcome to Channel #${channelId}! Live stream ready.`,
          isAdmin: true,
          timestamp: Date.now()
        }
      ],
      reactions: []
    });
  }
  return channels.get(channelId);
}

// Clean up stale channels every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, ch] of channels.entries()) {
    if (now - ch.lastActive > 15 * 60 * 1000 && ch.viewers.size === 0) {
      channels.delete(id);
    }
  }
}, 5 * 60 * 1000);

const server = http.createServer((req, res) => {
  // Global CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname || '/';
  const parts = pathname.split('/').filter(Boolean);

  // Health check endpoint (Render uses this to verify deployment)
  if (pathname === '/api/status' || pathname === '/health' || pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const activeList = [];
    const now = Date.now();
    for (const [id, ch] of channels.entries()) {
      activeList.push({
        channelId: id,
        isLive: now - ch.lastActive < 10000,
        activeViewers: ch.viewers.size,
        framesReceived: ch.frameCount,
        lastActiveAgoMs: now - ch.lastActive
      });
    }
    res.end(JSON.stringify({
      status: 'online',
      message: 'ScreenStream Cloud Relay Server is running',
      version: '1.0.0',
      channels: activeList,
      timestamp: Date.now()
    }));
    return;
  }

  // Active channels list
  if (pathname === '/api/channels') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const now = Date.now();
    const list = Array.from(channels.values()).map(ch => ({
      id: ch.id,
      isLive: now - ch.lastActive < 10000,
      viewers: ch.viewers.size,
      lastActive: ch.lastActive
    }));
    res.end(JSON.stringify(list));
    return;
  }

  // Broadcaster publishing frames: POST /publish/:channelId
  if (req.method === 'POST' && (parts[0] === 'publish' || pathname === '/publish')) {
    const channelId = parts[1] || 'ADMIN-LIVE-77';
    const ch = getOrCreateChannel(channelId);

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      if (buffer.length > 0) {
        ch.latestFrame = buffer;
        ch.lastActive = Date.now();
        ch.frameCount++;

        // Broadcast to all active MJPEG stream viewers
        const boundaryHeader = Buffer.from(
          `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`
        );
        const boundaryFooter = Buffer.from('\r\n');

        for (const viewerRes of ch.viewers) {
          try {
            viewerRes.write(boundaryHeader);
            viewerRes.write(buffer);
            viewerRes.write(boundaryFooter);
          } catch (_) {
            ch.viewers.delete(viewerRes);
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, channel: channelId, frameSize: buffer.length }));
    });
    return;
  }

  // Broadcaster publishing system audio chunks: POST /publish-audio/:channelId
  if (req.method === 'POST' && (parts[0] === 'publish-audio' || pathname === '/publish-audio')) {
    const channelId = parts[1] || 'ADMIN-LIVE-77';
    const ch = getOrCreateChannel(channelId);

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      if (buffer.length > 0) {
        ch.latestAudioChunk = buffer;
        ch.lastAudioActive = Date.now();

        // Broadcast to all audio stream subscribers
        for (const audioRes of ch.audioViewers) {
          try {
            audioRes.write(buffer);
          } catch (_) {
            ch.audioViewers.delete(audioRes);
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, channel: channelId, audioSize: buffer.length }));
    });
    return;
  }

  // System Audio Stream: GET /audio/:channelId, /audio/:channelId.wav, or /audio
  if (parts[0] === 'audio') {
    let channelId = parts[1] || 'ADMIN-LIVE-77';
    const isWav = channelId.endsWith('.wav') || parsedUrl.query.format === 'wav';
    channelId = channelId.replace(/\.wav$/, '');
    const ch = getOrCreateChannel(channelId);

    const headers = {
      'Content-Type': isWav ? 'audio/wav' : 'audio/l16; rate=44100; channels=2',
      'Cache-Control': 'no-store, no-cache, must-revalidate, pre-check=0, post-check=0, max-age=0',
      'Pragma': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    };
    res.writeHead(200, headers);

    if (isWav) {
      // 44-byte standard PCM WAV header for 44.1kHz, 16-bit, stereo
      const wavHeader = Buffer.alloc(44);
      wavHeader.write('RIFF', 0);
      wavHeader.writeUInt32LE(0x7fffffff, 4); // Max streaming size
      wavHeader.write('WAVE', 8);
      wavHeader.write('fmt ', 12);
      wavHeader.writeUInt32LE(16, 16); // Subchunk1Size
      wavHeader.writeUInt16LE(1, 20); // PCM format
      wavHeader.writeUInt16LE(2, 22); // 2 channels (Stereo)
      wavHeader.writeUInt32LE(44100, 24); // 44.1 kHz sample rate
      wavHeader.writeUInt32LE(44100 * 2 * 2, 28); // Byte rate
      wavHeader.writeUInt16LE(4, 32); // Block align
      wavHeader.writeUInt16LE(16, 34); // Bits per sample
      wavHeader.write('data', 36);
      wavHeader.writeUInt32LE(0x7fffffff, 40); // Max data size
      res.write(wavHeader);
    }

    if (ch.latestAudioChunk) {
      res.write(ch.latestAudioChunk);
    }

    ch.audioViewers.add(res);

    req.on('close', () => {
      ch.audioViewers.delete(res);
    });
    return;
  }

  // MJPEG Video Stream: GET /stream/:channelId or /stream
  if (parts[0] === 'stream' || pathname.startsWith('/live.mjpg')) {
    const channelId = parts[1] || 'ADMIN-LIVE-77';
    const ch = getOrCreateChannel(channelId);

    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=--frame',
      'Cache-Control': 'no-store, no-cache, must-revalidate, pre-check=0, post-check=0, max-age=0',
      'Pragma': 'no-cache',
      'Connection': 'close'
    });

    if (ch.latestFrame) {
      res.write(Buffer.from(
        `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${ch.latestFrame.length}\r\n\r\n`
      ));
      res.write(ch.latestFrame);
      res.write(Buffer.from('\r\n'));
    }

    ch.viewers.add(res);

    req.on('close', () => {
      ch.viewers.delete(res);
    });
    return;
  }

  // Single Frame Snapshot: GET /snapshot/:channelId or /snapshot
  if (parts[0] === 'snapshot') {
    const channelId = parts[1] || 'ADMIN-LIVE-77';
    const ch = getOrCreateChannel(channelId);

    if (ch.latestFrame && Date.now() - ch.lastActive < 15000) {
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': ch.latestFrame.length,
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(ch.latestFrame);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No live frame available for this channel', channel: channelId }));
    }
    return;
  }

  // Chat messages: GET /chat/messages or GET /chat
  if (pathname === '/chat/messages' || (parts[0] === 'chat' && req.method === 'GET')) {
    const channelId = parsedUrl.query.channel || 'ADMIN-LIVE-77';
    const ch = getOrCreateChannel(channelId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ch.chatMessages));
    return;
  }

  // Post chat message: POST /chat
  if (req.method === 'POST' && (pathname === '/chat' || parts[0] === 'chat')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let sender = 'Web Viewer';
      let message = '';
      let channelId = 'ADMIN-LIVE-77';

      try {
        const json = JSON.parse(body);
        sender = json.sender || json.senderName || sender;
        message = json.message || '';
        channelId = json.channel || channelId;
      } catch (_) {
        const params = new URLSearchParams(body);
        sender = params.get('sender') || sender;
        message = params.get('message') || '';
      }

      const ch = getOrCreateChannel(channelId);
      if (message.trim().length > 0) {
        const chatItem = {
          id: 'chat-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
          sender: sender.trim().substring(0, 30),
          message: message.trim().substring(0, 300),
          isAdmin: false,
          timestamp: Date.now()
        };
        ch.chatMessages.push(chatItem);
        if (ch.chatMessages.length > 100) ch.chatMessages.shift();
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, total: ch.chatMessages.length }));
    });
    return;
  }

  // Post reaction: POST /reaction
  if (req.method === 'POST' && (pathname === '/reaction' || parts[0] === 'reaction')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let emoji = '❤️';
      let channelId = 'ADMIN-LIVE-77';
      try {
        const json = JSON.parse(body);
        emoji = json.emoji || emoji;
        channelId = json.channel || channelId;
      } catch (_) {
        const params = new URLSearchParams(body);
        emoji = params.get('emoji') || emoji;
      }

      const ch = getOrCreateChannel(channelId);
      ch.reactions.push({ emoji, timestamp: Date.now() });
      if (ch.reactions.length > 50) ch.reactions.shift();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, emoji }));
    });
    return;
  }

  // Web Browser Watch Player: GET /watch/:channelId, GET /watch, or GET /
  if (pathname === '/' || parts[0] === 'watch') {
    const channelId = parts[1] || 'ADMIN-LIVE-77';
    serveWebPlayer(res, channelId);
    return;
  }

  // 404 for unknown endpoints
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found', path: pathname }));
});

function serveWebPlayer(res, channelId) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Live Stream #${channelId} • ScreenStream Live</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: #0B111E;
      color: #E2E8F0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    header {
      background: #10192C;
      border-bottom: 1px solid #1E293B;
      padding: 12px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      z-index: 10;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 700;
      font-size: 16px;
      color: #FFFFFF;
    }
    .live-badge {
      background: #EF4444;
      color: #FFF;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.5px;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .pulse-dot {
      width: 7px;
      height: 7px;
      background: #FFF;
      border-radius: 50%;
      animation: pulse 1.2s infinite;
    }
    @keyframes pulse {
      0% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.3; transform: scale(0.7); }
      100% { opacity: 1; transform: scale(1); }
    }
    .channel-tag {
      background: rgba(0, 229, 255, 0.12);
      color: #00E5FF;
      border: 1px solid rgba(0, 229, 255, 0.3);
      padding: 4px 10px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
    }
    .main-container {
      flex: 1;
      display: flex;
      position: relative;
      overflow: hidden;
      transition: all 0.25s ease;
    }
    .player-area {
      flex: 1;
      background: #060A12;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow: hidden;
      min-width: 0;
    }
    .video-viewport {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      background: #060A12;
    }
    #streamImg {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      box-shadow: 0 10px 40px rgba(0,0,0,0.7);
      transition: object-fit 0.2s ease;
    }
    #streamImg.fill-mode {
      object-fit: cover !important;
      width: 100%;
      height: 100%;
    }
    .video-viewport:fullscreen {
      background: #000;
      width: 100vw;
      height: 100vh;
    }
    .video-viewport:fullscreen #streamImg {
      width: 100vw;
      height: 100vh;
      max-width: 100vw;
      max-height: 100vh;
    }
    .player-controls-overlay {
      position: absolute;
      bottom: 16px;
      left: 16px;
      right: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(11, 17, 30, 0.78);
      backdrop-filter: blur(10px);
      padding: 8px 14px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      z-index: 20;
      transition: opacity 0.3s ease;
    }
    .hud-btn {
      background: #18233C;
      color: #E2E8F0;
      border: 1px solid #2B3A5A;
      padding: 6px 12px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: all 0.15s;
    }
    .hud-btn:hover {
      background: #00E5FF;
      color: #060A12;
      border-color: #00E5FF;
    }
    .hud-badge {
      background: rgba(0, 229, 255, 0.15);
      color: #00E5FF;
      border: 1px solid rgba(0, 229, 255, 0.3);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
    }
    .theater-mode .chat-area {
      display: none !important;
    }
    .standby-overlay {
      position: absolute;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
      text-align: center;
      padding: 30px;
      background: rgba(11, 17, 30, 0.85);
      border-radius: 16px;
      border: 1px solid rgba(255,255,255,0.08);
      backdrop-filter: blur(8px);
      max-width: 380px;
    }
    .standby-icon {
      font-size: 40px;
    }
    .standby-title {
      font-size: 18px;
      font-weight: 700;
      color: #F8FAFC;
    }
    .standby-desc {
      font-size: 13px;
      color: #94A3B8;
      line-height: 1.5;
    }
    .chat-area {
      width: 340px;
      background: #10192C;
      border-left: 1px solid #1E293B;
      display: flex;
      flex-direction: column;
    }
    .chat-header {
      padding: 14px 16px;
      border-bottom: 1px solid #1E293B;
      font-weight: 600;
      font-size: 14px;
      color: #F1F5F9;
      display: flex;
      justify-content: space-between;
    }
    .chat-messages {
      flex: 1;
      padding: 12px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .chat-msg {
      background: #18233C;
      padding: 8px 12px;
      border-radius: 10px;
      font-size: 13px;
      line-height: 1.4;
      animation: fadeIn 0.2s ease-in;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
    .chat-sender {
      font-weight: 700;
      font-size: 11px;
      color: #00E5FF;
      margin-bottom: 2px;
    }
    .chat-sender.admin {
      color: #A855F7;
    }
    .chat-input-bar {
      padding: 12px;
      border-top: 1px solid #1E293B;
      display: flex;
      gap: 8px;
      background: #0B111E;
    }
    .chat-input {
      flex: 1;
      background: #18233C;
      border: 1px solid #2B3A5A;
      color: #FFF;
      padding: 10px 12px;
      border-radius: 8px;
      font-size: 13px;
      outline: none;
    }
    .chat-input:focus {
      border-color: #00E5FF;
    }
    .send-btn {
      background: #00E5FF;
      color: #060A12;
      border: none;
      font-weight: 700;
      padding: 0 16px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
    }
    .reactions-bar {
      display: flex;
      gap: 6px;
      padding: 8px 12px;
      background: #0E1626;
      border-top: 1px solid #1A2436;
      justify-content: space-around;
    }
    .reaction-btn {
      background: none;
      border: none;
      font-size: 20px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 6px;
      transition: transform 0.1s;
    }
    .reaction-btn:hover {
      transform: scale(1.3);
    }
    .flying-reaction {
      position: absolute;
      bottom: 20px;
      right: 20px;
      font-size: 28px;
      pointer-events: none;
      animation: floatUp 2s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
      z-index: 99;
    }
    @keyframes floatUp {
      0% { opacity: 1; transform: translateY(0) scale(1); }
      100% { opacity: 0; transform: translateY(-300px) scale(1.8) rotate(15deg); }
    }
    @media (max-width: 768px) {
      .main-container { flex-direction: column; }
      .chat-area { width: 100%; height: 260px; border-left: none; border-top: 1px solid #1E293B; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="live-badge" id="liveBadge">
        <span class="pulse-dot"></span>
        <span id="liveText">LIVE</span>
      </div>
      <span>ScreenStream</span>
    </div>
    <div class="channel-tag">Channel #${channelId}</div>
    <span id="feedOrientationTag" class="hud-badge" style="display: none;">📱 720×1280</span>
    <button id="audioBtn" style="background:#1E293B;color:#00E5FF;border:1px solid #00E5FF;border-radius:20px;padding:6px 14px;cursor:pointer;font-size:12px;font-weight:700;" onclick="toggleAudio()">🔊 Audio (Tap to Play)</button>
  </header>
  <audio id="streamAudio" playsinline></audio>

  <div class="main-container" id="mainContainer">
    <div class="player-area">
      <div class="video-viewport" id="viewport">
        <img id="streamImg" src="/stream/${channelId}" alt="Live Broadcast Screen" onerror="handleStreamError()" onload="handleStreamLoaded()">
        
        <div class="player-controls-overlay" id="playerOverlay">
          <div style="display: flex; gap: 8px; align-items: center;">
            <button class="hud-btn" onclick="toggleAspect()" id="aspectBtn" title="Toggle Fit or Fill to Screen">🔲 Fit Mode</button>
            <button class="hud-btn" onclick="toggleTheater()" id="theaterBtn" title="Toggle Chat / Theater Mode">💬 Chat</button>
            <a href="/snapshot/${channelId}" target="_blank" download="stream-snapshot.jpg" class="hud-btn" style="text-decoration:none;">📸 Snapshot</a>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button class="hud-btn" onclick="toggleFullscreen()" id="fsBtn" style="background: rgba(0, 229, 255, 0.2); border-color: #00E5FF; color: #00E5FF; font-weight: 700;">⛶ Fullscreen</button>
          </div>
        </div>

        <div class="standby-overlay" id="standbyOverlay" style="display: none;">
          <div class="standby-icon">📡</div>
          <div class="standby-title">Broadcaster is Offline</div>
          <div class="standby-desc">Waiting for Admin to tap "Go Live" on Channel #${channelId}. The video will appear automatically!</div>
        </div>
      </div>
    </div>

    <div class="chat-area">
      <div class="chat-header">
        <span>💬 Live Chat</span>
        <span id="viewerCount" style="color: #94A3B8; font-size: 12px;">Active</span>
      </div>
      <div class="chat-messages" id="chatBox"></div>
      <div class="reactions-bar">
        <button class="reaction-btn" onclick="sendReaction('❤️')">❤️</button>
        <button class="reaction-btn" onclick="sendReaction('🔥')">🔥</button>
        <button class="reaction-btn" onclick="sendReaction('👏')">👏</button>
        <button class="reaction-btn" onclick="sendReaction('🚀')">🚀</button>
        <button class="reaction-btn" onclick="sendReaction('🎉')">🎉</button>
      </div>
      <div class="chat-input-bar">
        <input type="text" id="chatInput" class="chat-input" placeholder="Type a message..." maxlength="200" onkeydown="if(event.key==='Enter') sendChat()">
        <button class="send-btn" onclick="sendChat()">Send</button>
      </div>
    </div>
  </div>

  <script>
    const channelId = '${channelId}';
    const streamImg = document.getElementById('streamImg');
    const standbyOverlay = document.getElementById('standbyOverlay');
    const liveBadge = document.getElementById('liveBadge');
    const liveText = document.getElementById('liveText');
    const chatBox = document.getElementById('chatBox');
    const chatInput = document.getElementById('chatInput');
    const streamAudio = document.getElementById('streamAudio');
    const audioBtn = document.getElementById('audioBtn');

    let audioCtx = null;
    let audioReader = null;
    let isAudioPlaying = false;
    let nextAudioTime = 0;

    async function toggleAudio() {
      if (isAudioPlaying) {
        stopAudio();
      } else {
        await startAudio();
      }
    }

    async function startAudio() {
      try {
        if (!audioCtx) {
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          if (AudioContextClass) {
            audioCtx = new AudioContextClass({ sampleRate: 44100 });
          }
        }
        if (audioCtx && audioCtx.state === 'suspended') {
          await audioCtx.resume();
        }

        audioBtn.innerText = '⏳ Connecting Audio...';
        audioBtn.style.background = '#0E7490';
        audioBtn.style.borderColor = '#00E5FF';

        // High-performance real-time Web Audio API PCM stream
        if (audioCtx && window.ReadableStream) {
          isAudioPlaying = true;
          nextAudioTime = audioCtx.currentTime + 0.05;
          playPcmStream();
        } else {
          playHtmlAudioFallback();
        }
      } catch (err) {
        console.warn('Audio startup error:', err);
        playHtmlAudioFallback();
      }
    }

    async function playPcmStream() {
      try {
        const res = await fetch('/audio/' + channelId + '?t=' + Date.now());
        if (!res.ok || !res.body) {
          throw new Error('Audio stream endpoint not available');
        }

        audioBtn.innerText = '🔊 Sound Live (Playing)';
        audioBtn.style.background = '#10B981';
        audioBtn.style.borderColor = '#10B981';
        audioBtn.style.color = '#FFF';

        const reader = res.body.getReader();
        audioReader = reader;
        let leftover = new Uint8Array(0);

        while (isAudioPlaying) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value || value.length === 0) continue;

          // Merge leftover bytes from previous packet
          const combined = new Uint8Array(leftover.length + value.length);
          combined.set(leftover, 0);
          combined.set(value, leftover.length);

          // 16-bit stereo PCM = 4 bytes per sample (2 bytes L + 2 bytes R)
          const validBytes = Math.floor(combined.length / 4) * 4;
          leftover = combined.slice(validBytes);

          if (validBytes === 0) continue;

          const numSamples = validBytes / 4;
          const audioBuffer = audioCtx.createBuffer(2, numSamples, 44100);
          const channelL = audioBuffer.getChannelData(0);
          const channelR = audioBuffer.getChannelData(1);

          const dataView = new DataView(combined.buffer, combined.byteOffset, validBytes);
          for (let i = 0; i < numSamples; i++) {
            channelL[i] = dataView.getInt16(i * 4, true) / 32768.0;
            channelR[i] = dataView.getInt16(i * 4 + 2, true) / 32768.0;
          }

          const source = audioCtx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(audioCtx.destination);

          const currentTime = audioCtx.currentTime;
          if (nextAudioTime < currentTime) {
            nextAudioTime = currentTime + 0.02;
          }
          source.start(nextAudioTime);
          nextAudioTime += audioBuffer.duration;
        }
      } catch (e) {
        console.warn('Web Audio PCM stream error:', e);
        if (isAudioPlaying) {
          playHtmlAudioFallback();
        }
      }
    }

    function playHtmlAudioFallback() {
      if (!streamAudio) return;
      streamAudio.src = '/audio/' + channelId + '.wav?t=' + Date.now();
      streamAudio.play().then(() => {
        isAudioPlaying = true;
        audioBtn.innerText = '🔊 Audio Live';
        audioBtn.style.background = '#10B981';
        audioBtn.style.borderColor = '#10B981';
        audioBtn.style.color = '#FFF';
      }).catch(err => {
        console.warn('Fallback audio playback error:', err);
        stopAudio();
      });
    }

    function stopAudio() {
      isAudioPlaying = false;
      if (audioReader) {
        try { audioReader.cancel(); } catch (_) {}
        audioReader = null;
      }
      if (streamAudio) {
        streamAudio.pause();
        streamAudio.removeAttribute('src');
      }
      audioBtn.innerText = '🔇 Audio Muted (Tap to Play)';
      audioBtn.style.background = '#1E293B';
      audioBtn.style.borderColor = '#00E5FF';
      audioBtn.style.color = '#00E5FF';
    }

    let isLive = false;
    let pollInterval = null;

    function handleStreamError() {
      standbyOverlay.style.display = 'flex';
      liveBadge.style.background = '#64748B';
      liveText.innerText = 'OFFLINE';
      isLive = false;
      if (!pollInterval) {
        pollInterval = setInterval(checkStatus, 3000);
      }
    }

    function handleStreamLoaded() {
      standbyOverlay.style.display = 'none';
      liveBadge.style.background = '#EF4444';
      liveText.innerText = 'LIVE';
      isLive = true;
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      updateOrientationIndicator();
    }

    function updateOrientationIndicator() {
      if (!streamImg.naturalWidth || !streamImg.naturalHeight) return;
      const w = streamImg.naturalWidth;
      const h = streamImg.naturalHeight;
      const isLandscape = w > h;
      const tag = document.getElementById('feedOrientationTag');
      if (tag) {
        tag.innerText = (isLandscape ? '🖥️ Landscape ' : '📱 Portrait ') + w + '×' + h;
        tag.style.display = 'inline-block';
      }
    }

    function toggleFullscreen() {
      const vp = document.getElementById('viewport');
      if (!document.fullscreenElement) {
        if (vp.requestFullscreen) {
          vp.requestFullscreen();
        } else if (vp.webkitRequestFullscreen) {
          vp.webkitRequestFullscreen();
        }
        document.getElementById('fsBtn').innerText = '✕ Exit Fullscreen';
      } else {
        if (document.exitFullscreen) {
          document.exitFullscreen();
        }
        document.getElementById('fsBtn').innerText = '⛶ Fullscreen';
      }
    }

    document.addEventListener('fullscreenchange', () => {
      const fsBtn = document.getElementById('fsBtn');
      if (fsBtn) {
        fsBtn.innerText = document.fullscreenElement ? '✕ Exit Fullscreen' : '⛶ Fullscreen';
      }
    });

    let isFillMode = false;
    function toggleAspect() {
      isFillMode = !isFillMode;
      const btn = document.getElementById('aspectBtn');
      if (isFillMode) {
        streamImg.classList.add('fill-mode');
        btn.innerText = '🔲 Fill Mode';
        btn.style.color = '#00E5FF';
      } else {
        streamImg.classList.remove('fill-mode');
        btn.innerText = '🔲 Fit Mode';
        btn.style.color = '#E2E8F0';
      }
    }

    let isTheater = false;
    function toggleTheater() {
      isTheater = !isTheater;
      const mc = document.getElementById('mainContainer');
      const btn = document.getElementById('theaterBtn');
      if (isTheater) {
        mc.classList.add('theater-mode');
        btn.innerText = '💬 Show Chat';
      } else {
        mc.classList.remove('theater-mode');
        btn.innerText = '💬 Hide Chat';
      }
    }

    async function checkStatus() {
      try {
        const res = await fetch('/snapshot/' + channelId, { cache: 'no-store' });
        if (res.ok) {
          streamImg.src = '/stream/' + channelId + '?t=' + Date.now();
        }
      } catch (_) {}
    }

    let lastChatId = '';
    async function loadChat() {
      try {
        const res = await fetch('/chat/messages?channel=' + channelId);
        if (res.ok) {
          const list = await res.json();
          chatBox.innerHTML = '';
          list.forEach(item => {
            const div = document.createElement('div');
            div.className = 'chat-msg';
            div.innerHTML = '<div class="chat-sender ' + (item.isAdmin ? 'admin' : '') + '">' + escapeHtml(item.sender) + '</div><div>' + escapeHtml(item.message) + '</div>';
            chatBox.appendChild(div);
          });
          chatBox.scrollTop = chatBox.scrollHeight;
        }
      } catch (_) {}
    }

    async function sendChat() {
      const msg = chatInput.value.trim();
      if (!msg) return;
      chatInput.value = '';
      try {
        await fetch('/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sender: 'Web Viewer', message: msg, channel: channelId })
        });
        loadChat();
      } catch (_) {}
    }

    async function sendReaction(emoji) {
      animateReaction(emoji);
      try {
        await fetch('/reaction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emoji: emoji, channel: channelId })
        });
      } catch (_) {}
    }

    function animateReaction(emoji) {
      const el = document.createElement('div');
      el.className = 'flying-reaction';
      el.innerText = emoji;
      el.style.right = (20 + Math.random() * 40) + 'px';
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 2000);
    }

    function escapeHtml(str) {
      return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    setInterval(loadChat, 2000);
    loadChat();
  </script>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ScreenStream Relay] Server running on http://0.0.0.0:${PORT}`);
  console.log(`[ScreenStream Relay] Watch live at: http://localhost:${PORT}/watch/ADMIN-LIVE-77`);
  console.log(`[ScreenStream Relay] Ready to receive stream frames via POST /publish/:channelId`);
});

process.on('SIGTERM', () => {
  console.log('[ScreenStream Relay] SIGTERM received, shutting down gracefully...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[ScreenStream Relay] SIGINT received, shutting down...');
  server.close(() => process.exit(0));
});