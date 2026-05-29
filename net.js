/* net.js — window.Net WebRTC transport for boba-game-lab
 * TRANSPORT ONLY. No game logic. STAR topology:
 *   HOST is authoritative; CLIENTS connect to host, send inputs, receive state.
 * Built on PeerJS (window.Peer, loaded from CDN).
 * Public broker: PeerJS cloud (0.peerjs.com). STUN: Google. TURN: openrelay (free).
 */
(function () {
  'use strict';

  // ---- ICE config (NAT traversal) -----------------------------------------
  // Fresh TURN credentials are minted at load from Cloudflare Realtime TURN
  // (free 1 TB/mo). Cloudflare caps credential TTL at 48h, so we fetch at runtime
  // instead of hardcoding. Google STUN + Metered TURN stay as a fallback if the
  // Cloudflare fetch ever fails. TURN is ICE's last resort, so relay quota is
  // only spent when a direct path can't be found. (The token is TURN-scoped:
  // worst-case misuse = someone burning relay quota, not account access.)
  var CF_TURN_KEY = 'de055d5d23b5ea426bf8fc5a2feff322';
  var CF_TURN_TOKEN = 'f8e28b59bb885fa75efbfc2f9d4c7774b4264a392fe08e2896a5157e6bf17208';
  var MET_USER = '36f88ac897988038e74fd591';
  var MET_CRED = 'sZ/SncSl3zR0KUrC';

  var FALLBACK_ICE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:standard.relay.metered.ca:80', username: MET_USER, credential: MET_CRED },
    { urls: 'turn:standard.relay.metered.ca:443', username: MET_USER, credential: MET_CRED },
    { urls: 'turns:standard.relay.metered.ca:443?transport=tcp', username: MET_USER, credential: MET_CRED }
  ];

  var PEER_CONFIG = { config: { iceServers: FALLBACK_ICE } };

  // Fetch Cloudflare ICE servers once; resolve PEER_CONFIG before any Peer is made.
  var _icePromise = null;
  function ensureIce() {
    if (_icePromise) return _icePromise;
    var url = 'https://rtc.live.cloudflare.com/v1/turn/keys/' + CF_TURN_KEY +
      '/credentials/generate-ice-servers';
    _icePromise = fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + CF_TURN_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.iceServers && j.iceServers.length) {
        // Cloudflare first; keep STUN/metered after as resilience.
        PEER_CONFIG = { config: { iceServers: j.iceServers.concat(FALLBACK_ICE) } };
      }
      return PEER_CONFIG;
    }).catch(function () { return PEER_CONFIG; });
    return _icePromise;
  }

  var CODE_PREFIX = 'glab-'; // namespaces our PeerJS ids so codes stay short
  var CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no confusing 0/O/1/I/L

  function makeCode(n) {
    n = n || 4;
    var s = '';
    for (var i = 0; i < n; i++) s += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
    return s;
  }
  function peerIdFor(code) { return CODE_PREFIX + String(code).toUpperCase(); }
  function normalize(code) { return String(code || '').trim().toUpperCase(); }

  // ============================ HOST =======================================
  function hostRoom(opts) {
    opts = opts || {};
    var maxPlayers = opts.maxPlayers || 8;
    var onJoin = opts.onJoin || function () {};
    var onLeave = opts.onLeave || function () {};
    var onData = opts.onData || function () {};

    return ensureIce().then(function () { return new Promise(function (resolve, reject) {
      var attempts = 0;
      function tryHost() {
        var code = makeCode(4);
        var peer = new window.Peer(peerIdFor(code), PEER_CONFIG);
        var conns = {}; // peerId -> DataConnection

        peer.on('open', function (myId) {
          resolve({
            roomCode: code,
            myId: myId,
            peers: function () { return Object.keys(conns); },
            broadcast: function (msg) {
              var data = JSON.stringify(msg);
              for (var id in conns) { try { conns[id].send(data); } catch (e) {} }
            },
            sendTo: function (peerId, msg) {
              var c = conns[peerId];
              if (c) { try { c.send(JSON.stringify(msg)); } catch (e) {} }
            },
            close: function () { try { peer.destroy(); } catch (e) {} }
          });
        });

        peer.on('connection', function (conn) {
          if (Object.keys(conns).length >= maxPlayers - 1) {
            try { conn.close(); } catch (e) {}
            return;
          }
          conn.on('open', function () {
            conns[conn.peer] = conn;
            onJoin(conn.peer);
          });
          conn.on('data', function (raw) {
            var msg; try { msg = JSON.parse(raw); } catch (e) { msg = raw; }
            onData(conn.peer, msg);
          });
          var gone = false;
          function drop() {
            if (gone) return; gone = true;
            if (conns[conn.peer]) { delete conns[conn.peer]; onLeave(conn.peer); }
          }
          conn.on('close', drop);
          conn.on('error', drop);
        });

        peer.on('error', function (err) {
          if (err && err.type === 'unavailable-id' && attempts < 5) {
            attempts++;
            try { peer.destroy(); } catch (e) {}
            tryHost(); // code collision — pick another
            return;
          }
          reject(err);
        });
      }
      tryHost();
    }); });
  }

  // ============================ CLIENT =====================================
  function joinRoom(roomCode, opts) {
    opts = opts || {};
    var onDataCb = opts.onData || function () {};
    var onOpen = opts.onOpen || function () {};
    var onClose = opts.onClose || function () {};
    var onError = opts.onError || function () {};
    var code = normalize(roomCode);

    return ensureIce().then(function () { return new Promise(function (resolve, reject) {
      var peer = new window.Peer(PEER_CONFIG); // random client id
      var settled = false;

      // Don't hang forever on "joining" — if the connection can't be established
      // (wrong code, host left, or NAT can't be traversed) surface a clear error.
      var JOIN_TIMEOUT_MS = 15000;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { peer.destroy(); } catch (e) {}
        var err = new Error("Couldn't connect to room " + code +
          ". Check the code, or ask the host to share the link again.");
        try { toast("Couldn't connect — check the code or get a fresh link"); } catch (e) {}
        onError(err); onClose(); reject(err);
      }, JOIN_TIMEOUT_MS);

      peer.on('open', function (myId) {
        var conn = peer.connect(peerIdFor(code), { reliable: true });
        var opened = false;

        conn.on('open', function () {
          opened = true;
          clearTimeout(timer);
          var api = {
            myId: myId,
            send: function (msg) { try { conn.send(JSON.stringify(msg)); } catch (e) {} },
            close: function () { try { peer.destroy(); } catch (e) {} }
          };
          settled = true;
          onOpen();
          resolve(api);
        });
        conn.on('data', function (raw) {
          var msg; try { msg = JSON.parse(raw); } catch (e) { msg = raw; }
          onDataCb(msg);
        });
        var closed = false;
        function dropped() {
          if (closed) return; closed = true;
          clearTimeout(timer);
          if (!opened && !settled) { settled = true; reject(new Error('Could not reach room ' + code)); }
          onClose();
        }
        conn.on('close', dropped);
        conn.on('error', function (e) { onError(e); dropped(); });
      });

      peer.on('error', function (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          // peer-unavailable => no such room
          var msg = (err && err.type === 'peer-unavailable')
            ? new Error('Room ' + code + ' not found') : err;
          onError(msg);
          reject(msg);
        } else {
          onError(err);
        }
      });

      peer.on('disconnected', function () {
        // broker dropped us; attempt a silent reconnect to keep signalling alive
        try { peer.reconnect(); } catch (e) {}
      });
    }); });
  }

  // ============================ HELPERS ====================================
  function roomFromUrl() {
    try {
      var p = new URLSearchParams(location.search).get('room');
      if (p) return normalize(p);
    } catch (e) {}
    try {
      var sp = window.Telegram &&
        window.Telegram.WebApp &&
        window.Telegram.WebApp.initDataUnsafe &&
        window.Telegram.WebApp.initDataUnsafe.start_param;
      if (sp) return normalize(sp);
    } catch (e) {}
    return null;
  }

  function currentFolder() {
    // derive '<game>' from /<game>/index.html  (or /<game>/)
    var parts = location.pathname.split('/').filter(Boolean);
    if (!parts.length) return '';
    var last = parts[parts.length - 1];
    if (/\.html?$/i.test(last) || last.indexOf('.') !== -1) parts.pop();
    return parts.length ? parts[parts.length - 1] : '';
  }

  function shareLink(roomCode) {
    // host-agnostic: reuse whatever origin + directory the game is actually served from
    var path = location.pathname;
    if (/\.html?$/i.test(path)) path = path.replace(/[^/]*$/, ''); // strip index.html -> its dir
    if (path.charAt(path.length - 1) !== '/') path += '/';
    return location.origin + path + '?room=' + normalize(roomCode);
  }

  function toast(text) {
    var t = document.createElement('div');
    t.className = 'glab-toast';
    t.textContent = text;
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 400);
    }, 2200);
  }

  function share(roomCode) {
    var link = shareLink(roomCode);
    // always try to put it on the clipboard
    try { if (navigator.clipboard) navigator.clipboard.writeText(link); } catch (e) {}

    var tg = window.Telegram && window.Telegram.WebApp;
    if (tg && typeof tg.openTelegramLink === 'function') {
      var msg = 'Join my game! Room ' + normalize(roomCode);
      tg.openTelegramLink('https://t.me/share/url?url=' +
        encodeURIComponent(link) + '&text=' + encodeURIComponent(msg));
      return link;
    }
    if (navigator.share) {
      navigator.share({ title: 'Join my game', text: 'Room ' + normalize(roomCode), url: link })
        .catch(function () {});
      return link;
    }
    toast('Link copied: ' + link);
    return link;
  }

  window.Net = {
    hostRoom: hostRoom,
    joinRoom: joinRoom,
    roomFromUrl: roomFromUrl,
    shareLink: shareLink,
    share: share,
    toast: toast
  };

  // Warm up TURN credentials immediately so they're ready before the first click.
  try { ensureIce(); } catch (e) {}
})();
