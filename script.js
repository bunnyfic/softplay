(() => {
  const $ = s => document.querySelector(s);
  const audio = $('#audio');
  const S = { tracks: [], cur: -1, shuffle: false, repeat: 0, sleepIdx: 0, sleepTimer: null, wake: null, wantWake: false, pal: 0, armed: false };
  const PAL = ['blush', 'lilac', 'champagne', 'sage'];
  const SLEEP = [0, 15, 30, 60];

  const fmt = s => { if (!isFinite(s)) s = 0; s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let toastT;
  function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200); }

  /* ---------- storage (IndexedDB, best effort) ---------- */
  let db = null;
  const openDB = () => new Promise(res => {
    try {
      const r = indexedDB.open('softplay', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('tracks', { keyPath: 'id', autoIncrement: true });
      r.onsuccess = () => res(r.result); r.onerror = () => res(null); r.onblocked = () => res(null);
    } catch (e) { res(null); }
  });
  const tx = (mode, fn) => new Promise(res => {
    if (!db) return res(null);
    try {
      const t = db.transaction('tracks', mode); let rq;
      try { rq = fn(t.objectStore('tracks')); } catch (e) { return res(null); }
      t.oncomplete = () => res(rq ? rq.result : null); t.onerror = t.onabort = () => res(null);
    } catch (e) { res(null); }
  });
  const persist = t => tx('readwrite', st => st.put({ id: t.id, title: t.title, artist: t.artist, blob: t.blob, cover: t.cover, liked: t.liked }));

  /* ---------- ID3 tags (title, artist, cover) ---------- */
  function decodeText(b) {
    if (!b.length) return '';
    const enc = b[0], d = b.subarray(1);
    let s = '';
    try {
      if (enc === 0) s = new TextDecoder('iso-8859-1').decode(d);
      else if (enc === 3) s = new TextDecoder('utf-8').decode(d);
      else if (enc === 2) s = new TextDecoder('utf-16be').decode(d);
      else if (d[0] === 0xFE && d[1] === 0xFF) s = new TextDecoder('utf-16be').decode(d.subarray(2));
      else if (d[0] === 0xFF && d[1] === 0xFE) s = new TextDecoder('utf-16le').decode(d.subarray(2));
      else s = new TextDecoder('utf-16le').decode(d);
    } catch (e) { return ''; }
    return s.split('\0')[0].trim();
  }
  function decodePic(b, v2) {
    const enc = b[0]; let p = 1;
    if (v2) p += 3; else { while (p < b.length && b[p] !== 0) p++; p++; }
    p++; // picture type
    if (enc === 1 || enc === 2) { while (p + 1 < b.length && !(b[p] === 0 && b[p + 1] === 0)) p += 2; p += 2; }
    else { while (p < b.length && b[p] !== 0) p++; p++; }
    const data = b.subarray(p);
    if (data.length < 100) return null;
    return new Blob([data], { type: data[0] === 0x89 ? 'image/png' : 'image/jpeg' });
  }
  async function readTags(file) {
    try {
      const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
      if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return {};
      const ver = head[3];
      const size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
      if (!size || size > 14e6) return {};
      const buf = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
      const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10, out = {};
      let p = 0;
      while (p + hdr <= buf.length) {
        const id = String.fromCharCode(...buf.subarray(p, p + idLen));
        if (!/^[A-Z0-9]+$/.test(id)) break;
        let fs;
        if (ver === 2) fs = (buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5];
        else if (ver === 4) fs = (buf[p + 4] << 21) | (buf[p + 5] << 14) | (buf[p + 6] << 7) | buf[p + 7];
        else fs = ((buf[p + 4] << 24) | (buf[p + 5] << 16) | (buf[p + 6] << 8) | buf[p + 7]) >>> 0;
        const body = buf.subarray(p + hdr, p + hdr + fs);
        p += hdr + fs;
        if (id === 'TIT2' || id === 'TT2') out.title = decodeText(body);
        else if (id === 'TPE1' || id === 'TP1') out.artist = decodeText(body);
        else if ((id === 'APIC' || id === 'PIC') && !out.cover) out.cover = decodePic(body, ver === 2);
        if (out.title && out.artist && out.cover) break;
      }
      return out;
    } catch (e) { return {}; }
  }
  function guessName(fn) {
    const base = fn.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/^\d+[\s.\-_)]+/, '').trim();
    const m = base.split(/\s+-\s+/);
    return m.length > 1 ? { artist: m[0].trim(), title: m.slice(1).join(' - ').trim() } : { artist: 'unknown artist', title: base || 'untitled' };
  }

  /* ---------- tracks ---------- */
  const mk = (rec, id) => ({
    id: id ?? 't' + Math.random().toString(36).slice(2), title: rec.title, artist: rec.artist, blob: rec.blob, cover: rec.cover || null, liked: !!rec.liked,
    url: URL.createObjectURL(rec.blob), coverUrl: rec.cover ? URL.createObjectURL(rec.cover) : ''
  });

  async function addFiles(list) {
    const files = [...list].filter(f => /^audio\//.test(f.type) || /\.(mp3|m4a|aac|wav|flac|ogg|opus|weba)$/i.test(f.name));
    if (!files.length) { toast('pick some audio files'); return; }
    const wasEmpty = S.tracks.length === 0;
    toast('adding ' + files.length + (files.length > 1 ? ' songs…' : ' song…'));
    for (const f of files) {
      const tg = await readTags(f), g = guessName(f.name);
      const rec = { title: tg.title || g.title, artist: tg.artist || g.artist, blob: f, cover: tg.cover || null, liked: false };
      const id = await tx('readwrite', st => st.add(rec));
      S.tracks.push(mk(rec, id));
    }
    toast(files.length + (files.length > 1 ? ' songs added ♡' : ' song added ♡'));
    if (wasEmpty) load(0, false); else render();
  }

  function load(i, play) {
    const t = S.tracks[i]; if (!t) return;
    S.cur = i; audio.src = t.url; audio.defaultPlaybackRate = rate; audio.playbackRate = rate;
    if (play) audio.play().catch(() => {});
    render(); session(t);
  }
  function togglePlay() {
    if (!S.tracks.length) { $('#file').click(); return; }
    if (S.cur < 0) { load(0, true); return; }
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
  }
  function advance(auto) {
    const n = S.tracks.length; if (!n) return;
    let i;
    if (S.shuffle && n > 1) { do { i = Math.floor(Math.random() * n); } while (i === S.cur); }
    else { i = S.cur + 1; if (i >= n) { if (auto && S.repeat === 0) { load(0, false); return; } i = 0; } }
    load(i, true);
  }
  function back() {
    const n = S.tracks.length; if (!n) return;
    if (audio.currentTime > 3 || n < 2) { audio.currentTime = 0; return; }
    load((S.cur - 1 + n) % n, true);
  }
  function removeTrack(i) {
    const t = S.tracks[i]; if (!t) return;
    tx('readwrite', st => st.delete(t.id));
    URL.revokeObjectURL(t.url); if (t.coverUrl) URL.revokeObjectURL(t.coverUrl);
    const wasCur = i === S.cur, wasPlaying = !audio.paused;
    S.tracks.splice(i, 1);
    if (!S.tracks.length) { audio.pause(); audio.removeAttribute('src'); audio.load(); S.cur = -1; }
    else if (wasCur) { load(Math.min(i, S.tracks.length - 1), wasPlaying); }
    else if (i < S.cur) S.cur--;
    render();
  }

  /* ---------- render ---------- */
  const countText = n => n + (n === 1 ? ' song' : ' songs');
  function render() {
    const t = S.tracks[S.cur], n = S.tracks.length;
    $('#title').textContent = t ? t.title : 'nothing playing';
    $('#artist').textContent = t ? t.artist : 'your songs, softly';
    $('#ctaAdd').hidden = n > 0;
    const cv = $('#cover'), am = $('#ambient');
    if (t && t.coverUrl) { cv.src = t.coverUrl; cv.hidden = false; $('#ph').hidden = true; am.src = t.coverUrl; am.hidden = false; }
    else { cv.hidden = true; cv.removeAttribute('src'); $('#ph').hidden = false; am.hidden = true; am.removeAttribute('src'); }
    $('#status').textContent = countText(n);
    $('#qCount').textContent = countText(n);
    const like = $('#bLike'); like.classList.toggle('on', !!(t && t.liked)); like.setAttribute('aria-pressed', !!(t && t.liked));
    // up next tile
    if (n < 2) { $('#npLabel').textContent = n ? 'now playing' : 'up next'; $('#npTitle').textContent = n ? t.title : 'nothing yet'; $('#npArtist').textContent = n ? t.artist : 'add songs to start'; }
    else if (S.shuffle) { $('#npLabel').textContent = 'shuffle on'; $('#npTitle').textContent = 'surprise me'; $('#npArtist').textContent = countText(n) + ' in the mix'; }
    else { const nx = S.tracks[(S.cur + 1) % n]; $('#npLabel').textContent = 'up next'; $('#npTitle').textContent = nx.title; $('#npArtist').textContent = nx.artist; }
    if (!$('#scrim').hidden) renderList();
  }
  function renderList() {
    const el = $('#list');
    if (!S.tracks.length) { el.innerHTML = '<p class="empty">nothing here yet.<br>tap the tulip to add songs from your phone.</p>'; return; }
    el.innerHTML = S.tracks.map((t, i) => `
      <div class="row${i === S.cur ? ' cur' : ''}">
        <button class="go" data-go="${i}" aria-label="Play ${esc(t.title)}">
          <span class="thumb">${t.coverUrl ? `<img src="${t.coverUrl}" alt="">` : '<svg class="ic"><use href="#i-note"/></svg>'}</span>
          <span class="tx"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></span>
        </button>
        ${t.liked ? '<svg class="ic heart"><use href="#i-heart"/></svg>' : ''}
        <button class="rm" data-rm="${i}" aria-label="Remove ${esc(t.title)}"><svg class="ic"><use href="#i-x"/></svg></button>
      </div>`).join('');
  }
  $('#list').addEventListener('click', e => {
    const go = e.target.closest('[data-go]'), rm = e.target.closest('[data-rm]');
    if (go) { load(+go.dataset.go, true); }
    else if (rm) removeTrack(+rm.dataset.rm);
  });

  /* ---------- audio events ---------- */
  const setPlayIcon = () => {
    const p = !audio.paused;
    $('#playUse').setAttribute('href', p ? '#i-pause' : '#i-play');
    $('#bPlay').setAttribute('aria-label', p ? 'Pause' : 'Play');
    $('#eq').classList.toggle('live', p && !audio.muted);
    if ('mediaSession' in navigator) try { navigator.mediaSession.playbackState = p ? 'playing' : 'paused'; } catch (e) {}
  };
  audio.addEventListener('play', setPlayIcon); audio.addEventListener('pause', setPlayIcon);
  const scrub = $('#scrub');
  function tick() {
    const d = audio.duration, c = audio.currentTime;
    if (isFinite(d) && d > 0) { scrub.max = d; scrub.value = c; scrub.style.setProperty('--p', (c / d * 100) + '%'); }
    else { scrub.value = 0; scrub.style.setProperty('--p', '0%'); }
    $('#tCur').textContent = fmt(c);
    $('#tLeft').textContent = '-' + fmt(isFinite(d) ? d - c : 0);
  }
  audio.addEventListener('timeupdate', tick); audio.addEventListener('loadedmetadata', tick); audio.addEventListener('durationchange', tick); audio.addEventListener('emptied', tick);
  scrub.addEventListener('input', () => { audio.currentTime = +scrub.value; tick(); });
  audio.addEventListener('ended', () => { if (S.repeat === 2) { audio.currentTime = 0; audio.play().catch(() => {}); return; } advance(true); });
  audio.addEventListener('error', () => { if (S.tracks.length) toast("couldn't play that file"); });

  function session(t) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, artwork: t.coverUrl ? [{ src: t.coverUrl, sizes: '512x512', type: t.cover ? t.cover.type : 'image/jpeg' }] : [] });
      navigator.mediaSession.setActionHandler('play', () => audio.play());
      navigator.mediaSession.setActionHandler('pause', () => audio.pause());
      navigator.mediaSession.setActionHandler('previoustrack', back);
      navigator.mediaSession.setActionHandler('nexttrack', () => advance(false));
    } catch (e) {}
  }

  /* ---------- vertical sliders ---------- */
  function vslider(el, init, onChange) {
    let v = init;
    const set = n => { v = Math.min(1, Math.max(0, n)); el.style.setProperty('--v', (v * 100) + '%'); el.setAttribute('aria-valuenow', Math.round(v * 100)); onChange(v); };
    const fromEvent = e => { const r = el.getBoundingClientRect(); set(1 - (e.clientY - r.top) / r.height); };
    el.addEventListener('pointerdown', e => { try { el.setPointerCapture(e.pointerId); } catch (x) {} fromEvent(e); });
    el.addEventListener('pointermove', e => { if (el.hasPointerCapture && el.hasPointerCapture(e.pointerId)) fromEvent(e); });
    el.addEventListener('keydown', e => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { set(v + .05); e.preventDefault(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { set(v - .05); e.preventDefault(); }
    });
    set(init);
  }
  let rate = 1;
  vslider($('#volS'), .8, v => { audio.volume = v; $('#volVal').textContent = Math.round(v * 100); });
  vslider($('#spdS'), .5, v => {
    let r = Math.round((0.5 + v) * 20) / 20; if (Math.abs(r - 1) < .04) r = 1;
    rate = r; audio.defaultPlaybackRate = r; audio.playbackRate = r;
    $('#spdVal').textContent = r.toFixed(2).replace(/0$/, '') + '×';
  });

  /* ---------- buttons ---------- */
  $('#bPlay').onclick = togglePlay;
  $('#bNext').onclick = () => advance(false);
  $('#bPrev').onclick = back;
  $('#bAdd').onclick = $('#ctaAdd').onclick = () => $('#file').click();
  $('#art').onclick = () => { if (!S.tracks.length) $('#file').click(); };
  $('#file').onchange = e => { addFiles(e.target.files); e.target.value = ''; };

  $('#bShuffle').onclick = () => {
    S.shuffle = !S.shuffle; const b = $('#bShuffle');
    b.classList.toggle('on', S.shuffle); b.setAttribute('aria-pressed', S.shuffle);
    toast(S.shuffle ? 'shuffle on' : 'shuffle off'); render();
  };
  $('#bRepeat').onclick = () => {
    S.repeat = (S.repeat + 1) % 3; const b = $('#bRepeat');
    b.classList.toggle('on', S.repeat > 0); $('#repBadge').hidden = S.repeat !== 2;
    const label = ['repeat off', 'repeat all', 'repeat one'][S.repeat];
    b.setAttribute('aria-label', 'Repeat: ' + label.slice(7)); toast(label);
  };
  $('#bLike').onclick = () => {
    const t = S.tracks[S.cur]; if (!t) { toast('play a song first'); return; }
    t.liked = !t.liked; persist(t); toast(t.liked ? 'liked ♡' : 'unliked'); render();
  };
  $('#bMute').onclick = () => {
    audio.muted = !audio.muted; const b = $('#bMute');
    b.classList.toggle('on', audio.muted); b.setAttribute('aria-pressed', audio.muted);
    toast(audio.muted ? 'muted' : 'sound on'); setPlayIcon();
  };

  function setSleep(i) {
    S.sleepIdx = i; clearTimeout(S.sleepTimer);
    const m = SLEEP[i];
    $('#sleepLabel').textContent = m ? m + ' min' : 'sleep';
    $('#bSleep').classList.toggle('on', !!m);
    if (m) S.sleepTimer = setTimeout(() => { audio.pause(); setSleep(0); toast('good night ♡'); }, m * 60000);
  }
  $('#bSleep').onclick = () => { setSleep((S.sleepIdx + 1) % SLEEP.length); toast(SLEEP[S.sleepIdx] ? 'sleep in ' + SLEEP[S.sleepIdx] + ' min' : 'sleep timer off'); };

  async function wake(on) {
    S.wantWake = on;
    try {
      if (on) {
        S.wake = await navigator.wakeLock.request('screen');
        S.wake.addEventListener('release', () => { if (!S.wantWake) paintWake(false); });
      } else if (S.wake) { await S.wake.release(); S.wake = null; }
    } catch (e) { S.wantWake = false; S.wake = null; toast('screen-awake isn’t available here'); }
    paintWake(S.wantWake);
  }
  function paintWake(on) { const b = $('#bSun'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }
  $('#bSun').onclick = async () => { await wake(!S.wantWake); if (S.wantWake) toast('screen stays on'); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.wantWake) wake(true); });

  function setPal(i, say) {
    S.pal = i; document.documentElement.dataset.palette = PAL[i];
    try { localStorage.setItem('softplay-pal', String(i)); } catch (e) {}
    if (say) toast(PAL[i]);
  }
  $('#bTheme').onclick = () => setPal((S.pal + 1) % PAL.length, true);

  let armT;
  $('#bClear').onclick = async () => {
    if (!S.tracks.length) { toast('library is already empty'); return; }
    const b = $('#bClear');
    if (!S.armed) { S.armed = true; b.classList.add('armed'); toast('tap again to clear all songs'); armT = setTimeout(() => { S.armed = false; b.classList.remove('armed'); }, 3000); return; }
    clearTimeout(armT); S.armed = false; b.classList.remove('armed');
    audio.pause(); audio.removeAttribute('src'); audio.load();
    S.tracks.forEach(t => { URL.revokeObjectURL(t.url); if (t.coverUrl) URL.revokeObjectURL(t.coverUrl); });
    S.tracks = []; S.cur = -1; await tx('readwrite', st => st.clear()); render(); toast('library cleared');
  };

  /* queue sheet */
  const scrim = $('#scrim');
  $('#bQueue').onclick = () => { scrim.hidden = false; renderList(); };
  scrim.addEventListener('click', e => { if (e.target === scrim) scrim.hidden = true; });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') scrim.hidden = true;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'button' || e.target.getAttribute('role') === 'slider') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight') audio.currentTime += 5;
    else if (e.key === 'ArrowLeft') audio.currentTime -= 5;
  });

  /* drag and drop (desktop) */
  let dragN = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); dragN++; document.body.classList.add('drop'); });
  window.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; document.body.classList.remove('drop'); } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => { e.preventDefault(); dragN = 0; document.body.classList.remove('drop'); if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });

  /* ---------- boot ---------- */
  (async () => {
    try { const p = parseInt(localStorage.getItem('softplay-pal'), 10); if (p >= 0 && p < PAL.length) setPal(p); } catch (e) {}
    db = await openDB();
    const saved = await tx('readonly', st => st.getAll());
    if (saved && saved.length) { saved.forEach(r => S.tracks.push(mk(r, r.id))); load(0, false); }
    else render();
    setPlayIcon(); tick();
  })();
})();
