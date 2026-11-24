(() => {
  const $ = s => document.querySelector(s);
  const audio = $('#audio');
  const S = {
    tracks: [], lists: [], ctx: 'all', curId: null,
    shuffle: false, repeat: 0, sleepIdx: 0, sleepTimer: null,
    wake: null, wantWake: false, pal: 0, armed: false,
    sheet: null, q: '', choose: null
  };
  const PAL = ['kitty', 'lilac', 'peach', 'mint'];
  const SLEEP = [0, 15, 30, 60];

  const fmt = s => { if (!isFinite(s)) s = 0; s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const countText = n => n + (n === 1 ? ' song' : ' songs');
  const rid = p => p + Math.random().toString(36).slice(2);
  const sameId = (a, b) => String(a) === String(b);
  let toastT;
  function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200); }

  /* ---------- storage (IndexedDB, best effort) ---------- */
  let db = null;
  const openDB = () => new Promise(res => {
    try {
      const r = indexedDB.open('softplay', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('tracks')) d.createObjectStore('tracks', { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains('lists')) d.createObjectStore('lists', { keyPath: 'id', autoIncrement: true });
      };
      r.onsuccess = () => res(r.result); r.onerror = () => res(null); r.onblocked = () => res(null);
    } catch (e) { res(null); }
  });
  const tx = (store, mode, fn) => new Promise(res => {
    if (!db) return res(null);
    try {
      const t = db.transaction(store, mode); let rq;
      try { rq = fn(t.objectStore(store)); } catch (e) { return res(null); }
      t.oncomplete = () => res(rq ? rq.result : null); t.onerror = t.onabort = () => res(null);
    } catch (e) { res(null); }
  });
  const saveTrack = t => tx('tracks', 'readwrite', st => st.put({ id: t.id, title: t.title, artist: t.artist, blob: t.blob, cover: t.cover, cover0: t.cover0, liked: t.liked }));
  const saveList = l => tx('lists', 'readwrite', st => st.put({ id: l.id, name: l.name, cover: l.cover, trackIds: l.trackIds }));

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
    p++;
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

  /* ---------- pictures (pick, crop square, shrink) ---------- */
  let imgCb = null;
  function pickImage(cb) { imgCb = cb; $('#imgFile').click(); }
  async function squareImage(file, size = 512) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const s = Math.min(img.naturalWidth, img.naturalHeight), out = Math.min(size, s);
      const c = document.createElement('canvas'); c.width = c.height = out;
      c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, out, out);
      return await new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('blob')), 'image/jpeg', .88));
    } finally { URL.revokeObjectURL(url); }
  }
  $('#imgFile').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f || !imgCb) return;
    const cb = imgCb; imgCb = null;
    try { cb(await squareImage(f)); } catch (err) { toast("couldn't read that picture"); }
  };
  const coverHTML = (url, icon) => url ? `<img src="${url}" alt="">` : `<svg class="ic"><use href="${icon}"/></svg>`;

  /* ---------- songs and playlists ---------- */
  const mk = (rec, id) => ({
    id: id ?? rid('t'), title: rec.title, artist: rec.artist, blob: rec.blob,
    cover: rec.cover || null, cover0: (rec.cover0 === undefined ? rec.cover : rec.cover0) || null, liked: !!rec.liked,
    url: URL.createObjectURL(rec.blob), coverUrl: rec.cover ? URL.createObjectURL(rec.cover) : ''
  });
  const mkList = (rec, id) => ({
    id: id ?? rid('p'), name: rec.name, cover: rec.cover || null, trackIds: rec.trackIds || [],
    coverUrl: rec.cover ? URL.createObjectURL(rec.cover) : ''
  });
  const byId = id => S.tracks.find(t => t.id === id);
  const listById = id => S.lists.find(l => l.id === id);
  const trackByStr = s => S.tracks.find(t => sameId(t.id, s));
  const listByStr = s => S.lists.find(l => sameId(l.id, s));
  const queue = () => {
    if (S.ctx !== 'all') { const l = listById(S.ctx); if (l) return l.trackIds.map(byId).filter(Boolean); }
    return S.tracks;
  };
  const cur = () => byId(S.curId);
  const curIdx = () => queue().findIndex(t => t.id === S.curId);
  const listCover = l => l.coverUrl || ((l.trackIds.map(byId).find(t => t && t.coverUrl)) || {}).coverUrl || '';
  function setTrackCover(t, blob) {
    if (t.coverUrl) URL.revokeObjectURL(t.coverUrl);
    t.cover = blob || null; t.coverUrl = blob ? URL.createObjectURL(blob) : '';
  }
  function setListCover(l, blob) {
    if (l.coverUrl) URL.revokeObjectURL(l.coverUrl);
    l.cover = blob || null; l.coverUrl = blob ? URL.createObjectURL(blob) : '';
  }

  async function addFiles(list) {
    const files = [...list].filter(f => /^audio\//.test(f.type) || /\.(mp3|m4a|aac|wav|flac|ogg|opus|weba)$/i.test(f.name));
    if (!files.length) { toast('pick some audio files'); return; }
    const wasEmpty = S.tracks.length === 0;
    toast('adding ' + files.length + (files.length > 1 ? ' songs…' : ' song…'));
    for (const f of files) {
      const tg = await readTags(f), g = guessName(f.name);
      const rec = { title: tg.title || g.title, artist: tg.artist || g.artist, blob: f, cover: tg.cover || null, cover0: tg.cover || null, liked: false };
      const id = await tx('tracks', 'readwrite', st => st.add(rec));
      S.tracks.push(mk(rec, id));
    }
    toast(files.length + (files.length > 1 ? ' songs added ♡' : ' song added ♡'));
    if (wasEmpty) load(S.tracks[0], false, 'all'); else render();
  }

  function load(t, play, ctx) {
    if (!t) return;
    if (ctx !== undefined) S.ctx = ctx;
    S.curId = t.id; audio.src = t.url; audio.defaultPlaybackRate = rate; audio.playbackRate = rate;
    if (play) audio.play().catch(() => {});
    render(); session(t);
  }
  function togglePlay() {
    if (!S.tracks.length) { $('#file').click(); return; }
    if (!cur()) { load(queue()[0] || S.tracks[0], true); return; }
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
  }
  function advance(auto) {
    const q = queue(), n = q.length; if (!n) return;
    const c = curIdx(); let i;
    if (S.shuffle && n > 1) { do { i = Math.floor(Math.random() * n); } while (i === c); }
    else { i = c + 1; if (i >= n) { if (auto && S.repeat === 0) { load(q[0], false); return; } i = 0; } }
    load(q[i], true);
  }
  function back() {
    const q = queue(), n = q.length; if (!n) return;
    if (audio.currentTime > 3 || n < 2) { audio.currentTime = 0; return; }
    load(q[(curIdx() - 1 + n) % n], true);
  }
  function removeTrack(id) {
    const t = byId(id); if (!t) return;
    tx('tracks', 'readwrite', st => st.delete(t.id));
    URL.revokeObjectURL(t.url); if (t.coverUrl) URL.revokeObjectURL(t.coverUrl);
    const wasCur = S.curId === id, playing = !audio.paused;
    const qi = queue().findIndex(x => x.id === id);
    S.tracks = S.tracks.filter(x => x.id !== id);
    S.lists.forEach(l => { if (l.trackIds.includes(id)) { l.trackIds = l.trackIds.filter(x => x !== id); saveList(l); } });
    if (wasCur) {
      const nq = queue(), nxt = nq[Math.min(qi, nq.length - 1)] || S.tracks[0];
      if (nxt) load(nxt, playing, nq.length ? undefined : 'all');
      else { audio.pause(); audio.removeAttribute('src'); audio.load(); S.curId = null; }
    }
    render();
  }
  function deleteList(l) {
    tx('lists', 'readwrite', st => st.delete(l.id));
    if (l.coverUrl) URL.revokeObjectURL(l.coverUrl);
    S.lists = S.lists.filter(x => x !== l);
    if (S.ctx === l.id) S.ctx = 'all';
    if (S.sheet && S.sheet.listId === l.id) closeSheet();
  }
  async function createList(name, cover, addTrack) {
    const rec = { name, cover: cover || null, trackIds: addTrack != null ? [addTrack] : [] };
    const id = await tx('lists', 'readwrite', st => st.add(rec));
    const l = mkList(rec, id); S.lists.push(l); return l;
  }

  /* ---------- render ---------- */
  function render() {
    const t = cur(), q = queue(), n = S.tracks.length;
    $('#title').textContent = t ? t.title : 'nothing playing';
    $('#artist').textContent = t ? t.artist : 'your songs, softly';
    $('#ctaAdd').hidden = n > 0;
    const cv = $('#cover'), am = $('#ambient');
    if (t && t.coverUrl) { cv.src = t.coverUrl; cv.hidden = false; $('#ph').hidden = true; am.src = t.coverUrl; am.hidden = false; }
    else { cv.hidden = true; cv.removeAttribute('src'); $('#ph').hidden = false; am.hidden = true; am.removeAttribute('src'); }
    const pl = S.ctx !== 'all' ? listById(S.ctx) : null;
    $('#status').textContent = pl ? pl.name + ' · ' + countText(q.length) : countText(n);
    $('#qCount').textContent = countText(n);
    const like = $('#bLike'); like.classList.toggle('on', !!(t && t.liked)); like.setAttribute('aria-pressed', !!(t && t.liked));
    if (q.length < 2) { $('#npLabel').textContent = t ? 'now playing' : 'up next'; $('#npTitle').textContent = t ? t.title : 'nothing yet'; $('#npArtist').textContent = t ? t.artist : 'add songs to start'; }
    else if (S.shuffle) { $('#npLabel').textContent = 'shuffle on'; $('#npTitle').textContent = 'surprise me'; $('#npArtist').textContent = countText(q.length) + ' in the mix'; }
    else { const nx = q[(curIdx() + 1) % q.length]; $('#npLabel').textContent = 'up next'; $('#npTitle').textContent = nx.title; $('#npArtist').textContent = nx.artist; }
    renderSidebar(); renderPage();
    if (S.sheet) renderSheet(false);
  }

  /* ---------- sidebar ---------- */
  function renderSidebar() {
    $('#allCount').textContent = countText(S.tracks.length);
    $('#sideAll').classList.toggle('active', S.ctx === 'all');
    $('#plist').innerHTML = S.lists.length
      ? S.lists.map(l => `<button class="side-row${S.ctx === l.id ? ' active' : ''}" data-open="${esc(l.id)}" type="button"><span class="thumb lg">${coverHTML(listCover(l), '#paw-mini')}</span><span class="tx"><b>${esc(l.name)}</b><span>${countText(l.trackIds.length)}</span></span></button>`).join('')
      : '<p class="side-empty">no playlists yet.<br>make your first one below.</p>';
  }
  const side = $('#side');
  function openSide() { side.classList.add('open'); $('#sideScrim').hidden = false; $('#bMenu').setAttribute('aria-expanded', 'true'); }
  function closeSide() { side.classList.remove('open'); $('#sideScrim').hidden = true; $('#bMenu').setAttribute('aria-expanded', 'false'); }
  $('#bMenu').onclick = () => side.classList.contains('open') ? closeSide() : openSide();
  $('#sideClose').onclick = $('#sideScrim').onclick = closeSide;
  side.addEventListener('click', e => {
    const o = e.target.closest('[data-open]');
    if (o) {
      const v = o.dataset.open;
      if (v === 'all') openSheet('all'); else { const l = listByStr(v); if (l) openSheet('list', l.id); }
    }
  });
  $('#bNewList').onclick = () => { closeSide(); openDlg('new'); };

  /* ---------- playlists page (#playlists) ---------- */
  const pageEl = $('#pageLists'), homeEl = $('#home'), topEl = $('#top');
  function renderPage() {
    if (pageEl.hidden) return;
    const playing = !!cur();
    const card = (id, url, icon, name, sub, cls) => `<button class="pcard${cls}" data-open="${esc(id)}" type="button"><span class="pc-cover"><span class="pc-img">${coverHTML(url, icon)}</span></span><span class="pc-name">${esc(name)}</span><span class="pc-sub">${sub}</span></button>`;
    $('#pgrid').innerHTML =
      card('all', S.tracks.length ? S.tracks[0].coverUrl : '', '#i-note', 'all songs', countText(S.tracks.length), playing && S.ctx === 'all' ? ' active' : '') +
      S.lists.map(l => card(l.id, listCover(l), '#paw-mini', l.name, countText(l.trackIds.length), playing && sameId(S.ctx, l.id) ? ' active' : '')).join('') +
      '<button class="pcard new" data-new type="button"><span class="pc-cover"><span class="pc-img"><svg class="ic"><use href="#i-plus"/></svg></span></span><span class="pc-name">new playlist</span><span class="pc-sub">&nbsp;</span></button>';
    const t = cur(), m = $('#mini');
    m.hidden = !t;
    if (t) { $('#miniThumb').innerHTML = coverHTML(t.coverUrl, '#i-note'); $('#miniTitle').textContent = t.title; $('#miniArtist').textContent = t.artist; }
  }
  function route() {
    const on = location.hash === '#playlists';
    const was = !pageEl.hidden;
    pageEl.hidden = !on; homeEl.hidden = on; topEl.hidden = on;
    if (on) { closeSide(); renderPage(); }
    if (on !== was) window.scrollTo(0, 0);
  }
  $('#pgrid').addEventListener('click', e => {
    if (e.target.closest('[data-new]')) { openDlg('new'); return; }
    const o = e.target.closest('[data-open]'); if (!o) return;
    if (o.dataset.open === 'all') openSheet('all'); else { const l = listByStr(o.dataset.open); if (l) openSheet('list', l.id); }
  });
  $('#pNew').onclick = () => openDlg('new');
  $('#miniPlay').onclick = e => { e.stopPropagation(); togglePlay(); };
  $('#mini').onclick = () => { location.hash = '#home'; };
  window.addEventListener('hashchange', route);

  /* ---------- songs sheet ---------- */
  function openSheet(mode, listId) { S.sheet = { mode, listId }; S.q = ''; closeSide(); $('#scrim').hidden = false; renderSheet(true); }
  function closeSheet() { S.sheet = null; $('#scrim').hidden = true; kbHide(); }
  function rowHTML(t, mode) {
    const id = esc(t.id);
    const btn = (act, icon, label) => `<button class="act" data-act="${act}" data-id="${id}" aria-label="${label}" type="button"><svg class="ic"><use href="#${icon}"/></svg></button>`;
    let acts = '';
    if (mode === 'all') acts = btn('add', 'i-plus', 'Add to playlist') + btn('edit', 'i-edit', 'Edit song') + btn('rm', 'i-x', 'Remove song');
    else if (mode === 'list') acts = btn('edit', 'i-edit', 'Edit song') + btn('unlist', 'i-x', 'Remove from playlist');
    else { const on = S.lists.find(l => sameId(l.id, S.sheet.listId)); const has = on && on.trackIds.includes(t.id); acts = `<button class="act tick${has ? ' on' : ''}" data-act="toggle" data-id="${id}" aria-label="${has ? 'In playlist' : 'Add to playlist'}" type="button"><svg class="ic"><use href="#i-check"/></svg></button>`; }
    const heart = t.liked && mode !== 'pick' ? '<svg class="ic heart"><use href="#i-heart"/></svg>' : '';
    return `<div class="row${t.id === S.curId ? ' cur' : ''}"><button class="go" data-act="${mode === 'pick' ? 'toggle' : 'play'}" data-id="${id}" type="button"><span class="thumb">${coverHTML(t.coverUrl, '#i-note')}</span><span class="tx"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></span></button>${heart}${acts}</div>`;
  }
  function renderSheet(full) {
    const sh = S.sheet; if (!sh) return;
    let l = null;
    if (sh.mode !== 'all') { l = listById(sh.listId); if (!l) { closeSheet(); return; } }
    if (full) {
      const search = `<div class="search"><input class="field" id="q" data-kb inputmode="none" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="40" placeholder="search songs" value="${esc(S.q)}"></div>`;
      let head = '';
      if (sh.mode === 'all') head = `<h2>all songs</h2><p class="sub">${countText(S.tracks.length)}</p>${search}`;
      else if (sh.mode === 'pick') head = `<h2>add songs</h2><p class="sub">to ${esc(l.name)}</p>${search}<div class="lact"><span class="grow"></span><button class="btn primary" data-act="done" type="button">done</button></div>`;
      else head = `<div class="lhead"><button class="cvbtn" data-act="listcover" type="button" aria-label="Change playlist picture"><span class="cv">${coverHTML(listCover(l), '#paw-mini')}</span><span class="cam"><svg class="ic"><use href="#i-camera"/></svg></span></button><div class="lmeta"><h2>${esc(l.name)}</h2><p class="sub">${countText(l.trackIds.length)}</p></div></div><div class="lact"><button class="btn primary" data-act="playall" type="button">play</button><button class="btn" data-act="addsongs" type="button">+ songs</button><button class="btn ghost" data-act="editlist" type="button">edit</button></div>`;
      $('#sheetHead').innerHTML = head;
    }
    let list = sh.mode === 'list' ? l.trackIds.map(byId).filter(Boolean) : S.tracks;
    const q = S.q.trim().toLowerCase();
    if (q && sh.mode !== 'list') list = list.filter(t => (t.title + ' ' + t.artist).toLowerCase().includes(q));
    $('#sheetList').innerHTML = list.length ? list.map(t => rowHTML(t, sh.mode)).join('')
      : `<p class="empty">${q ? 'no matches.' : sh.mode === 'list' ? 'this playlist is empty.<br>tap + songs to fill it.' : 'nothing here yet.<br>tap the tulip to add songs from your phone.'}</p>`;
  }
  $('#sheetHead').addEventListener('input', e => { if (e.target.id === 'q') { S.q = e.target.value; renderSheet(false); } });
  $('#sheet').addEventListener('click', e => {
    const el = e.target.closest('[data-act]'); if (!el || !S.sheet) return;
    const sh = S.sheet, a = el.dataset.act, t = el.dataset.id != null ? trackByStr(el.dataset.id) : null;
    const l = sh.listId != null ? listById(sh.listId) : null;
    if (a === 'play' && t) load(t, true, sh.mode === 'list' ? sh.listId : 'all');
    else if (a === 'add' && t) openChooser(t.id);
    else if (a === 'edit' && t) openDlg('song', t.id);
    else if (a === 'rm' && t) removeTrack(t.id);
    else if (a === 'unlist' && t && l) { l.trackIds = l.trackIds.filter(x => x !== t.id); saveList(l); render(); renderSheet(true); }
    else if (a === 'toggle' && t && l) {
      if (l.trackIds.includes(t.id)) l.trackIds = l.trackIds.filter(x => x !== t.id); else l.trackIds.push(t.id);
      saveList(l); render();
    }
    else if (a === 'listcover' && l) pickImage(b => { setListCover(l, b); saveList(l); render(); renderSheet(true); toast('picture updated'); });
    else if (a === 'playall' && l) { const f = l.trackIds.map(byId).find(Boolean); if (f) { load(f, true, l.id); closeSheet(); toast('playing ' + l.name); } else toast('add some songs first'); }
    else if (a === 'addsongs' && l) { sh.mode = 'pick'; S.q = ''; renderSheet(true); }
    else if (a === 'done') { sh.mode = 'list'; S.q = ''; renderSheet(true); }
    else if (a === 'editlist' && l) openDlg('list', l.id);
  });
  $('#scrim').addEventListener('click', e => { if (e.target === $('#scrim')) closeSheet(); });

  /* ---------- add-to-playlist chooser ---------- */
  function openChooser(trackId) { S.choose = trackId; renderChooser(); $('#chooser').hidden = false; }
  function closeChooser() { $('#chooser').hidden = true; S.choose = null; }
  function renderChooser() {
    const t = byId(S.choose); if (!t) return;
    $('#chSong').textContent = t.title;
    $('#chList').innerHTML = S.lists.map(l => {
      const has = l.trackIds.includes(t.id);
      return `<button class="ch-row${has ? ' in' : ''}" data-ch="${esc(l.id)}" type="button"><span class="thumb">${coverHTML(listCover(l), '#paw-mini')}</span><span class="tx"><b>${esc(l.name)}</b><span>${countText(l.trackIds.length)}</span></span><span class="act tick${has ? ' on' : ''}"><svg class="ic"><use href="#i-check"/></svg></span></button>`;
    }).join('') + `<button class="ch-row" data-ch="__new" type="button"><span class="thumb"><svg class="ic"><use href="#i-plus"/></svg></span><span class="tx"><b>new playlist</b></span></button>`;
  }
  $('#chList').addEventListener('click', e => {
    const r = e.target.closest('[data-ch]'); if (!r) return;
    const t = byId(S.choose); if (!t) return;
    if (r.dataset.ch === '__new') { const id = t.id; closeChooser(); openDlg('new', null, id); return; }
    const l = listByStr(r.dataset.ch); if (!l) return;
    if (l.trackIds.includes(t.id)) l.trackIds = l.trackIds.filter(x => x !== t.id); else { l.trackIds.push(t.id); toast('added to ' + l.name); }
    saveList(l); renderChooser(); render();
  });
  $('#chDone').onclick = closeChooser;
  $('#chooser').addEventListener('click', e => { if (e.target === $('#chooser')) closeChooser(); });

  /* ---------- edit dialog (song, playlist, new playlist) ---------- */
  const D = { kind: null, id: null, cover: undefined, url: '', addTrack: null, armT: null };
  function dlgCoverUrl() {
    if (D.cover === undefined) {
      if (D.kind === 'song') return (byId(D.id) || {}).coverUrl || '';
      if (D.kind === 'list') return (listById(D.id) || {}).coverUrl || '';
      return '';
    }
    return D.cover ? D.url : '';
  }
  function paintDlg() {
    $('#dlgCv').innerHTML = coverHTML(dlgCoverUrl(), D.kind === 'song' ? '#i-note' : '#paw-mini');
    $('#dlgReset').textContent = D.kind === 'song' ? 'reset picture' : 'remove picture';
    $('#dlgReset').hidden = !dlgCoverUrl();
  }
  function setDlgCover(blob) {
    if (D.url) URL.revokeObjectURL(D.url);
    D.cover = blob; D.url = blob ? URL.createObjectURL(blob) : ''; paintDlg();
  }
  function openDlg(kind, id, addTrack) {
    D.kind = kind; D.id = id ?? null; D.cover = undefined; D.url = ''; D.addTrack = addTrack ?? null;
    const t = kind === 'song' ? byId(id) : kind === 'list' ? listById(id) : null;
    $('#dlgTitle').textContent = kind === 'song' ? 'edit song' : kind === 'list' ? 'edit playlist' : 'new playlist';
    $('#dlgALabel').textContent = kind === 'song' ? 'title' : 'name';
    $('#dlgA').value = kind === 'song' ? t.title : kind === 'list' ? t.name : '';
    $('#dlgA').placeholder = kind === 'song' ? '' : 'my playlist';
    $('#dlgBWrap').hidden = kind !== 'song';
    $('#dlgB').value = kind === 'song' ? t.artist : '';
    $('#dlgDel').hidden = kind === 'new';
    $('#dlgDel').textContent = kind === 'song' ? 'remove song' : 'delete playlist';
    $('#dlgDel').classList.remove('armed');
    $('#dlgSave').textContent = kind === 'new' ? 'create' : 'save';
    paintDlg();
    $('#dlg').hidden = false;
    if (kind === 'new') setTimeout(() => $('#dlgA').focus(), 80);
  }
  function closeDlg() { $('#dlg').hidden = true; if (D.url) URL.revokeObjectURL(D.url); D.url = ''; D.cover = undefined; clearTimeout(D.armT); kbHide(); }
  $('#dlgCover').onclick = () => pickImage(b => setDlgCover(b));
  $('#dlgReset').onclick = () => {
    if (D.kind === 'song') { const t = byId(D.id); setDlgCover(t ? t.cover0 : null); } else setDlgCover(null);
  };
  $('#dlgCancel').onclick = closeDlg;
  $('#dlg').addEventListener('click', e => { if (e.target === $('#dlg')) closeDlg(); });
  $('#dlgDel').onclick = () => {
    const b = $('#dlgDel');
    if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'tap again to confirm'; D.armT = setTimeout(() => { b.classList.remove('armed'); b.textContent = D.kind === 'song' ? 'remove song' : 'delete playlist'; }, 3000); return; }
    if (D.kind === 'song') removeTrack(D.id);
    else if (D.kind === 'list') { const l = listById(D.id); if (l) deleteList(l); }
    closeDlg(); render(); toast('removed');
  };
  $('#dlgSave').onclick = async () => {
    const a = $('#dlgA').value.trim(), b = $('#dlgB').value.trim();
    if (D.kind === 'song') {
      const t = byId(D.id); if (t) { if (a) t.title = a; t.artist = b || 'unknown artist'; if (D.cover !== undefined) setTrackCover(t, D.cover); saveTrack(t); }
      toast('saved');
    } else if (D.kind === 'list') {
      const l = listById(D.id); if (l) { if (a) l.name = a; if (D.cover !== undefined) setListCover(l, D.cover); saveList(l); }
      toast('saved');
    } else {
      if (!a) { toast('give it a name first'); $('#dlgA').focus(); return; }
      const l = await createList(a, D.cover || null, D.addTrack);
      closeDlg(); render();
      if (D.addTrack == null) { openSheet('list', l.id); toast('playlist created'); } else toast('added to ' + a);
      return;
    }
    closeDlg(); render();
    if (S.sheet) renderSheet(true);
  };
  $('#dlgA').addEventListener('kbenter', () => { if (D.kind === 'song') $('#dlgB').focus(); else $('#dlgSave').click(); });
  $('#dlgB').addEventListener('kbenter', () => $('#dlgSave').click());

  /* ---------- audio events ---------- */
  const setPlayIcon = () => {
    const p = !audio.paused;
    $('#playUse').setAttribute('href', p ? '#i-pause' : '#i-play');
    $('#miniUse').setAttribute('href', p ? '#i-pause' : '#i-play');
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
  document.addEventListener('click', e => { const b = e.target.closest('.paw'); if (!b) return; b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 700); });
  $('#bPlay').onclick = togglePlay;
  $('#bNext').onclick = () => advance(false);
  $('#bPrev').onclick = back;
  $('#bAdd').onclick = $('#ctaAdd').onclick = () => $('#file').click();
  $('#art').onclick = () => { if (!S.tracks.length) $('#file').click(); else if (cur()) openDlg('song', cur().id); };
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
    const t = cur(); if (!t) { toast('play a song first'); return; }
    t.liked = !t.liked; saveTrack(t); toast(t.liked ? 'liked ♡' : 'unliked'); render();
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
    S.tracks = []; S.curId = null; S.ctx = 'all';
    S.lists.forEach(l => { l.trackIds = []; saveList(l); });
    await tx('tracks', 'readwrite', st => st.clear()); render(); toast('library cleared');
  };
  $('#bQueue').onclick = () => openSheet('all');

  /* ---------- keyboard: the Pixel Kitten skin's own art, placed on the skin's 1080-unit grid ---------- */
  // each key: [x, y, w, h, tileX, tileY, tileW, tileH, action, char, longPressChar]
  const SKIN = {"abc":[[0,0,109,149,0,0,108,160,"k","q","1"],[108,0,108,149,108,0,107,160,"k","w","2"],[215,0,109,149,215,0,108,160,"k","e","3"],[323,0,109,149,323,0,108,160,"k","r","4"],[431,0,109,149,431,0,108,160,"k","t","5"],[539,0,109,149,539,0,108,160,"k","y","6"],[647,0,109,149,647,0,108,160,"k","u","7"],[755,0,109,149,755,0,108,160,"k","i","8"],[863,0,109,149,863,0,108,160,"k","o","9"],[971,0,108,149,971,0,108,160,"k","p","0"],[55,148,109,149,55,160,108,160,"k","a","~"],[163,148,109,149,163,160,108,160,"k","s","@"],[271,148,109,149,271,160,108,160,"k","d","#"],[379,148,109,149,379,160,108,160,"k","f","$"],[487,148,109,149,487,160,108,160,"k","g","%"],[595,148,109,149,595,160,108,160,"k","h","&"],[703,148,109,149,703,160,108,160,"k","j","*"],[811,148,109,149,811,160,108,160,"k","k","("],[919,148,104,149,919,160,103,160,"k","l",")"],[163,296,109,149,163,320,108,160,"k","z","'"],[271,296,109,149,271,320,108,160,"k","x","/"],[379,296,109,149,379,320,108,160,"k","c","-"],[487,296,109,149,487,320,108,160,"k","v","_"],[595,296,109,149,595,320,108,160,"k","b",":"],[703,296,109,149,703,320,108,160,"k","n",";"],[811,296,109,149,811,320,108,160,"k","m","\\"],[271,444,109,148,271,480,108,160,"k",",","!"],[379,444,325,148,379,480,324,160,"space","",""],[703,444,109,148,703,480,108,160,"k",".","?"],[1,444,163,148,1,480,162,160,"sym","",""],[919,296,160,149,919,320,160,160,"bs","",""],[163,444,109,148,163,480,108,160,"num","",""],[811,444,109,148,811,480,108,160,"hide","",""],[0,296,164,149,0,320,163,160,"shift","",""],[919,444,160,148,919,480,160,160,"enter","",""]],"num":[[0,0,171,444,0,0,171,480,"none","",""],[170,0,248,149,170,0,247,160,"k","1",""],[416,0,248,149,416,0,247,160,"k","2",""],[662,0,248,149,662,0,247,160,"k","3",""],[170,148,248,149,170,160,247,160,"k","4",""],[416,148,248,149,416,160,247,160,"k","5",""],[662,148,248,149,662,160,247,160,"k","6",""],[170,296,248,149,170,320,247,160,"k","7",""],[416,296,248,149,416,320,247,160,"k","8",""],[662,296,248,149,662,320,247,160,"k","9",""],[416,444,248,148,416,480,247,160,"k","0",""],[908,148,171,149,908,160,171,160,"k","@",""],[0,444,172,148,0,480,171,160,"sym","",""],[170,444,248,148,170,480,247,160,"abc","",""],[662,444,248,148,662,480,247,160,"space","",""],[908,444,171,148,908,480,171,160,"enter","",""],[908,0,171,149,908,0,171,160,"bs","",""],[908,296,171,149,908,320,171,160,"k",".",""]],"sym":[[170,0,908,555,170,0,908,555,"none","",""],[0,0,171,555,0,0,171,555,"none","",""],[0,554,170,148,0,554,170,148,"abc","",""],[170,554,170,148,170,554,170,148,"pgdn","",""],[340,554,398,148,340,554,398,148,"pgup","",""],[738,554,340,148,738,554,340,148,"bs","",""]]};
  const KW = 1080, KH = 820, KTOP = 179;
  const KB = { el: null, open: false, target: null, page: 'abc', shift: 0, lastShift: 0, press: null, cat: 0, pg: 0 };
  // symbol panel (symbol.ini): three categories on the left, 4 x 4 symbols per page
  const SYMS = [
    ['basic', ', . ! ? \' " : ; ( ) - _ / @ # & ~ * + = % $ ^ < > [ ] { } | \\ …'.split(' ')],
    ['cute', ['ʚᵗ᷒ᰰɞ', '♡', '♥', '☆', '★', '✿', '❀', '♪', '♫', '✧', 'ෆ', '˚₊', '꒰', '꒱', '⸜', '⸝', 'ᵔᴗᵔ', 'ʕ•ᴥ•ʔ', '☺', '☁', '☾', '✦', '❤', '✨']],
    ['math', '+ − × ÷ = ≠ ≈ ≤ ≥ ± ∞ √ π ° % ‰ ² ³ ½ ¼ ¾ € £ ¥ ¢ © ® ™ § ¶ • ·'.split(' ')]
  ];
  const LABELS = { shift: 'Shift', bs: 'Backspace', space: 'Space', enter: 'Done', num: 'Numbers', abc: 'Letters', sym: 'Symbols', hide: 'Hide keyboard', pgup: 'Previous symbols', pgdn: 'More symbols' };
  const kbScale = () => Math.min(window.innerWidth, 440) / KW;
  const SHEET = { abc: 's26', num: 's123', sym: 'sax' };

  function kbRender() {
    const p = KB.page, k = kbScale();
    const root = document.documentElement.style;
    root.setProperty('--k', k);
    root.setProperty('--kh', p === 'sym' ? 703 : KH);
    const top = p === 'sym' ? 0 : KTOP, sheet = SHEET[p];
    let keys = '';
    for (const [x, y, w, h, sx, sy, sw, sh, act, ch, up] of SKIN[p]) {
      const pos = `left:${x}px;top:${top + y}px;width:${w}px;height:${h}px`;
      const img = `<i style="width:${sw}px;height:${sh}px;background-position:-${sx}px -${sy}px"></i>`;
      if (act === 'none') { keys += `<span class="sk deco ${sheet}" style="${pos}">${img}</span>`; continue; }
      const cls = 'sk ' + sheet + (act === 'shift' && KB.shift ? ' on' : '') + (act === 'shift' && KB.shift === 2 ? ' caps' : '');
      keys += `<button class="${cls}" type="button" tabindex="-1" style="${pos}" data-act="${act}"${ch ? ` data-ch="${esc(ch)}"` : ''}${up ? ` data-up="${esc(up)}"` : ''} aria-label="${esc(LABELS[act] || ch)}">${img}</button>`;
    }
    if (p === 'abc') keys += '<div class="kb-word" id="kbWord"></div>';
    if (p === 'sym') {
      const list = SYMS[KB.cat][1], pages = Math.ceil(list.length / 16);
      KB.pg = Math.min(KB.pg, pages - 1);
      SYMS.forEach(([name], i) => { keys += `<button class="sy sc${i === KB.cat ? ' sel' : ''}" type="button" tabindex="-1" style="left:0;top:${i * 185}px;width:171px;height:185px" data-act="cat" data-i="${i}">${name}</button>`; });
      for (let i = 0; i < 16; i++) {
        const c = list[KB.pg * 16 + i]; if (c == null) continue;
        keys += `<button class="sy" type="button" tabindex="-1" style="left:${170 + (i % 4) * 227}px;top:${Math.floor(i / 4) * 139}px;width:227px;height:139px" data-act="k" data-ch="${esc(c)}" aria-label="${esc(c)}">${esc(c)}</button>`;
      }
    }
    KB.el.innerHTML = `<div class="kbs"><div class="kbs-in${p === 'sym' ? ' sym' : ''}">${keys}</div></div>`;
    kbWord();
    if (KB.open) kbMeasure();
  }
  function kbWord() {
    const w = document.getElementById('kbWord'), el = KB.target; if (!w || !el) return;
    const s = el.selectionStart ?? el.value.length;
    w.textContent = (el.value.slice(0, s).match(/\S*$/) || [''])[0];
  }
  function kbMeasure() { document.documentElement.style.setProperty('--kb-h', KB.el.offsetHeight + 'px'); }
  function kbInsert(t) {
    const el = KB.target; if (!el) return;
    const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
    if (el.maxLength > 0 && el.value.length - (e - s) + t.length > el.maxLength) return;
    el.setRangeText(t, s, e, 'end'); el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function kbBackspace() {
    const el = KB.target; if (!el) return;
    let s = el.selectionStart ?? 0; const e = el.selectionEnd ?? s;
    if (s === e) { if (s === 0) return; s -= 1; }
    el.setRangeText('', s, e, 'end'); el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function kbRun(t) {
    const a = t.dataset.act;
    if (a === 'k') {
      let c = t.dataset.ch;
      if (KB.page === 'abc' && KB.shift && /^[a-z]$/.test(c)) c = c.toUpperCase();
      kbInsert(c);
      if (KB.shift === 1 && /^[a-z]$/i.test(c)) { KB.shift = 0; kbRender(); }
    }
    else if (a === 'shift') { const now = Date.now(); if (KB.shift === 2) KB.shift = 0; else if (KB.shift === 1 && now - KB.lastShift < 400) KB.shift = 2; else KB.shift = KB.shift ? 0 : 1; KB.lastShift = now; kbRender(); }
    else if (a === 'space') kbInsert(' ');
    else if (a === 'num' || a === 'abc' || a === 'sym') { KB.page = a; if (a === 'sym') { KB.pg = 0; } kbRender(); }
    else if (a === 'cat') { KB.cat = +t.dataset.i; KB.pg = 0; kbRender(); }
    else if (a === 'pgup' || a === 'pgdn') { const n = Math.ceil(SYMS[KB.cat][1].length / 16); KB.pg = (KB.pg + (a === 'pgdn' ? 1 : n - 1)) % n; kbRender(); }
    else if (a === 'hide') { const x = KB.target; kbHide(); if (x) x.blur(); }
    else if (a === 'enter') { const x = KB.target; kbHide(); if (x) { x.blur(); x.dispatchEvent(new CustomEvent('kbenter', { bubbles: true })); } }
  }
  function kbEnsure() {
    if (KB.el) return;
    const kb = document.createElement('div');
    kb.className = 'kb'; kb.id = 'kb'; kb.setAttribute('aria-hidden', 'true'); kb.setAttribute('role', 'group'); kb.setAttribute('aria-label', 'Keyboard');
    document.body.appendChild(kb); KB.el = kb;
    let r1, r2;
    const stopRep = () => { clearTimeout(r1); clearInterval(r2); };
    const keyAt = e => { const n = document.elementFromPoint(e.clientX, e.clientY); return n && n.closest('.sk,.sy'); };
    kb.addEventListener('mousedown', e => e.preventDefault());
    kb.addEventListener('focusin', () => { if (KB.target) KB.target.focus(); });
    kb.addEventListener('pointerdown', e => {
      const t = e.target.closest('.sk,.sy'); if (!t || t.classList.contains('deco')) return;
      e.preventDefault(); t.classList.add('down');
      const a = t.dataset.act;
      if (a === 'bs') { kbBackspace(); stopRep(); r1 = setTimeout(() => { r2 = setInterval(kbBackspace, 55); }, 380); KB.press = { el: t, fired: true }; return; }
      const pr = { el: t, fired: false, timer: null };
      if (t.dataset.up) pr.timer = setTimeout(() => { pr.fired = true; kbInsert(t.dataset.up); }, 450);
      else if (a === 'shift') pr.timer = setTimeout(() => { pr.fired = true; KB.shift = 2; kbRender(); }, 450);
      KB.press = pr;
    });
    const release = (e, cancel) => {
      stopRep();
      kb.querySelectorAll('.down').forEach(n => n.classList.remove('down'));
      const pr = KB.press; KB.press = null; if (!pr) return;
      clearTimeout(pr.timer);
      if (cancel || pr.fired) return;
      if (e.pointerType === 'touch' && keyAt(e) !== pr.el) return;
      kbRun(pr.el);
    };
    window.addEventListener('pointerup', e => release(e, false));
    window.addEventListener('pointercancel', e => release(e, true));
    window.addEventListener('resize', () => { if (KB.open) kbRender(); });
  }
  function kbShow(el) {
    kbEnsure();
    const changed = KB.target !== el || !KB.open;
    KB.target = el;
    if (changed) { KB.page = 'abc'; KB.cat = 0; KB.pg = 0; KB.shift = el.value.trim() ? 0 : 1; kbRender(); }
    KB.open = true; KB.el.classList.add('open'); KB.el.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => { kbMeasure(); setTimeout(() => { try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {} }, 60); });
  }
  function kbHide() {
    if (!KB.el || !KB.open) return;
    KB.open = false; KB.el.classList.remove('open'); KB.el.setAttribute('aria-hidden', 'true');
    document.documentElement.style.setProperty('--kb-h', '0px');
  }
  document.addEventListener('focusin', e => { if (e.target.matches && e.target.matches('input[data-kb]')) kbShow(e.target); });
  document.addEventListener('input', e => { if (KB.open && e.target === KB.target) kbWord(); });
  document.addEventListener('keyup', e => { if (KB.open && e.target === KB.target) kbWord(); });
  document.addEventListener('focusout', () => setTimeout(() => {
    const a = document.activeElement;
    if (!(a && ((a.matches && a.matches('input[data-kb]')) || (KB.el && KB.el.contains(a))))) kbHide();
  }, 150));

  /* ---------- keys, drag and drop ---------- */
  document.addEventListener('keydown', e => {
    const t = e.target, tag = (t.tagName || '').toLowerCase();
    if (e.key === 'Enter' && t.matches && t.matches('input[data-kb]')) { e.preventDefault(); t.dispatchEvent(new CustomEvent('kbenter', { bubbles: true })); return; }
    if (e.key === 'Escape') {
      if (KB.open) { const x = KB.target; kbHide(); if (x) x.blur(); }
      else if (!$('#dlg').hidden) closeDlg();
      else if (!$('#chooser').hidden) closeChooser();
      else if (S.sheet) closeSheet();
      else closeSide();
      return;
    }
    if (tag === 'input' || tag === 'button' || t.getAttribute('role') === 'slider') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight') audio.currentTime += 5;
    else if (e.key === 'ArrowLeft') audio.currentTime -= 5;
  });
  let dragN = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); dragN++; document.body.classList.add('drop'); });
  window.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; document.body.classList.remove('drop'); } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => { e.preventDefault(); dragN = 0; document.body.classList.remove('drop'); if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });

  /* ---------- boot ---------- */
  (async () => {
    setPal(0);
    db = await openDB();
    const savedT = await tx('tracks', 'readonly', st => st.getAll());
    const savedL = await tx('lists', 'readonly', st => st.getAll());
    if (savedT && savedT.length) savedT.forEach(r => S.tracks.push(mk(r, r.id)));
    if (savedL && savedL.length) savedL.forEach(r => S.lists.push(mkList(r, r.id)));
    if (S.tracks.length) load(S.tracks[0], false, 'all'); else render();
    setPlayIcon(); tick(); route();
  })();
})();
