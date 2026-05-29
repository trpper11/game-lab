/* stats.js — window.Stats device-local play-time logging for boba-game-lab.
 * Flip STATS_URL below to a shared JSON endpoint to enable GLOBAL cross-player
 * trending in one line. Empty string = device-local only (always renders).
 */
(function () {
  'use strict';

  // ── Set this to a shared endpoint (e.g. a tiny KV/JSON GET) to turn on
  //    GLOBAL cross-player trending. '' keeps everything device-local. ──
  var STATS_URL = '';

  var GAMES = ['gorge', 'inklash', 'mayhem'];
  var PLAY = 'glab_play_';   // accumulated seconds
  var OPENS = 'glab_opens_'; // session/open counter

  var state = { gameId: null, last: 0, timer: null };

  function getNum(key) {
    var v = parseFloat(localStorage.getItem(key));
    return isFinite(v) ? v : 0;
  }
  function setNum(key, v) {
    try { localStorage.setItem(key, String(v)); } catch (e) {}
  }

  function flush() {
    if (!state.gameId) return;
    var now = Date.now();
    var secs = (now - state.last) / 1000;
    if (secs > 0) {
      setNum(PLAY + state.gameId, getNum(PLAY + state.gameId) + secs);
      state.last = now;
    }
  }

  function start(gameId) {
    if (state.gameId === gameId && state.timer) return; // idempotent
    if (state.gameId) end(); // switch games cleanly
    state.gameId = gameId;
    state.last = Date.now();
    setNum(OPENS + gameId, getNum(OPENS + gameId) + 1);
    state.timer = setInterval(flush, 5000);
  }

  function end() {
    if (!state.gameId) return;
    flush();
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    state.gameId = null;
  }

  function totals() {
    var out = {};
    for (var i = 0; i < GAMES.length; i++) {
      var g = GAMES[i];
      out[g] = { seconds: Math.round(getNum(PLAY + g)), opens: Math.round(getNum(OPENS + g)) };
    }
    return out;
  }

  function global() {
    if (!STATS_URL) return Promise.resolve(totals());
    return fetch(STATS_URL, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('bad'); return r.json(); })
      .catch(function () { return totals(); });
  }

  function fmt(seconds) {
    seconds = Math.max(0, Math.round(seconds || 0));
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm';
    return s + 's';
  }

  // flush on background / unload so time is never lost
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);

  window.Stats = {
    start: start,
    end: end,
    totals: totals,
    global: global,
    fmt: fmt
  };
})();
