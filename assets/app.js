/* =========================================================
   光辉时代 · 普拉多博物馆西班牙往事虚拟展厅
   ========================================================= */
(() => {
  'use strict';

  const DATA = window.MUSEUM_DATA;
  if (!DATA || !Array.isArray(DATA.rooms)) {
    document.body.innerHTML = '<p style="color:#e8dcc4;font-family:serif;padding:40px">展品数据加载失败。</p>';
    return;
  }

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const pad2 = n => String(n).padStart(2, '0');
  const isMobileLayout = () => window.innerWidth <= 720;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  const FLAT = [];
  DATA.rooms.forEach((room, ri) => {
    room.exhibits.forEach((ex, ei) => {
      FLAT.push({ room, ri, ex, ei, global: FLAT.length + 1 });
    });
  });

  const TAG_KIND_LABEL = DATA.tagKindLabel || { style: '流派', subject: '题材', technique: '技法', medium: '门类' };
  const TAG_WIKI_FROM_DATA = DATA.tagWiki || {};
  DATA.rooms.forEach(room => (room.knowledge || []).forEach(k => {
    if (!TAG_WIKI_FROM_DATA[k.term]) TAG_WIKI_FROM_DATA[k.term] = k.text;
  }));
  function tagWikiText(name) {
    return TAG_WIKI_FROM_DATA[name] || `“${name}”是本展用于概括该作品特征的标签。`;
  }

  const STORAGE_KEY = 'prado-museum-visited-v1';
  const state = {
    started: false,
    roomIndex: 0,
    panX: 0,
    targetPan: 0,
    panRaf: 0,
    dragging: false,
    dragMoved: false,
    dragStartX: 0,
    dragStartPan: 0,
    dragLastX: 0,
    dragLastT: 0,
    dragVelocity: 0,
    visited: new Set(),
    detail: null,
    detailFrom: null,
    overlay: null,
    catalogFilter: 'all',
    catalogSchool: 'all',
    catalogArtist: 'all',
    catalogQuery: '',
    catalogScroll: 0,
    timelineSchool: 'all',
    networkSchool: 'all',
    networkSelected: null,
    networkView: { x: 0, y: 0, k: 1, dragging: false, startX: 0, startY: 0, origX: 0, origY: 0 },
    artworks: [],
    wallMax: 0,
    pointerX: null,
    depthRaf: 0,
    viewer: {
      natW: 1, natH: 1, fit: 1, scale: 1, x: 0, y: 0,
      mode: 'all', dragging: false, startX: 0, startY: 0, origX: 0, origY: 0,
      fullscreen: false, pointers: new Map(), pinch: null
    }
  };

  const preloaded = new Set();
  let toastTimer = 0;
  let loadingDone = false;
  let mobileHintShown = false;

  /* ---------- 背景音乐《阿尔罕布拉宫的回忆》（本地音频） ---------- */
  const MUSIC_KEY = 'prado-music-on';
  const MUSIC_SRC = (DATA.music && DATA.music.src) || 'assets/alhambra.m4a';
  const MUSIC_TITLE = (DATA.music && DATA.music.title) || '《阿尔罕布拉宫的回忆》';
  const music = {
    on: false,
    el: null,
    started: false,
    fadeRaf: 0
  };

  function loadMusicPref() {
    try {
      const stored = localStorage.getItem(MUSIC_KEY);
      music.on = stored === null ? true : stored === '1';
    } catch (e) {
      music.on = true;
    }
    updateMusicButtons();
  }
  function saveMusicPref() {
    try { localStorage.setItem(MUSIC_KEY, music.on ? '1' : '0'); } catch (e) { /* ignore */ }
  }
  function updateMusicButtons() {
    $$('.music-btn').forEach(btn => {
      btn.classList.toggle('playing', music.on);
      btn.setAttribute('aria-pressed', music.on ? 'true' : 'false');
      btn.title = music.on ? `关闭背景音乐 · ${MUSIC_TITLE}` : `开启背景音乐 · ${MUSIC_TITLE}`;
    });
  }
  function ensureMusic() {
    if (music.el) return true;
    try {
      const el = new Audio(MUSIC_SRC);
      el.loop = true;
      el.preload = 'auto';
      el.volume = 0;
      music.el = el;
      return true;
    } catch (e) {
      return false;
    }
  }
  function fadeMusic(target, duration) {
    if (!music.el) return;
    cancelAnimationFrame(music.fadeRaf);
    const el = music.el;
    const from = el.volume;
    const t0 = performance.now();
    const step = now => {
      const k = Math.min(1, (now - t0) / duration);
      el.volume = clamp(from + (target - from) * k, 0, 1);
      if (k < 1) music.fadeRaf = requestAnimationFrame(step);
    };
    music.fadeRaf = requestAnimationFrame(step);
  }
  function startMusic() {
    if (!music.on) return;
    if (!ensureMusic()) {
      music.on = false;
      saveMusicPref();
      updateMusicButtons();
      toast('当前浏览器不支持背景音乐');
      return;
    }
    music.el.play().then(() => {
      music.started = true;
      fadeMusic(0.55, 1800);
    }).catch(() => {
      music.on = false;
      saveMusicPref();
      updateMusicButtons();
      toast('浏览器拦截了自动播放，请再点一次音乐按钮');
    });
  }
  function stopMusic() {
    music.started = false;
    fadeMusic(0, 700);
    setTimeout(() => { if (!music.on && music.el) music.el.pause(); }, 800);
  }
  function toggleMusic() {
    music.on = !music.on;
    saveMusicPref();
    updateMusicButtons();
    if (music.on) startMusic(); else stopMusic();
    toast(music.on ? `${MUSIC_TITLE}已开启` : '背景音乐已关闭');
  }

  /* ---------- 本地进度 ---------- */
  function loadVisited() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      const valid = new Set(FLAT.map(f => f.ex.id));
      if (Array.isArray(arr)) arr.forEach(id => { if (valid.has(id)) state.visited.add(id); });
    } catch (e) { /* ignore */ }
  }
  function saveVisited() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(state.visited))); } catch (e) { /* ignore */ }
  }
  function markVisited(id) {
    if (!id || state.visited.has(id)) return;
    state.visited.add(id);
    saveVisited();
    updateProgress();
    updateRoute();
    $$('.artwork').forEach(el => { if (el.dataset.id === id) el.classList.add('visited'); });
    $$('.cat-card').forEach(el => { if (el.dataset.id === id) el.classList.add('visited'); });
  }

  /* ---------- 尺寸 ---------- */
  // 本展均为平面绘画或立体雕塑
  const isHorizontalWork = () => false;
  function frameSize(ex) {
    const img = ex.hero || { w: 1000, h: 1000 };
    const w = img.w || 1000;
    const h = img.h || 1000;
    const r = w / h;
    let maxW, maxH;
    if (r >= 2.4) { maxW = 470; maxH = 205; }
    else if (r >= 1.7) { maxW = 450; maxH = 275; }
    else if (r >= 1.3) { maxW = 410; maxH = 310; }
    else if (r >= 1.05) { maxW = 370; maxH = 345; }
    else if (r >= 0.85) { maxW = 330; maxH = 380; }
    else if (r >= 0.65) { maxW = 300; maxH = 430; }
    else { maxW = 250; maxH = 480; }
    // 无框展示：画框盒直接贴合原图比例，避免透明留边
    let fw = maxW;
    let fh = Math.round(maxW / r);
    if (fh > maxH) { fh = maxH; fw = Math.round(maxH * r); }
    const vhScale = clamp((window.innerHeight - 150) / 660, 0.62, 1);
    fw = Math.round(fw * vhScale);
    fh = Math.round(fh * vhScale);
    if (isMobileLayout()) { fw = Math.round(fw * 0.64); fh = Math.round(fh * 0.64); }
    return { w: fw, h: fh, r, scrollH: false };
  }
  function objectPosition() {
    return 'center center';
  }

  /* ---------- 入口 ---------- */
  function initIntro() {
    $$('#introCollage .im').forEach(fig => {
      const item = FLAT.find(f => f.ex.id === fig.dataset.ex);
      const img = fig.querySelector('img');
      if (item && img) {
        img.referrerPolicy = 'no-referrer';
        img.src = item.ex.hero.src;
        img.alt = item.ex.name;
        const media = fig.querySelector('.im-media');
        if (media) media.style.aspectRatio = `${item.ex.hero.w} / ${item.ex.hero.h}`;
      }
    });
    const bg = FLAT.find(f => f.ex.id === 'e038') || FLAT[0];
    if (bg) {
      const introImg = $('#introBgImg');
      const wallImg = $('#wallBgImg');
      if (introImg) {
        introImg.referrerPolicy = 'no-referrer';
        introImg.src = `${bg.ex.hero.src}&bg=intro`;
      }
      if (wallImg) {
        wallImg.referrerPolicy = 'no-referrer';
        wallImg.src = `${bg.ex.hero.src}&bg=wall`;
      }
    }
    const stats = $('#introStats');
    if (stats) {
      stats.innerHTML = `
        <div><b>${DATA.meta.total}</b><span>组展项</span></div>
        <div><b>${DATA.meta.workCount || DATA.meta.total}</b><span>件作品</span></div>
        <div><b>${DATA.meta.roomCount}</b><span>个单元</span></div>
        <div><b>${DATA.meta.artistCount}</b><span>位艺术家</span></div>`;
    }
    const secWrap = $('#introSections');
    if (secWrap) {
      const seen = new Map();
      DATA.rooms.forEach(r => {
        if (!seen.has(r.section)) seen.set(r.section, r);
      });
      secWrap.innerHTML = [...seen.values()].map(r => {
        const name = r.chapter.split('·').pop().trim();
        return `<span><i style="background:${r.sectionColor}"></i>${esc(name)}</span>`;
      }).join('');
    }
    const lede = $('#introLede');
    if (lede && DATA.meta.lede) lede.textContent = DATA.meta.lede;
    const src = $('#introSource');
    if (src) {
      const links = (DATA.meta.sourceLinks || []).map(([t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`).join(' · ');
      src.innerHTML = `图文资料整理自微信公众号「獭的游乐场」的“浦东美术馆普拉多展非官方图录”系列：${links}。展品照片为作者实拍，介绍来自展签与作者撰文。本页为非官方虚拟展厅，仅供学习交流。`;
    }
  }

  function renderRoutes() {
    const route = $('#roomRoute');
    DATA.rooms.forEach((room, i) => {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'route-node';
      node.dataset.index = String(i);
      node.title = room.title;
      node.style.borderTopColor = room.sectionColor;
      node.innerHTML = `<div class="rn-top"><span>${pad2(i + 1)}</span><i style="background:${room.sectionColor}"></i></div><span class="rn-title">${esc(room.title)}</span>`;
      node.addEventListener('click', () => enterRoom(i, true, 'start'));
      route.appendChild(node);
    });
  }

  function updateProgress() {
    const total = DATA.meta.total || 1;
    const n = state.visited.size;
    $('#progressText').textContent = `${n} / ${total} 组`;
    $('#progressBar').style.width = `${(n / total) * 100}%`;
  }

  function updateRoute() {
    $$('.route-node').forEach((node, i) => {
      const room = DATA.rooms[i];
      node.classList.toggle('active', i === state.roomIndex);
      node.classList.toggle('visited', room.exhibits.some(ex => state.visited.has(ex.id)));
    });
    if (isMobileLayout()) {
      const active = $('.route-node.active', $('#roomRoute'));
      if (active) {
        requestAnimationFrame(() => active.scrollIntoView({ block: 'nearest', inline: 'center' }));
      }
    }
  }

  function updateTop() {
    const room = DATA.rooms[state.roomIndex];
    $('#roomChapter').textContent = `${room.chapter} · ${pad2(state.roomIndex + 1)} / ${DATA.meta.roomCount}`;
    $('#roomChapter').style.color = room.sectionColor;
    $('#roomTitle').innerHTML = `<span>${esc(room.title)}</span><span class="room-sub-label"> · ${esc(room.subtitle)}</span>`;
    updateProgress();
    updateRoute();
  }
  /* ---------- 展厅 ---------- */
  function buildRoomTitlePanel(room, index) {
    const el = document.createElement('div');
    el.className = 'room-title-panel';
    const works = room.exhibits.reduce((n, e) => n + (e.workCount || 1), 0);
    const terms = room.knowledge.length
      ? `<div class="rt-terms">${room.knowledge.map(k => `<span>${esc(k.term)}</span>`).join('')}</div>`
      : '';
    el.style.borderRightColor = room.sectionColor;
    el.innerHTML = `
      <p class="rt-chapter" style="color:${room.sectionColor}">${esc(room.chapter)}</p>
      <h2 class="rt-title">${esc(room.title)}</h2>
      <p class="rt-sub">${esc(room.subtitle)}</p>
      <p class="rt-intro">${esc(room.intro[0] || '')}</p>
      ${terms}
      <p class="rt-count">${room.exhibits.length} 组展项 · ${works} 件作品 · 按展览顺序陈列</p>`;
    return el;
  }

  function badgeFor(ex) {
    if (/雕塑|木雕|青铜|大理石/.test(ex.medium)) return '雕塑';
    return '';
  }

  function buildArtwork(ex, index, roomIndex) {
    const size = frameSize(ex);
    const badge = badgeFor(ex);
    const el = document.createElement('article');
    el.className = 'artwork' + (state.visited.has(ex.id) ? ' visited' : '');
    el.dataset.id = ex.id;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `${ex.name}，${ex.artist}`);
    el.style.setProperty('--fw', `${size.w}px`);
    el.style.setProperty('--fh', `${size.h}px`);
    el.style.setProperty('--mw', `${size.w - 44}px`);
    el.style.setProperty('--mh', `${size.h - 44}px`);
    const imgStyle = `object-position:${objectPosition(ex.hero)}`;

    el.innerHTML = `
      <div class="artwork-inner">
        <div class="spot"></div>
        <div class="frame${size.scrollH ? ' scroll-h' : ''}">
          ${badge ? `<span class="badge">${esc(badge)}</span>` : ''}
          <div class="mat">
            <img loading="eager" referrerpolicy="no-referrer" src="${esc(ex.hero.src)}" alt="${esc(ex.name)}" style="${imgStyle}">
          </div>
        </div>
        <div class="label">
          <span class="no">${pad2(index + 1)}</span>
          <span class="txt">
            <span class="name">${esc(ex.name)}<i class="visit-dot"></i></span>
            <span class="meta">${esc(ex.artist)} · ${esc(ex.yearLabel)} · ${esc(ex.school)}</span>
          </span>
        </div>
      </div>`;

    let opening = false;
    const open = () => {
      if (state.dragMoved || opening) return;
      opening = true;
      el.classList.add('tap-pop');
      setTimeout(() => {
        opening = false;
        if (!state.dragMoved) openDetail(roomIndex, index);
      }, 260);
      setTimeout(() => el.classList.remove('tap-pop'), 540);
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    return el;
  }

  function buildDoor(roomIndex) {
    const isLast = roomIndex >= DATA.rooms.length - 1;
    const el = document.createElement('div');
    if (!isLast) {
      const next = DATA.rooms[roomIndex + 1];
      el.className = 'door-panel';
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.innerHTML = `
        <span class="door-kicker">NEXT GALLERY</span>
        <span class="door-title">${esc(next.title)}</span>
        <span class="door-sub">${esc(next.subtitle)}</span>
        <span class="door-arrow">→</span>
        <span class="door-sub">点击进入下一展厅</span>`;
      const go = () => enterRoom(roomIndex + 1, true, 'start');
      el.addEventListener('click', go);
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    } else {
      el.className = 'end-panel';
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.innerHTML = `
        <span class="door-kicker">END OF EXHIBITION</span>
        <span class="door-title">展览终点</span>
        <span class="door-sub">从普拉多的蒙娜丽莎到索罗拉 · 一部西班牙绘画史</span>
        <span class="door-arrow">现</span>
        <span class="door-sub">点击回看作品目录</span>`;
      const go = () => openCatalog();
      el.addEventListener('click', go);
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    }
    return el;
  }

  function renderWall(index) {
    if (state.panRaf) { cancelAnimationFrame(state.panRaf); state.panRaf = 0; }
    const room = DATA.rooms[index];
    const wall = $('#wall');
    wall.style.transform = 'translate3d(0,0,0)';
    wall.innerHTML = '';
    wall.appendChild(buildRoomTitlePanel(room, index));
    room.exhibits.forEach((ex, ei) => wall.appendChild(buildArtwork(ex, ei, index)));
    wall.appendChild(buildDoor(index));
    const tail = document.createElement('div');
    tail.className = 'wall-tail';
    wall.appendChild(tail);
    requestAnimationFrame(() => {
      measureWall();
      applyPanInstant(0);
    });
  }

  function measureWall() {
    const wall = $('#wall');
    const vp = $('#wallViewport');
    state.artworks = $$('.artwork', wall).map(el => ({
      el,
      inner: el.firstElementChild,
      left: el.offsetLeft,
      width: el.offsetWidth
    }));
    const last = wall.lastElementChild;
    const contentRight = last ? last.offsetLeft + last.offsetWidth : wall.scrollWidth;
    state.wallMax = Math.max(0, contentRight - vp.clientWidth);
    updateNav();
  }

  function applyPanInstant(x) {
    state.panX = clamp(x, 0, state.wallMax);
    state.targetPan = state.panX;
    $('#wall').style.transform = `translate3d(${-state.panX}px,0,0)`;
    const fill = state.wallMax ? (state.panX / state.wallMax) * 100 : 0;
    $('#panFill').style.width = `${fill}%`;
    updateDepth();
    updateNav();
  }

  function setPanTarget(x) {
    state.targetPan = clamp(x, 0, state.wallMax);
    if (!state.panRaf) state.panRaf = requestAnimationFrame(panLoop);
  }

  function panLoop() {
    const diff = state.targetPan - state.panX;
    if (Math.abs(diff) < 0.6) {
      state.panX = state.targetPan;
      applyPanInstant(state.panX);
      state.panRaf = 0;
      return;
    }
    state.panX += diff * 0.2;
    $('#wall').style.transform = `translate3d(${-state.panX}px,0,0)`;
    const fill = state.wallMax ? (state.panX / state.wallMax) * 100 : 0;
    $('#panFill').style.width = `${fill}%`;
    updateDepth();
    updateNav();
    state.panRaf = requestAnimationFrame(panLoop);
  }

  function updateDepth() {
    if (window.innerWidth < 900) return;
    const vw = window.innerWidth;
    const half = vw / 2;
    const px = state.dragging ? null : state.pointerX;
    const range = 280;
    state.artworks.forEach(a => {
      const center = a.left - state.panX + a.width / 2;
      const d = (center - half) / half;
      const ry = clamp(-d * 4.5, -4.5, 4.5);
      const tz = -Math.min(Math.abs(d) * 55, 55);
      let scale = 1;
      let lift = 0;
      if (px != null) {
        const dist = Math.abs(center - px);
        if (dist < range) {
          const k = 1 - dist / range;
          scale = 1 + 0.1 * k * k;
          lift = -14 * k * k;
        }
      }
      a.inner.style.transform =
        `translate3d(0,${lift.toFixed(2)}px,${tz}px) rotateY(${ry}deg) scale(${scale.toFixed(3)})`;
    });
  }

  function updateNav() {
    const atStart = state.panX <= 1;
    const atEnd = state.panX >= state.wallMax - 1;
    $('#prevBtn').disabled = atStart && state.roomIndex === 0;
    $('#nextBtn').disabled = atEnd && state.roomIndex === DATA.rooms.length - 1;
  }

  function step(dir) {
    const vw = $('#wallViewport').clientWidth;
    if (dir > 0 && state.panX >= state.wallMax - 2) {
      if (state.roomIndex < DATA.rooms.length - 1) enterRoom(state.roomIndex + 1, true, 'start');
      return;
    }
    if (dir < 0 && state.panX <= 2) {
      if (state.roomIndex > 0) enterRoom(state.roomIndex - 1, true, 'end');
      return;
    }
    setPanTarget(state.targetPan + dir * vw * 0.7);
  }

  function enterRoom(index, showThreshold = true, position = 'start') {
    if (index < 0 || index >= DATA.rooms.length) return;
    if (state.panRaf) { cancelAnimationFrame(state.panRaf); state.panRaf = 0; }
    state.roomIndex = index;
    renderWall(index);
    updateTop();
    updateRoute();
    preloadRoom(index);
    preloadRoom(index + 1);
    if (showThreshold) {
      showThresholdPanel(index);
    } else {
      $('#threshold').hidden = true;
      if (state.overlay === 'threshold') state.overlay = null;
    }
    if (position === 'end') {
      requestAnimationFrame(() => {
        measureWall();
        applyPanInstant(state.wallMax);
      });
    }
  }

  function preloadRoom(index) {
    if (index < 0 || index >= DATA.rooms.length || preloaded.has(index)) return;
    preloaded.add(index);
    DATA.rooms[index].exhibits.forEach(ex => {
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.decoding = 'async';
      img.src = ex.hero.src;
    });
  }

  /* ---------- 门槛 ---------- */
  function knowledgeHtml(room) {
    if (!room.knowledge || !room.knowledge.length) return '';
    return `<p class="tk-title">本厅关键词</p>
      ${room.knowledge.map((k, i) => `<details${i === 0 ? ' open' : ''}><summary>${esc(k.term)}</summary><p>${esc(k.text)}</p></details>`).join('')}`;
  }

  function showThresholdPanel(index) {
    const room = DATA.rooms[index];
    state.overlay = 'threshold';
    $('#threshold').hidden = false;
    const tbg = $('#thresholdBgImg');
    if (tbg) {
      tbg.referrerPolicy = 'no-referrer';
      tbg.src = `${room.exhibits[0].hero.src}&bg=threshold`;
    }
    $('#thresholdKicker').textContent = `${room.chapter} · ${pad2(index + 1)} / ${DATA.meta.roomCount}`;
    $('#thresholdKicker').style.color = room.sectionColor;
    $('#thresholdTitle').textContent = room.title;
    $('#thresholdSub').textContent = room.subtitle;
    $('#thresholdIntro').innerHTML = room.intro.map(p => `<p>${esc(p)}</p>`).join('');
    $('#thresholdKnowledge').innerHTML = knowledgeHtml(room);
    $('#thresholdPanel').scrollTop = 0;
    $('#threshold').scrollTop = 0;
  }

  function skipThreshold() {
    $('#threshold').hidden = true;
    if (state.overlay === 'threshold') state.overlay = null;
    if (window.innerWidth < 720 && !mobileHintShown) {
      mobileHintShown = true;
      setTimeout(() => toast('左右拖动浏览展墙 · 点击画作查看详情'), 450);
    }
  }

  /* ---------- 详情 ---------- */
  function openDetail(ri, ei, imgIndex = 0, from = null) {
    const room = DATA.rooms[ri];
    const ex = room.exhibits[ei];
    if (!ex) return;
    hideToast();
    closeTagWiki();
    closeArtistWiki();
    state.detail = { ri, ei, imgIndex };
    state.detailFrom = from;
    state.overlay = 'detail';
    $('#detail').hidden = false;
    const backLabel = from === 'catalog' ? '返回目录' : from === 'timeline' ? '返回时间轴' : from === 'network' ? '返回关系图' : '返回展厅';
    $('#detailCloseBtn').innerHTML = `← <span>${backLabel}</span>`;
    renderDetail();
    markVisited(ex.id);
  }

  const INTRO_META = /(完成于|创作于|作于)\s*\d{4}|(?:长|高|宽)\s*\d+(?:\.\d+)?\s*(?:cm|厘米)|油彩画布|布面油画|布面油彩|现藏于|收藏于/;
  const INTRO_DESC = /描绘|表现|展现|象征|代表|构图|色彩|笔触|人物|画面|背景|前景|气氛|风格|故事|题材|场景|光线|阴影|细节|作品|画家|创作背景|灵感|意义|奠基|创始|领军|大师|巨匠/;
  const INTRO_START = /^(本单元|本次展览|这部分|按时间顺序|第一|另一|最后|首先|第[一二三四五六七八九十]+件|这(幅|件))/;

  function cleanIntroParagraph(text, ex) {
    const sentences = text.match(/[^。！？]+[。！？]?/g) || [text];
    const kept = [];
    sentences.forEach((raw, idx) => {
      let sent = raw;
      const stripped = sent.replace(/[。，、；：\s]/g, '');
      const isTitleIntro = idx === 0 && sent.includes(ex.name) && INTRO_START.test(sent);
      const isShortTitle = idx === 0 && sent.includes(ex.name) && stripped.length < ex.name.length + 35 && !INTRO_DESC.test(sent);
      if (isTitleIntro || isShortTitle) return;
      const meta = INTRO_META.test(sent);
      const desc = INTRO_DESC.test(sent);
      if (meta && !desc) return;
      if (meta) {
        sent = sent
          .replace(/(?:长|高|宽)\s*\d+(?:\.\d+)?\s*(?:cm|厘米)(?:\s*[，,、]\s*(?:长|高|宽)\s*\d+(?:\.\d+)?\s*(?:cm|厘米))*\s*[，,、]?\s*/g, '')
          .replace(/(?:完成于|创作于|作于)\s*\d{4}(?:\s*[-–—~至]\s*\d{4})?\s*(?:年间|年|前后|左右)?\s*[，,、]?\s*/g, '')
          .replace(/(?:油彩画布|布面油画|布面油彩)[，,、]?\s*/g, '')
          .replace(/现藏于[^。！？]*[。！？]?/g, '');
      }
      kept.push(sent);
    });
    const t = kept.join('')
      .replace(/[，,]\s*[。]/g, '。')
      .replace(/[，,]{2,}/g, '，')
      .replace(/^[，,、。\s]+/, '')
      .trim();
    const bare = t.replace(/[。，、；：\s]/g, '');
    const name = ex.name.replace(/[《》\s]/g, '');
    if (!bare) return '';
    if (bare.includes(name) && bare.length < name.length + 18 && !INTRO_DESC.test(t)) return '';
    return t;
  }

  function renderDetail() {
    if (!state.detail) return;
    const { ri, ei, imgIndex } = state.detail;
    const room = DATA.rooms[ri];
    const ex = room.exhibits[ei];
    const flatIndex = FLAT.findIndex(f => f.ri === ri && f.ei === ei);
    const item = FLAT[flatIndex];

    $('#detailKicker').textContent = `${room.chapter} · ${room.title}`;
    $('#detailKicker').style.color = room.sectionColor;
    $('#detailName').textContent = ex.name;
    $('#detailArtist').textContent = ex.artist;
    $('#detailArtist').dataset.artistId = ex.artistId;
    $('#detailMeta').textContent = [ex.yearLabel, ex.school, ex.medium, ex.dims && ex.dims !== '—' ? ex.dims : ''].filter(Boolean).join(' · ');
    $('#detailCounter').textContent = `第 ${item.global} 组 / 共 ${DATA.meta.total} 组`;
    const intro = ex.intro.map(p => cleanIntroParagraph(p, ex)).filter(Boolean);
    $('#detailBody').innerHTML = intro.length
      ? intro.map(p => `<p>${esc(p)}</p>`).join('')
      : '<p>本组展项暂无简介。</p>';
    const foot = $('#detailFoot');
    if (ex.detailLink) {
      foot.hidden = false;
      foot.innerHTML = `<a class="detail-link" href="${esc(ex.detailLink)}" target="_blank" rel="noopener"><span>延伸阅读 · 高清赏析</span><span>↗</span></a>`;
    } else {
      foot.hidden = true;
      foot.innerHTML = '';
    }

    $('#detailPrevBtn').disabled = flatIndex <= 0;
    $('#detailNextBtn').disabled = flatIndex >= FLAT.length - 1;
    $('#detailPanel').scrollTop = 0;

    renderTags(ex);
    renderGraph(ex, ri);
    renderViewer(ex, imgIndex);
  }

  /* ---------- 特征标签 ---------- */
  function renderTags(ex) {
    const wrap = $('#detailTags');
    const tags = ex.tags || [];
    if (!tags.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = `
      <div class="dt-head"><span>特征标签</span><small>点击标签查看百科</small></div>
      <div class="tag-list">${tags.map(t => `<button type="button" class="tag-chip ${esc(t.kind)}" data-tag="${esc(t.name)}" data-kind="${esc(t.kind)}" title="点击查看「${esc(t.name)}」百科">${esc(t.name)}</button>`).join('')}</div>`;
  }

  function openTagWiki(name, kind) {
    if (!name) return;
    const currentId = state.detail ? DATA.rooms[state.detail.ri].exhibits[state.detail.ei].id : '';
    const allRelated = FLAT.filter(f => f.ex.id !== currentId && (f.ex.tags || []).some(t => t.name === name));
    const related = allRelated.slice(0, 8);
    $('#twTitle').textContent = name;
    $('#twKind').textContent = TAG_KIND_LABEL[kind] || '';
    $('#twBody').innerHTML = `<p>${esc(tagWikiText(name))}</p>`;
    $('#twWorks').innerHTML = related.length
      ? related.map(f => `<button type="button" class="tw-card" data-id="${esc(f.ex.id)}"><span class="tw-card-media"><img referrerpolicy="no-referrer" loading="lazy" src="${esc(f.ex.hero.src)}" alt="${esc(f.ex.name)}"></span><span class="tw-card-txt">${esc(f.ex.name)}<small>${esc(f.room.title)} · ${esc(f.ex.artist)}</small></span></button>`).join('')
      : '<p class="tw-empty">暂无其他相关展品。</p>';
    if (allRelated.length > related.length) {
      $('#twWorks').insertAdjacentHTML('beforeend', `<p class="tw-empty">共 ${allRelated.length} 件相关展品，展示前 ${related.length} 件。</p>`);
    }
    $$('.tw-card', $('#twWorks')).forEach(btn => {
      btn.addEventListener('click', () => {
        const item = FLAT.find(f => f.ex.id === btn.dataset.id);
        closeTagWiki();
        if (item) openDetail(item.ri, item.ei, 0, state.detailFrom);
      });
    });
    $('#tagWiki').hidden = false;
    const twPanel = $('#tagWiki .tw-panel');
    if (twPanel) twPanel.scrollTop = 0;
    $('#twCloseBtn').focus({ preventScroll: true });
  }

  function closeTagWiki() {
    $('#tagWiki').hidden = true;
  }

  /* ---------- 艺术家百科 ---------- */
  function openArtistWiki(id) {
    const artist = (DATA.artists || []).find(a => a.id === id);
    if (!artist) return;
    $('#awTitle').textContent = artist.name;
    $('#awMeta').textContent = [artist.life, artist.nameEn, artist.school].filter(Boolean).join(' · ');
    $('#awBody').innerHTML = `<p>${esc(artist.blurb)}</p>`;
    const works = FLAT.filter(f => f.ex.artistId === id);
    $('#awWorks').innerHTML = works.length
      ? works.map(f => `<button type="button" class="tw-card" data-id="${esc(f.ex.id)}"><span class="tw-card-media"><img referrerpolicy="no-referrer" loading="lazy" src="${esc(f.ex.hero.src)}" alt="${esc(f.ex.name)}"></span><span class="tw-card-txt">${esc(f.ex.name)}<small>${esc(f.ex.yearLabel)} · ${esc(f.room.title)}</small></span></button>`).join('')
      : '<p class="tw-empty">本展暂无作品。</p>';
    const rels = (DATA.relations || []).filter(r => r.a === id || r.b === id);
    const byId = new Map((DATA.artists || []).map(a => [a.id, a]));
    $('#awRel').innerHTML = rels.length
      ? rels.map(r => {
          const other = byId.get(r.a === id ? r.b : r.a);
          return `<button type="button" class="tw-work" data-artist="${esc(other.id)}"><b>${esc(r.type)}</b> ${esc(other.name)}<small>${esc(r.note)}</small></button>`;
        }).join('')
      : '<p class="tw-empty">暂无记录。</p>';
    $$('#awWorks .tw-card').forEach(btn => btn.addEventListener('click', () => {
      const f = FLAT.find(x => x.ex.id === btn.dataset.id);
      if (!f) return;
      closeArtistWiki();
      openDetail(f.ri, f.ei, 0, state.detailFrom);
    }));
    $$('#awRel .tw-work').forEach(btn => btn.addEventListener('click', () => openArtistWiki(btn.dataset.artist)));
    $('#artistWiki').hidden = false;
    const awPanel = $('#artistWiki .tw-panel');
    if (awPanel) awPanel.scrollTop = 0;
    $('#awCloseBtn').focus({ preventScroll: true });
  }

  function closeArtistWiki() {
    $('#artistWiki').hidden = true;
  }

  /* ---------- 关系动力图 ---------- */
  function normalizeArtist(a) {
    return String(a || '').replace(/（传）|\(传\)/g, '').trim();
  }

  function getRelated(ex, ri) {
    const styles = new Set((ex.tags || []).filter(t => t.kind === 'style').map(t => t.name));
    const subjects = new Set((ex.tags || []).filter(t => t.kind === 'subject').map(t => t.name));
    const artist = normalizeArtist(ex.artist);
    return FLAT.filter(f => f.ex.id !== ex.id).map(f => {
      let score = 0;
      const kinds = [];
      const reasons = [];
      if (artist && artist !== '佚名' && normalizeArtist(f.ex.artist) === artist) {
        score += 8;
        kinds.push('artist');
        reasons.push('同一作者');
      }
      const sharedStyle = (f.ex.tags || []).filter(t => t.kind === 'style' && styles.has(t.name)).map(t => t.name);
      if (sharedStyle.length) {
        score += sharedStyle.length * 5;
        kinds.push('style');
        reasons.push(...sharedStyle);
      }
      const sharedSubject = (f.ex.tags || []).filter(t => t.kind === 'subject' && subjects.has(t.name)).map(t => t.name);
      if (sharedSubject.length) {
        score += sharedSubject.length * 2;
        kinds.push('subject');
        reasons.push(...sharedSubject);
      }
      if (f.ri === ri) score += 0.8;
      if (f.ex.school === ex.school) score += 0.3;
      const kind = kinds.includes('artist') ? 'artist' : kinds.includes('style') ? 'style' : kinds.includes('subject') ? 'subject' : 'room';
      return { item: f, score, kind, reasons };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 7);
  }

  function shortName(name) {
    let s = String(name || '').replace(/[（(].*?[）)]/g, '');
    s = s.replace(/\s+/g, '');
    return s.slice(0, 5) || '作品';
  }

  function renderGraph(ex, ri) {
    const wrap = $('#detailGraph');
    const related = getRelated(ex, ri);
    if (!related.length) {
      wrap.innerHTML = '<div class="dg-head"><span>展品关系 · 动力图</span></div><p class="dg-empty">暂无足够关联的展品。</p>';
      return;
    }
    const cx = 180, cy = 148, radius = 102;
    const positions = related.map((r, i) => {
      const a = -Math.PI / 2 + i * (2 * Math.PI / related.length);
      return { x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius };
    });
    const edges = related.map((r, i) => `<line class="rel-edge ${r.kind}" x1="${cx}" y1="${cy}" x2="${positions[i].x.toFixed(1)}" y2="${positions[i].y.toFixed(1)}"/>`).join('');
    const nodes = related.map((r, i) => {
      const p = positions[i];
      const reason = r.reasons.length ? r.reasons.join('、') : '同厅展品';
      return `<g class="rel-node ${r.kind}" data-id="${esc(r.item.ex.id)}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">
        <circle r="21"></circle>
        <text y="4">${esc(shortName(r.item.ex.name))}</text>
        <title>${esc(r.item.ex.name)} · ${esc(reason)}</title>
      </g>`;
    }).join('');
    wrap.innerHTML = `
      <div class="dg-head"><span>展品关系 · 动力图</span><small>点击节点切换</small></div>
      <svg class="rel-graph" viewBox="0 0 360 300" role="img" aria-label="展品关系图">
        ${edges}${nodes}
        <g class="rel-center" transform="translate(${cx},${cy})">
          <circle r="30"></circle>
          <text y="4">${esc(shortName(ex.name))}</text>
          <title>${esc(ex.name)}</title>
        </g>
      </svg>
      <div class="dg-legend">
        <span><i class="artist"></i>同一作者</span>
        <span><i class="style"></i>同一风格</span>
        <span><i class="subject"></i>同一题材</span>
        <span><i class="room"></i>同厅 / 同期</span>
      </div>`;
    $$('.rel-node', wrap).forEach(g => {
      g.addEventListener('click', () => {
        const item = FLAT.find(f => f.ex.id === g.dataset.id);
        if (item) openDetail(item.ri, item.ei, 0, state.detailFrom);
      });
    });
  }

  function initialViewerMode() {
    const v = state.viewer;
    const r = v.visualW / v.visualH;
    if (r <= 1 / 3) return 'width';
    if (r >= 3) return 'height';
    return 'all';
  }

  function setViewerFullscreen(on, quiet = false) {
    const v = state.viewer;
    const should = !!on;
    if (should === v.fullscreen) return;
    v.fullscreen = should;
    $('#detail').classList.toggle('viewer-max', should);
    $('#viewerFullBtn').setAttribute('aria-pressed', should ? 'true' : 'false');
    if (!state.detail) return;
    const ex = DATA.rooms[state.detail.ri].exhibits[state.detail.ei];
    const im = ex.images[state.detail.imgIndex] || ex.hero;
    v.rotated = false;
    v.natW = im.w || 1000;
    v.natH = im.h || 1000;
    v.visualW = v.rotated ? v.natH : v.natW;
    v.visualH = v.rotated ? v.natW : v.natH;
    requestAnimationFrame(() => fitViewer(initialViewerMode()));
    if (!quiet) toast(should
      ? (isMobileLayout() ? '全屏查看 · 拖动浏览，双指缩放' : '全屏查看 · 拖动浏览，滚轮缩放')
      : '已退出全屏');
  }

  function renderViewer(ex, imgIndex) {
    const im = ex.images[imgIndex] || ex.hero;
    const v = state.viewer;
    v.rotated = false;
    v.natW = im.w || 1000;
    v.natH = im.h || 1000;
    v.visualW = v.rotated ? v.natH : v.natW;
    v.visualH = v.rotated ? v.natW : v.natH;
    const img = $('#viewerImg');
    img.onerror = null;
    img.onload = null;
    img.referrerPolicy = 'no-referrer';
    img.src = im.full;
    img.alt = `${ex.name} · 图${imgIndex + 1}`;
    img.dataset.fallback = '';
    img.dataset.retried = '';
    img.onload = () => {
      // 微信图床偶发返回小尺寸占位图，检测到后带参数重取一次
      if (img.naturalWidth > 0 && img.naturalWidth <= 200 && img.dataset.retried !== '1') {
        img.dataset.retried = '1';
        img.src = `${im.src}&r=${Date.now()}`;
      }
    };
    img.onerror = () => {
      if (img.dataset.fallback !== '1') {
        img.dataset.fallback = '1';
        img.src = im.src;
      }
    };
    fitViewer(initialViewerMode());
    renderThumbs(ex, imgIndex);
    const cap = $('#viewerCaption');
    if (cap) {
      cap.textContent = im.caption || '';
      cap.classList.toggle('show', !!im.caption);
    }
  }

  function renderThumbs(ex, active) {
    const wrap = $('#viewerThumbs');
    wrap.innerHTML = '';
    if (ex.images.length <= 1) return;
    const buttons = ex.images.map((im, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'vthumb' + (i === active ? ' active' : '');
      b.innerHTML = `<img referrerpolicy="no-referrer" src="${esc(im.src)}" alt="">`;
      b.addEventListener('click', () => {
        if (!state.detail) return;
        state.detail.imgIndex = i;
        const ex2 = DATA.rooms[state.detail.ri].exhibits[state.detail.ei];
        renderViewer(ex2, i);
      });
      wrap.appendChild(b);
      return b;
    });
    const current = buttons[active];
    if (current) {
      requestAnimationFrame(() => {
        current.scrollIntoView({ block: 'nearest', inline: 'center' });
      });
    }
  }

  function fitViewer(mode) {
    const v = state.viewer;
    const stage = $('#viewerStage');
    const sw = stage.clientWidth || 800;
    const sh = stage.clientHeight || 500;
    const vw = v.visualW;
    const vh = v.visualH;
    let s;
    if (mode === 'width') s = (sw * (state.viewer.fullscreen ? 0.9 : 0.72)) / vw;
    else if (mode === 'height') s = (sh * 0.92) / vh;
    else s = Math.min((sw - 24) / vw, (sh - 24) / vh);
    s = Math.max(s, 0.0001);
    v.fit = s;
    v.scale = 1;
    v.mode = mode;
    if (mode === 'width') {
      v.x = 0;
      v.y = Math.max(0, (vh * s - sh) / 2);
      $('#viewerHint').textContent = '上下拖动查看画面 · 按钮缩放';
    } else if (mode === 'height') {
      const maxX = Math.max(0, (vw * s - sw) / 2);
      v.x = v.rotated ? -maxX : maxX;
      v.y = 0;
      $('#viewerHint').textContent = v.rotated ? '滚轮横向滚动 · Ctrl+滚轮缩放 · 拖动查看' : '左右拖动查看画面 · 滚轮滚动';
    } else {
      v.x = 0;
      v.y = 0;
      $('#viewerHint').textContent = '滚轮缩放 · 拖动查看细节 · 双击放大';
    }
    clampViewer();
    applyViewer();
  }

  function applyViewer() {
    const v = state.viewer;
    const img = $('#viewerImg');
    const art = $('#viewerArt');
    const vw = v.visualW * v.fit * v.scale;
    const vh = v.visualH * v.fit * v.scale;
    art.style.width = `${vw}px`;
    art.style.height = `${vh}px`;
    img.style.width = `${v.natW * v.fit * v.scale}px`;
    img.style.height = `${v.natH * v.fit * v.scale}px`;
    img.style.transform = `translate(-50%, -50%) rotate(${v.rotated ? 90 : 0}deg)`;
    art.style.transform = `translate(${v.x}px, ${v.y}px)`;
    updateScrollbar(vw, vh);
  }

  function updateScrollbar(vw, vh) {
    const bar = $('#viewerScrollbar');
    const thumb = bar.firstElementChild;
    const stage = $('#viewerStage');
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    if (vw > sw + 4) {
      bar.className = 'viewer-scrollbar horizontal show';
      const tw = clamp((sw / vw) * 100, 8, 100);
      const maxX = (vw - sw) / 2 + 20;
      const ratio = maxX > 0 ? clamp((maxX - state.viewer.x) / (2 * maxX), 0, 1) : 0;
      thumb.style.width = `${tw}%`;
      thumb.style.height = '100%';
      thumb.style.left = `${ratio * (100 - tw)}%`;
      thumb.style.top = '0';
    } else if (vh > sh + 4) {
      bar.className = 'viewer-scrollbar vertical show';
      const th = clamp((sh / vh) * 100, 8, 100);
      const maxY = (vh - sh) / 2 + 20;
      const ratio = maxY > 0 ? clamp((maxY - state.viewer.y) / (2 * maxY), 0, 1) : 0;
      thumb.style.height = `${th}%`;
      thumb.style.width = '100%';
      thumb.style.top = `${ratio * (100 - th)}%`;
      thumb.style.left = '0';
    } else {
      bar.className = 'viewer-scrollbar';
    }
  }

  function clampViewer() {
    const v = state.viewer;
    const stage = $('#viewerStage');
    const vw = v.visualW * v.fit * v.scale;
    const vh = v.visualH * v.fit * v.scale;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const maxX = vw > sw ? (vw - sw) / 2 + 20 : 0;
    const maxY = vh > sh ? (vh - sh) / 2 + 20 : 0;
    v.x = clamp(v.x, -maxX, maxX);
    v.y = clamp(v.y, -maxY, maxY);
  }

  function zoomViewer(factor) {
    const v = state.viewer;
    const next = clamp(v.scale * factor, 1, 12);
    if (Math.abs(next - v.scale) < 0.001) return;
    v.scale = next;
    clampViewer();
    applyViewer();
  }

  function loadImageCors(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.referrerPolicy = 'no-referrer';
      const timer = setTimeout(() => reject(new Error('timeout')), 25000);
      img.onload = () => { clearTimeout(timer); resolve(img); };
      img.onerror = () => { clearTimeout(timer); reject(new Error('load')); };
      img.src = url;
    });
  }

  async function loadDownloadImage(url) {
    // 微信图床不返回 CORS 头，canvas 无法直接读取像素。
    // 先试原图，再经公共图片代理取回同源可读的副本，仅用于加水印保存。
    const candidates = [
      url,
      `https://images.weserv.nl/?url=${encodeURIComponent(url)}`,
      `https://wsrv.nl/?url=${encodeURIComponent(url)}`
    ];
    let lastError = null;
    for (const src of candidates) {
      try {
        return await loadImageCors(src);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('load');
  }

  function drawWatermarkedCanvas(img, rotate, scale) {
    const srcW = img.naturalWidth;
    const srcH = img.naturalHeight;
    const cw = Math.max(1, Math.round((rotate ? srcH : srcW) * scale));
    const ch = Math.max(1, Math.round((rotate ? srcW : srcH) * scale));
    if (cw > 16384 || ch > 16384 || cw * ch > 100e6) {
      return Promise.reject(new Error('too-large'));
    }
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.reject(new Error('ctx'));
    ctx.fillStyle = '#0d0b09';
    ctx.fillRect(0, 0, cw, ch);
    if (rotate) {
      ctx.save();
      ctx.translate(cw / 2, ch / 2);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(img, -srcW * scale / 2, -srcH * scale / 2, srcW * scale, srcH * scale);
      ctx.restore();
    } else {
      ctx.drawImage(img, 0, 0, cw, ch);
    }
    const fs = Math.max(14, Math.min(120, Math.round(Math.min(cw * 0.018, ch * 0.07))));
    const text = '獭的游乐场';
    const x = cw - fs * 0.9;
    const y = ch - fs * 0.65;
    ctx.font = `${fs}px "Songti SC","STSong","SimSun",serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = fs * 0.6;
    ctx.shadowOffsetY = fs * 0.06;
    ctx.lineWidth = Math.max(1, fs * 0.075);
    ctx.strokeStyle = 'rgba(35,26,18,0.6)';
    ctx.strokeText(text, x, y);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = 'rgba(255,248,235,0.56)';
    ctx.fillText(text, x, y);
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob) resolve({ blob, cw, ch });
        else reject(new Error('blob'));
      }, 'image/jpeg', 0.92);
    });
  }

  async function downloadWatermarked() {
    if (!state.detail) return;
    const ex = DATA.rooms[state.detail.ri].exhibits[state.detail.ei];
    const im = ex.images[state.detail.imgIndex] || ex.hero;
    const rotate = state.viewer.rotated;
    const fileName = `獭的游乐场_${String(ex.name).replace(/[\\/:*?"<>|]/g, '_')}.jpg`;
    toast('正在准备大图…');
    let img;
    let lowRes = false;
    try {
      img = await loadDownloadImage(im.full);
    } catch (e) {
      try {
        img = await loadDownloadImage(im.src);
        lowRes = true;
      } catch (err) {
        toast('图片加载失败，暂时无法保存');
        return;
      }
    }
    const srcW = img.naturalWidth;
    const srcH = img.naturalHeight;
    const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const maxPixels = touch ? 16e6 : 100e6;
    const baseScale = Math.min(
      1,
      16384 / Math.max(srcW, srcH),
      Math.sqrt(maxPixels / (srcW * srcH))
    );
    const scales = [];
    [1, 0.72, 0.5, 0.32].forEach(k => {
      const s = baseScale * k;
      if (s > 0.01 && !scales.some(x => Math.abs(x - s) < 1e-6)) scales.push(s);
    });
    for (const scale of scales) {
      try {
        const { blob } = await drawWatermarkedCanvas(img, rotate, scale);
        const a = document.createElement('a');
        const url = URL.createObjectURL(blob);
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        toast(lowRes
          ? '原图暂不可用，已保存预览图'
          : (scale < baseScale - 0.01 ? '已保存高清图（受设备限制略缩）' : '已保存带水印大图'));
        return;
      } catch (e) { /* try a smaller canvas */ }
    }
    toast('图片过大，保存失败，请换用电脑浏览器重试');
  }

  function stepDetail(dir) {
    if (!state.detail) return;
    const idx = FLAT.findIndex(f => f.ri === state.detail.ri && f.ei === state.detail.ei);
    const next = FLAT[idx + dir];
    if (!next) return;
    if (next.ri !== state.detail.ri) enterRoom(next.ri, false);
    state.detail = { ri: next.ri, ei: next.ei, imgIndex: 0 };
    renderDetail();
    markVisited(next.ex.id);
  }

  function closeDetail() {
    setViewerFullscreen(false, true);
    state.viewer.pointers.clear();
    state.viewer.pinch = null;
    state.viewer.dragging = false;
    closeTagWiki();
    closeArtistWiki();
    $('#detail').hidden = true;
    state.detail = null;
    if (state.overlay === 'detail') state.overlay = null;
    const from = state.detailFrom;
    state.detailFrom = null;
    if (from === 'catalog') openCatalog();
    else if (from === 'timeline') { state.overlay = 'timeline'; }
    else if (from === 'network') { state.overlay = 'network'; }
  }

  /* ---------- 目录 ---------- */
  const SCHOOLS = [...new Set(FLAT.map(f => f.ex.school))];
  const WORK_ARTISTS = (DATA.artists || []).filter(a => a.works > 0);

  function chipRow(wrap, items, active, onPick) {
    wrap.innerHTML = '';
    items.forEach(it => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'filter-chip' + (active === it.key ? ' active' : '');
      b.innerHTML = (it.color ? `<i class="chip-dot" style="background:${it.color}"></i>` : '') + esc(it.label);
      b.addEventListener('click', () => onPick(it.key));
      wrap.appendChild(b);
    });
  }

  function renderCatalogFilters() {
    chipRow($('#catalogRoomFilters'),
      [{ key: 'all', label: `全部展厅 ${DATA.meta.total} 组` }].concat(
        DATA.rooms.map((r, i) => ({
          key: String(i),
          label: `${pad2(i + 1)} ${r.title} · ${r.exhibits.length}`,
          color: r.sectionColor
        }))
      ),
      state.catalogFilter,
      key => { state.catalogFilter = key; renderCatalogFilters(); renderCatalog(); });

    chipRow($('#catalogSchoolFilters'),
      [{ key: 'all', label: '全部流派' }].concat(SCHOOLS.map(s => ({ key: s, label: s }))),
      state.catalogSchool,
      key => { state.catalogSchool = key; renderCatalogFilters(); renderCatalog(); });

    const sel = $('#catalogArtistSelect');
    if (sel.dataset.ready !== '1') {
      sel.dataset.ready = '1';
      sel.innerHTML = '<option value="all">全部艺术家</option>' + WORK_ARTISTS.map(a => `<option value="${esc(a.id)}">${esc(a.name)}（${a.works}）</option>`).join('');
      sel.addEventListener('change', () => {
        state.catalogArtist = sel.value;
        renderCatalog();
      });
    }
    sel.value = state.catalogArtist;
  }

  function filteredExhibits() {
    const q = state.catalogQuery.trim().toLowerCase();
    return FLAT.filter(item => {
      const ex = item.ex;
      if (state.catalogFilter !== 'all' && String(item.ri) !== state.catalogFilter) return false;
      if (state.catalogSchool !== 'all' && ex.school !== state.catalogSchool) return false;
      if (state.catalogArtist !== 'all' && ex.artistId !== state.catalogArtist) return false;
      if (!q) return true;
      const hay = `${ex.name} ${ex.artist} ${ex.school} ${ex.yearLabel} ${ex.medium} ${item.room.title} ${(ex.tags || []).map(t => t.name).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  }

  function renderCatalog() {
    const grid = $('#catalogGrid');
    const items = filteredExhibits();
    const count = $('#catalogCount');
    const works = items.reduce((n, f) => n + (f.ex.workCount || 1), 0);
    if (count) count.textContent = `${items.length} 组 / ${works} 件`;
    if (!items.length) {
      grid.innerHTML = '<div class="catalog-empty">没有找到匹配的展品，试试其他关键词或清空筛选。</div>';
      return;
    }
    grid.innerHTML = items.map(item => {
      const ex = item.ex;
      const wc = ex.workCount || 1;
      return `<article class="cat-card${state.visited.has(ex.id) ? ' visited' : ''}" data-id="${esc(ex.id)}" tabindex="0" role="button" aria-label="${esc(ex.name)}">
        <div class="cat-img">
          <img loading="lazy" referrerpolicy="no-referrer" src="${esc(ex.hero.src)}" alt="">
          <span class="cat-no">${pad2(item.global)}</span>
          ${wc > 1 ? `<span class="cat-works">${wc} 件</span>` : ''}
        </div>
        <p class="cat-name">${esc(ex.name)}</p>
        <div class="cat-meta">${esc(ex.artist)} · ${esc(ex.yearLabel)}</div>
        <div class="cat-room">${esc(ex.school)} · ${esc(item.room.title)}</div>
      </article>`;
    }).join('');
  }

  function openCatalog() {
    hideToast();
    state.overlay = 'catalog';
    $('#catalog').hidden = false;
    renderCatalogFilters();
    renderCatalog();
  }

  function closeCatalog() {
    state.catalogScroll = $('#catalog').scrollTop;
    $('#catalog').hidden = true;
    if (state.overlay === 'catalog') state.overlay = null;
  }

  /* ---------- 时间轴（按十年分段的编年带） ---------- */
  const TL_STATE = {
    built: false, dragging: false,
    startX: 0, startScroll: 0, scrolled: false,
    zoom: 1, baseW: 0, baseH: 0
  };

  function openTimeline() {
    hideToast();
    state.overlay = 'timeline';
    $('#timeline').hidden = false;
    renderTimelineSchoolFilters();
    if (!TL_STATE.built) buildTimeline();
    applyTimelineFilter();
    if (!TL_STATE.scrolled) {
      $('#tlScroll').scrollLeft = 0;
      TL_STATE.scrolled = true;
    }
  }
  function closeTimeline() {
    $('#timeline').hidden = true;
    if (state.overlay === 'timeline') state.overlay = null;
  }

  function renderTimelineSchoolFilters() {
    chipRow($('#tlSchoolFilters'),
      [{ key: 'all', label: '全部流派' }].concat(SCHOOLS.map(s => ({ key: s, label: s }))),
      state.timelineSchool,
      key => {
        state.timelineSchool = key;
        renderTimelineSchoolFilters();
        applyTimelineFilter();
      });
  }

  function buildTimeline() {
    const mobile = window.innerWidth <= 720;
    const h = mobile ? 320 : 360;
    const axisY = h - (mobile ? 60 : 68);
    const canvas = $('#tlCanvas');
    const zoomEl = $('#tlZoom');
    canvas.style.height = h + 'px';
    canvas.style.setProperty('--axis-y', axisY + 'px');

    const nodeW = mobile ? 58 : 76;
    const nodeH = mobile ? 72 : 92;
    const gap = mobile ? 7 : 10;
    const bandGap = mobile ? 20 : 30;
    const minBand = mobile ? 100 : 124;

    // 按十年分段，段内按年份排开，避免四百年跨度里缩略图互相重叠
    const byDecade = new Map();
    FLAT.forEach(item => {
      const dec = Math.floor(item.ex.year / 10) * 10;
      if (!byDecade.has(dec)) byDecade.set(dec, []);
      byDecade.get(dec).push(item);
    });
    let cursorX = 24;
    const bands = [...byDecade.keys()].sort((a, b) => a - b).map(dec => {
      const list = byDecade.get(dec).sort((a, b) => a.ex.year - b.ex.year || a.global - b.global);
      const width = Math.max(minBand, list.length * (nodeW + gap) - gap + 28);
      const band = { dec, list, x: cursorX, width };
      cursorX += width + bandGap;
      return band;
    });
    const width = cursorX + 20;
    canvas.style.width = width + 'px';
    TL_STATE.baseW = width;
    TL_STATE.baseH = h;
    zoomEl.style.width = width + 'px';
    zoomEl.style.height = h + 'px';

    let years = '';
    let marks = '';
    let html = '';
    let lastCentury = -1;
    bands.forEach(band => {
      const startX = band.x + 14;
      years += '<div class="tl-year major" style="left:' + startX + 'px;top:' + axisY + 'px"><i></i><span>' + band.dec + '</span></div>';
      const century = Math.floor(band.dec / 100) + 1;
      if (century !== lastCentury) {
        marks += '<div class="tl-decade" style="left:' + startX + 'px;top:' + (mobile ? 10 : 16) + 'px">' + century + ' 世纪</div>';
        lastCentury = century;
      }
      band.list.forEach((item, idx) => {
        const ex = item.ex;
        const left = startX + idx * (nodeW + gap);
        const top = axisY - 14 - nodeH;
        html += '<button type="button" class="tl-node" data-id="' + esc(ex.id) + '" data-year="' + ex.year + '" style="left:' + left.toFixed(1) + 'px;top:' + top + 'px;width:' + nodeW + 'px;height:' + nodeH + 'px" title="' + esc(ex.name) + ' · ' + esc(ex.artist) + ' · ' + esc(ex.yearLabel) + '">'
          + '<img referrerpolicy="no-referrer" decoding="async" src="' + esc(ex.hero.src) + '" alt="">'
          + '<span>' + esc(ex.name) + '</span>'
          + '</button>';
      });
    });
    $('#tlYears').innerHTML = years + marks;
    $('#tlItems').innerHTML = html;
    $$('.tl-node', $('#tlItems')).forEach(btn => {
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        const f = FLAT.find(x => x.ex.id === btn.dataset.id);
        if (!f) return;
        startGallery();
        enterRoom(f.ri, false, 'start');
        openDetail(f.ri, f.ei, 0, 'timeline');
      });
    });
    TL_STATE.built = true;
    applyTimelineZoom(TL_STATE.zoom, null);
    applyTimelineFilter();
  }

  function applyTimelineZoom(target, focalX) {
    const canvas = $('#tlCanvas');
    const zoomEl = $('#tlZoom');
    const scroll = $('#tlScroll');
    if (!TL_STATE.baseW || !TL_STATE.baseH || !canvas || !zoomEl || !scroll) return;
    const oldZoom = TL_STATE.zoom || 1;
    const z = clamp(target, 0.7, 2.2);
    let contentX = null;
    if (focalX != null) {
      const r = scroll.getBoundingClientRect();
      contentX = (scroll.scrollLeft + (focalX - r.left)) / oldZoom;
    }
    TL_STATE.zoom = z;
    canvas.style.width = (TL_STATE.baseW * z) + 'px';
    canvas.style.height = (TL_STATE.baseH * z) + 'px';
    zoomEl.style.width = TL_STATE.baseW + 'px';
    zoomEl.style.height = TL_STATE.baseH + 'px';
    zoomEl.style.transform = `scale(${z})`;
    scroll.style.height = (TL_STATE.baseH * z) + 'px';
    if (contentX != null) {
      const r2 = scroll.getBoundingClientRect();
      scroll.scrollLeft = Math.max(0, contentX * z - (focalX - r2.left));
    }
    const label = $('#tlZoomLabel');
    if (label) label.textContent = Math.round(z * 100) + '%';
  }

  function bindTimelineZoom() {
    const scroll = $('#tlScroll');
    if (!scroll) return;
    scroll.addEventListener('wheel', e => {
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      if (!delta) return;
      const factor = Math.exp(-delta * 0.0016);
      applyTimelineZoom(TL_STATE.zoom * factor, e.clientX);
    }, { passive: false });
  }

  function applyTimelineFilter() {
    const school = state.timelineSchool;
    let groups = 0, works = 0;
    $$('.tl-node', $('#tlItems')).forEach(n => {
      const item = FLAT.find(x => x.ex.id === n.dataset.id);
      if (!item) return;
      const show = school === 'all' || item.ex.school === school;
      n.style.display = show ? '' : 'none';
      if (show) {
        groups += 1;
        works += item.ex.workCount || 1;
      }
    });
    $('#tlSummary').innerHTML = '<b>' + groups + '</b> 组 · <b>' + works + '</b> 件作品 · 按创作年代排列'
      + (school === 'all' ? '' : ' · ' + esc(school));
  }

  function bindTimelineDrag() {
    const scroll = $('#tlScroll');
    if (!scroll) return;
    scroll.addEventListener('pointerdown', e => {
      if (e.target.closest('.tl-node')) return;
      TL_STATE.dragging = true;
      TL_STATE.startX = e.clientX;
      TL_STATE.startScroll = scroll.scrollLeft;
      scroll.classList.add('dragging');
      try { scroll.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    scroll.addEventListener('pointermove', e => {
      if (!TL_STATE.dragging) return;
      scroll.scrollLeft = TL_STATE.startScroll - (e.clientX - TL_STATE.startX);
    });
    const end = () => {
      TL_STATE.dragging = false;
      scroll.classList.remove('dragging');
    };
    scroll.addEventListener('pointerup', end);
    scroll.addEventListener('pointercancel', end);
    scroll.addEventListener('pointerleave', end);
  }

  /* ---------- 艺术家关系图 ---------- */
  const REL_COLORS = { '师承': '#c9a45c', '挚友': '#6fa3b8', '同道': '#8a9a5b', '影响': '#c97b4a', '论争': '#b0524a' };
  const CLUSTER_COLORS = {
    '文艺复兴与矫饰主义': '#c9a45c',
    '尼德兰与佛兰德斯': '#8a9a5b',
    '西班牙黄金时代': '#6fa3b8',
    '18世纪宫廷': '#c97b4a',
    '戈雅与近代': '#b06f8f',
    '19世纪学院与浪漫': '#8e7cc3',
    '现实主义与外光': '#4f9d8f'
  };
  let networkBuilt = false;

  function openNetwork() {
    hideToast();
    state.overlay = 'network';
    $('#network').hidden = false;
    renderNetworkSchoolFilters();
    if (!networkBuilt) { buildNetwork(); networkBuilt = true; }
    applyNetworkFilter();
    if (state.networkSelected) selectNetworkArtist(state.networkSelected, false);
  }
  function closeNetwork() {
    $('#network').hidden = true;
    if (state.overlay === 'network') state.overlay = null;
  }

  function renderNetworkSchoolFilters() {
    chipRow($('#networkSchoolFilters'),
      [{ key: 'all', label: '全部流派' }].concat(Object.keys(CLUSTER_COLORS).map(s => ({ key: s, label: s }))),
      state.networkSchool,
      key => { state.networkSchool = key; renderNetworkSchoolFilters(); applyNetworkFilter(); });
  }

  function buildNetwork() {
    const { nodes, edges, width, height } = DATA.graph;
    const byId = new Map((DATA.artists || []).map(a => [a.id, a]));
    const svg = $('#netViewport');
    svg.innerHTML = '';
    const edgeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    edgeLayer.setAttribute('class', 'net-edges');
    const nodeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    nodeLayer.setAttribute('class', 'net-nodes');
    edges.forEach((e, i) => {
      const a = nodes.find(n => n.id === e.a), b = nodes.find(n => n.id === e.b);
      if (!a || !b) return;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
      line.setAttribute('class', 'net-edge');
      line.setAttribute('stroke', REL_COLORS[e.type] || '#8a8270');
      line.dataset.a = e.a; line.dataset.b = e.b; line.dataset.type = e.type;
      line.dataset.i = String(i);
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${byId.get(e.a)?.name} — ${byId.get(e.b)?.name}：${e.type}。${e.note}`;
      line.appendChild(title);
      edgeLayer.appendChild(line);
    });
    // 标签避让：优先下方，碰撞时依次尝试上、右、左、四角
    const geom = nodes.map(n => ({ id: n.id, x: n.x, y: n.y, r: n.r || 15, text: byId.get(n.id)?.short || byId.get(n.id)?.name || '' }));
    const estimateTextW = s => Array.from(s).reduce((w, ch) => w + (/[\u4e00-\u9fa5]/.test(ch) ? 10.5 : 6.2), 0) + 4;
    const labelBox = (n, c, tw) => {
      let left, right;
      if (c.anchor === 'middle') { left = n.x + c.dx - tw / 2; right = n.x + c.dx + tw / 2; }
      else if (c.anchor === 'start') { left = n.x + c.dx; right = left + tw; }
      else { right = n.x + c.dx; left = right - tw; }
      return { left, right, top: n.y + c.dy - 11, bottom: n.y + c.dy + 2 };
    };
    const labelCandidates = r => [
      { dx: 0, dy: r + 14, anchor: 'middle' },
      { dx: 0, dy: -r - 6, anchor: 'middle' },
      { dx: r + 8, dy: 4, anchor: 'start' },
      { dx: -r - 8, dy: 4, anchor: 'end' },
      { dx: r * 0.72, dy: r * 0.72 + 6, anchor: 'start' },
      { dx: -r * 0.72, dy: r * 0.72 + 6, anchor: 'end' },
      { dx: r * 0.72, dy: -r * 0.72 + 2, anchor: 'start' },
      { dx: -r * 0.72, dy: -r * 0.72 + 2, anchor: 'end' },
      { dx: 0, dy: r + 24, anchor: 'middle' },
      { dx: 0, dy: -r - 16, anchor: 'middle' },
      { dx: r + 20, dy: 4, anchor: 'start' },
      { dx: -r - 20, dy: 4, anchor: 'end' },
      { dx: r * 0.95, dy: r * 0.95 + 10, anchor: 'start' },
      { dx: -r * 0.95, dy: r * 0.95 + 10, anchor: 'end' },
      { dx: r * 0.95, dy: -r * 0.95 - 4, anchor: 'start' },
      { dx: -r * 0.95, dy: -r * 0.95 - 4, anchor: 'end' }
    ];
    const labelPos = new Map();
    const placedBoxes = [];
    const isClear = box => {
      if (box.left < 8 || box.right > 1392 || box.top < 8 || box.bottom > 892) return false;
      for (const o of geom) {
        if (o.id === box.id) continue;
        const cx = Math.max(box.left, Math.min(o.x, box.right));
        const cy = Math.max(box.top, Math.min(o.y, box.bottom));
        if (Math.hypot(o.x - cx, o.y - cy) < o.r + 7) return false;
      }
      for (const b of placedBoxes) {
        if (!(box.right <= b.left || box.left >= b.right || box.bottom <= b.top || box.top >= b.bottom)) return false;
      }
      return true;
    };
    geom.slice().sort((a, b) => b.r - a.r).forEach(n => {
      const tw = estimateTextW(n.text);
      const cs = labelCandidates(n.r);
      let chosen = null;
      for (const c of cs) {
        const box = { ...labelBox(n, c, tw), id: n.id };
        if (isClear(box)) { chosen = { ...c, box }; break; }
      }
      // 仍无空位时，沿下/上/右/左逐步外移，直到不压住圆圈
      if (!chosen) {
        for (let step = 1; step <= 8 && !chosen; step++) {
          const tries = [
            { dx: 0, dy: n.r + 14 + step * 8, anchor: 'middle' },
            { dx: 0, dy: -n.r - 6 - step * 8, anchor: 'middle' },
            { dx: n.r + 8 + step * 8, dy: 4, anchor: 'start' },
            { dx: -n.r - 8 - step * 8, dy: 4, anchor: 'end' }
          ];
          for (const c of tries) {
            const box = { ...labelBox(n, c, tw), id: n.id };
            if (isClear(box)) { chosen = { ...c, box }; break; }
          }
        }
      }
      if (!chosen) chosen = { ...cs[0], box: labelBox(n, cs[0], tw) };
      placedBoxes.push(chosen.box);
      labelPos.set(n.id, chosen);
    });
    nodes.forEach(n => {
      const a = byId.get(n.id);
      if (!a) return;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'net-node');
      g.setAttribute('transform', `translate(${n.x},${n.y})`);
      g.dataset.id = n.id;
      g.dataset.cluster = a.cluster;
      const r = n.r || (15 + Math.min(11, (n.degree || 0) * 1.1));
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('r', r);
      circle.setAttribute('fill', CLUSTER_COLORS[a.cluster] || '#c9a45c');
      circle.setAttribute('fill-opacity', '0.9');
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      const lp = labelPos.get(n.id) || { dx: 0, dy: r + 14, anchor: 'middle' };
      label.setAttribute('x', lp.dx);
      label.setAttribute('y', lp.dy);
      label.setAttribute('text-anchor', lp.anchor);
      label.setAttribute('class', 'net-label');
      label.textContent = a.short || a.name;
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${a.name}（${a.life}）· ${a.school}`;
      g.appendChild(circle);
      g.appendChild(label);
      g.appendChild(title);
      g.addEventListener('click', ev => { ev.stopPropagation(); selectNetworkArtist(n.id, true); });
      nodeLayer.appendChild(g);
    });
    svg.appendChild(edgeLayer);
    svg.appendChild(nodeLayer);
    $('#netLegend').innerHTML = Object.entries(REL_COLORS).map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join('');
    applyNetworkView();
  }

  function applyNetworkFilter() {
    const school = state.networkSchool;
    $$('.net-node', $('#netSvg')).forEach(g => {
      g.style.display = (school === 'all' || g.dataset.cluster === school) ? '' : 'none';
    });
    $$('.net-edge', $('#netSvg')).forEach(line => {
      const a = $('.net-node[data-id="' + line.dataset.a + '"]', $('#netSvg'));
      const b = $('.net-node[data-id="' + line.dataset.b + '"]', $('#netSvg'));
      const show = (!a || a.style.display !== 'none') && (!b || b.style.display !== 'none');
      line.style.display = show ? '' : 'none';
    });
  }

  function applyNetworkView() {
    const v = state.networkView;
    $('#netViewport').setAttribute('transform', `translate(${v.x},${v.y}) scale(${v.k})`);
  }

  function selectNetworkArtist(id, scrollInfo) {
    state.networkSelected = id;
    const artist = (DATA.artists || []).find(a => a.id === id);
    if (!artist) return;
    $$('.net-node', $('#netSvg')).forEach(g => g.classList.toggle('selected', g.dataset.id === id));
    $$('.net-edge', $('#netSvg')).forEach(line => {
      const hit = line.dataset.a === id || line.dataset.b === id;
      line.classList.toggle('dim', !hit);
      line.classList.toggle('hot', hit);
    });
    $('#netName').textContent = artist.name;
    $('#netMeta').textContent = `${artist.life} · ${artist.nameEn} · ${artist.school}`;
    $('#netBlurb').textContent = artist.blurb;
    const rels = (DATA.relations || []).filter(r => r.a === id || r.b === id);
    const byId = new Map((DATA.artists || []).map(a => [a.id, a]));
    $('#netRel').innerHTML = rels.length
      ? `<p class="net-sub">关系</p>` + rels.map(r => {
          const other = byId.get(r.a === id ? r.b : r.a);
          return `<button type="button" class="net-rel" data-id="${esc(other.id)}"><b>${esc(r.type)}</b> ${esc(other.name)}<small>${esc(r.note)}</small></button>`;
        }).join('')
      : '<p class="net-sub">关系</p><p class="net-empty">暂无记录。</p>';
    const works = FLAT.filter(f => f.ex.artistId === id);
    $('#netWorks').innerHTML = works.length
      ? `<p class="net-sub">参展作品 ${works.length}</p>` + works.map(f => `<button type="button" class="net-work" data-id="${esc(f.ex.id)}">${esc(f.ex.name)}<small>${esc(f.ex.yearLabel)} · ${esc(f.room.title)}</small></button>`).join('')
      : '<p class="net-sub">参展作品</p><p class="net-empty">本展暂无作品。</p>';
    $$('.net-rel', $('#netRel')).forEach(b => b.addEventListener('click', () => selectNetworkArtist(b.dataset.id, false)));
    $$('.net-work', $('#netWorks')).forEach(b => b.addEventListener('click', () => {
      const f = FLAT.find(x => x.ex.id === b.dataset.id);
      if (f) openDetail(f.ri, f.ei, 0, 'network');
    }));
    if (scrollInfo && window.innerWidth <= 900) $('#networkInfo').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* ---------- 指南 ---------- */
  function renderGuide() {
    const g = DATA.guide || {};
    $('#guideLede').textContent = g.intro || '';
    $('#guideControls').innerHTML = (g.controls || []).map(([t, p]) => `<div class="guide-item"><b>${esc(t)}</b><p>${esc(p)}</p></div>`).join('');
    $('#guideSections').innerHTML = (g.sections || []).map(sec => `
      <section class="guide-section">
        <h3>${esc(sec.title)}</h3>
        ${(sec.paras || []).map(p => `<p>${esc(p)}</p>`).join('')}
        ${(sec.list || []).length ? `<div class="guide-list">${sec.list.map(p => `<p>${esc(p)}</p>`).join('')}</div>` : ''}
        ${sec.note ? `<p class="guide-subnote">${esc(sec.note)}</p>` : ''}
      </section>`).join('');
    $('#guideNote').textContent = g.note || '';
  }

  function openGuide() {
    hideToast();
    state.overlay = 'guide';
    $('#guide').hidden = false;
    renderGuide();
  }
  function closeGuide() {
    $('#guide').hidden = true;
    if (state.overlay === 'guide') state.overlay = null;
  }

  /* ---------- 首页 / 进入 ---------- */
  function startGallery() {
    state.started = true;
    $('#intro').hidden = true;
    $('#gallery').hidden = false;
    $('#loadingMask').classList.add('hide');
  }

  function backHome() {
    state.detailFrom = null;
    closeDetail();
    closeCatalog();
    closeTimeline();
    closeNetwork();
    closeGuide();
    $('#gallery').hidden = true;
    $('#intro').hidden = false;
    state.started = false;
    state.roomIndex = 0;
    state.overlay = null;
  }

  /* ---------- 通用 ---------- */
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    $('#toast').classList.remove('show');
  }

  function anyOverlay() {
    return !$('#threshold').hidden || !$('#detail').hidden || !$('#catalog').hidden ||
      !$('#timeline').hidden || !$('#network').hidden || !$('#guide').hidden || !$('#tagWiki').hidden;
  }

  /* ---------- 事件 ---------- */
  function bindEvents() {
    // 入口
    $('#enterBtn').addEventListener('click', () => { startGallery(); enterRoom(0, true, 'start'); });
    $('#introCatalogBtn').addEventListener('click', openCatalog);
    $('#introTimelineBtn').addEventListener('click', openTimeline);
    $('#introNetworkBtn').addEventListener('click', openNetwork);
    $('#introGuideBtn').addEventListener('click', openGuide);
    $('#introMusicBtn').addEventListener('click', toggleMusic);
    $('#galleryMusicBtn').addEventListener('click', toggleMusic);

    // 展厅顶栏
    $('#backHomeBtn').addEventListener('click', backHome);
    $('#openCatalogBtn').addEventListener('click', openCatalog);
    $('#openTimelineBtn').addEventListener('click', openTimeline);
    $('#openNetworkBtn').addEventListener('click', openNetwork);
    $('#openGuideBtn').addEventListener('click', openGuide);

    // 门槛
    $('#thresholdEnterBtn').addEventListener('click', skipThreshold);
    $('#threshold').addEventListener('click', e => { if (e.target === $('#threshold')) skipThreshold(); });

    // 展厅移动
    $('#prevBtn').addEventListener('click', () => step(-1));
    $('#nextBtn').addEventListener('click', () => step(1));
    $('#wallViewport').addEventListener('wheel', e => {
      if (anyOverlay()) return;
      e.preventDefault();
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      setPanTarget(state.targetPan + delta * 1.05);
      $('#panHint').classList.add('hide');
    }, { passive: false });

    // 拖拽
    const vp = $('#wallViewport');
    vp.addEventListener('pointerdown', e => {
      if (e.button !== 0 || anyOverlay()) return;
      state.dragging = true;
      state.dragMoved = false;
      state.dragStartX = e.clientX;
      state.dragStartPan = state.panX;
      state.dragLastX = e.clientX;
      state.dragLastT = performance.now();
      state.dragVelocity = 0;
      if (state.panRaf) { cancelAnimationFrame(state.panRaf); state.panRaf = 0; }
      vp.classList.add('dragging');
    });
    vp.addEventListener('pointermove', e => {
      if (!state.dragging) return;
      const dx = e.clientX - state.dragStartX;
      if (Math.abs(dx) > 6) {
        state.dragMoved = true;
        $('#panHint').classList.add('hide');
      }
      const now = performance.now();
      const dt = Math.max(1, now - state.dragLastT);
      state.dragVelocity = (e.clientX - state.dragLastX) / dt;
      state.dragLastX = e.clientX;
      state.dragLastT = now;
      applyPanInstant(state.dragStartPan - dx);
    });
    const scheduleDock = () => {
      if (state.depthRaf) return;
      state.depthRaf = requestAnimationFrame(() => {
        state.depthRaf = 0;
        updateDepth();
      });
    };
    vp.addEventListener('pointermove', e => {
      if (state.dragging || e.pointerType === 'touch') return;
      state.pointerX = e.clientX;
      scheduleDock();
    });
    vp.addEventListener('pointerleave', () => {
      state.pointerX = null;
      scheduleDock();
    });
    const endDrag = () => {
      if (!state.dragging) return;
      state.dragging = false;
      vp.classList.remove('dragging');
      if (state.dragMoved) {
        const momentum = clamp(-state.dragVelocity * 160, -520, 520);
        if (Math.abs(momentum) > 40) setPanTarget(state.panX + momentum);
      }
    };
    vp.addEventListener('pointerup', endDrag);
    vp.addEventListener('pointercancel', endDrag);
    vp.addEventListener('pointerleave', endDrag);
    vp.addEventListener('click', e => {
      if (state.dragMoved) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    // 详情
    $('#detailCloseBtn').addEventListener('click', closeDetail);
    $('#detailPrevBtn').addEventListener('click', () => stepDetail(-1));
    $('#detailNextBtn').addEventListener('click', () => stepDetail(1));
    $('#detailTags').addEventListener('click', e => {
      const chip = e.target.closest('.tag-chip');
      if (chip) openTagWiki(chip.dataset.tag, chip.dataset.kind);
    });
    $('#twCloseBtn').addEventListener('click', closeTagWiki);
    $('#tagWiki').addEventListener('click', e => { if (e.target === $('#tagWiki')) closeTagWiki(); });
    const artistBtn = $('#detailArtist');
    const openArtistFromDetail = () => {
      const id = artistBtn.dataset.artistId;
      if (id) openArtistWiki(id);
    };
    artistBtn.addEventListener('click', openArtistFromDetail);
    artistBtn.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openArtistFromDetail();
      }
    });
    $('#awCloseBtn').addEventListener('click', closeArtistWiki);
    $('#artistWiki').addEventListener('click', e => { if (e.target === $('#artistWiki')) closeArtistWiki(); });
    $('#zoomInBtn').addEventListener('click', () => zoomViewer(1.25));
    $('#zoomOutBtn').addEventListener('click', () => zoomViewer(0.8));
    $('#zoomResetBtn').addEventListener('click', () => fitViewer('all'));
    $('#viewerOpenBtn').addEventListener('click', downloadWatermarked);
    $('#viewerFullBtn').addEventListener('click', () => setViewerFullscreen(!state.viewer.fullscreen));
    $('#viewerExitBtn').addEventListener('click', () => setViewerFullscreen(false));

    const stage = $('#viewerStage');
    stage.addEventListener('wheel', e => {
      e.preventDefault();
      const v = state.viewer;
      if (e.ctrlKey || e.metaKey) {
        zoomViewer(e.deltaY < 0 ? 1.18 : 0.85);
        return;
      }
      if (v.rotated || v.visualW > v.visualH * 3) {
        const dir = v.rotated ? 1 : -1;
        v.x += dir * (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * 1.2;
        clampViewer();
        applyViewer();
      } else if (v.visualH > v.visualW * 1.6) {
        v.y -= e.deltaY * 1.2;
        clampViewer();
        applyViewer();
      } else {
        zoomViewer(e.deltaY < 0 ? 1.18 : 0.85);
      }
    }, { passive: false });
    stage.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const v = state.viewer;
      v.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (v.pointers.size === 2) {
        const pts = [...v.pointers.values()];
        v.pinch = {
          dist: Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
          scale: v.scale
        };
        v.dragging = false;
        stage.classList.remove('dragging');
        return;
      }
      v.dragging = true;
      v.startX = e.clientX;
      v.startY = e.clientY;
      v.origX = v.x;
      v.origY = v.y;
      stage.classList.add('dragging');
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    stage.addEventListener('pointermove', e => {
      const v = state.viewer;
      if (v.pointers.has(e.pointerId)) {
        v.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (v.pinch && v.pointers.size >= 2) {
        const pts = [...v.pointers.values()];
        const dist = Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
        v.scale = clamp(v.pinch.scale * (dist / v.pinch.dist), 1, 12);
        clampViewer();
        applyViewer();
        return;
      }
      if (!v.dragging) return;
      v.x = v.origX + (e.clientX - v.startX);
      v.y = v.origY + (e.clientY - v.startY);
      clampViewer();
      applyViewer();
    });
    const endViewerPointer = e => {
      const v = state.viewer;
      v.pointers.delete(e.pointerId);
      if (v.pointers.size < 2) v.pinch = null;
      if (v.pointers.size === 1) {
        const p = [...v.pointers.values()][0];
        v.startX = p.x;
        v.startY = p.y;
        v.origX = v.x;
        v.origY = v.y;
        v.dragging = true;
      } else if (v.pointers.size === 0) {
        v.dragging = false;
        stage.classList.remove('dragging');
      }
    };
    stage.addEventListener('pointerup', endViewerPointer);
    stage.addEventListener('pointercancel', endViewerPointer);
    stage.addEventListener('pointerleave', endViewerPointer);
    stage.addEventListener('dblclick', () => {
      if (state.viewer.scale > 1.2) {
        fitViewer(initialViewerMode());
      } else {
        zoomViewer(3);
        clampViewer();
        applyViewer();
      }
    });

    // 目录
    $('#catalogCloseBtn').addEventListener('click', closeCatalog);
    $('#catalogSearch').addEventListener('input', e => {
      state.catalogQuery = e.target.value;
      renderCatalog();
      $('#catalog').scrollTop = 0;
    });
    $('#catalogResetBtn').addEventListener('click', () => {
      state.catalogFilter = 'all';
      state.catalogSchool = 'all';
      state.catalogArtist = 'all';
      state.catalogQuery = '';
      $('#catalogSearch').value = '';
      $('#catalogArtistSelect').value = 'all';
      renderCatalogFilters();
      renderCatalog();
    });
    const openCatalogCard = (card, animate) => {
      if (!card || card.dataset.opening === '1') return;
      const item = FLAT.find(f => f.ex.id === card.dataset.id);
      if (!item) return;
      card.dataset.opening = '1';
      if (animate) card.classList.add('tap-pop');
      setTimeout(() => {
        delete card.dataset.opening;
        closeCatalog();
        startGallery();
        enterRoom(item.ri, false, 'start');
        openDetail(item.ri, item.ei, 0, 'catalog');
      }, animate ? 240 : 0);
      if (animate) setTimeout(() => card.classList.remove('tap-pop'), 520);
    };
    $('#catalogGrid').addEventListener('click', e => openCatalogCard(e.target.closest('.cat-card'), true));
    $('#catalogGrid').addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest('.cat-card');
      if (!card) return;
      e.preventDefault();
      openCatalogCard(card, false);
    });

    // 时间轴
    $('#timelineCloseBtn').addEventListener('click', closeTimeline);
    $('#timelineResetBtn').addEventListener('click', () => {
      state.timelineSchool = 'all';
      renderTimelineSchoolFilters();
      applyTimelineFilter();
      applyTimelineZoom(1);
      const sc = $('#tlScroll');
      if (sc) sc.scrollLeft = 0;
    });
    bindTimelineDrag();
    bindTimelineZoom();

    // 关系图
    $('#networkCloseBtn').addEventListener('click', closeNetwork);
    $('#networkResetBtn').addEventListener('click', () => {
      state.networkView = { x: 0, y: 0, k: 1, dragging: false, startX: 0, startY: 0, origX: 0, origY: 0 };
      applyNetworkView();
      state.networkSelected = null;
      $$('.net-node.selected', $('#netSvg')).forEach(g => g.classList.remove('selected'));
      $$('.net-edge', $('#netSvg')).forEach(l => l.classList.remove('dim', 'hot'));
      $('#netName').textContent = '点击节点查看';
      $('#netMeta').textContent = '';
      $('#netBlurb').textContent = '';
      $('#netRel').innerHTML = '';
      $('#netWorks').innerHTML = '';
    });
    const netStage = $('#networkStage');
    netStage.addEventListener('pointerdown', e => {
      if (e.target.closest('.net-node')) return;
      const v = state.networkView;
      v.dragging = true;
      v.startX = e.clientX;
      v.startY = e.clientY;
      v.origX = v.x;
      v.origY = v.y;
      netStage.classList.add('dragging');
      try { netStage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    netStage.addEventListener('pointermove', e => {
      const v = state.networkView;
      if (!v.dragging) return;
      v.x = v.origX + (e.clientX - v.startX);
      v.y = v.origY + (e.clientY - v.startY);
      applyNetworkView();
    });
    const endNetDrag = () => {
      state.networkView.dragging = false;
      netStage.classList.remove('dragging');
    };
    netStage.addEventListener('pointerup', endNetDrag);
    netStage.addEventListener('pointercancel', endNetDrag);
    netStage.addEventListener('pointerleave', endNetDrag);
    netStage.addEventListener('wheel', e => {
      e.preventDefault();
      const v = state.networkView;
      const factor = e.deltaY < 0 ? 1.12 : 0.9;
      v.k = clamp(v.k * factor, 0.5, 3.2);
      applyNetworkView();
    }, { passive: false });

    // 指南
    $('#guideCloseBtn').addEventListener('click', closeGuide);

    // 键盘
    window.addEventListener('keydown', e => {
      if (!$('#artistWiki').hidden) {
        if (e.key === 'Escape') closeArtistWiki();
        return;
      }
      if (!$('#tagWiki').hidden) {
        if (e.key === 'Escape') closeTagWiki();
        return;
      }
      if (e.key === 'Escape') {
        if (state.overlay === 'detail') {
          if (state.viewer.fullscreen) { setViewerFullscreen(false); return; }
          closeDetail();
          return;
        }
        if (state.overlay === 'catalog') { closeCatalog(); return; }
        if (state.overlay === 'timeline') { closeTimeline(); return; }
        if (state.overlay === 'network') { closeNetwork(); return; }
        if (state.overlay === 'guide') { closeGuide(); return; }
        if (state.overlay === 'threshold') { skipThreshold(); return; }
        return;
      }
      if (state.overlay === 'detail') {
        if (e.key === 'ArrowLeft') { e.preventDefault(); stepDetail(-1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); stepDetail(1); }
        return;
      }
      if (anyOverlay()) return;
      if (!state.started || $('#gallery').hidden) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      if (e.key === 'Home') { e.preventDefault(); setPanTarget(0); }
      if (e.key === 'End') { e.preventDefault(); setPanTarget(state.wallMax); }
    });

    // 窗口尺寸
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.started && !$('#gallery').hidden) {
          const ratio = state.wallMax ? state.panX / state.wallMax : 0;
          renderWall(state.roomIndex);
          requestAnimationFrame(() => {
            measureWall();
            applyPanInstant(ratio * state.wallMax);
          });
        }
        if (state.overlay === 'detail' && state.detail) {
          const ex = DATA.rooms[state.detail.ri].exhibits[state.detail.ei];
          renderViewer(ex, state.detail.imgIndex);
        }
        if (state.overlay === 'timeline') {
          TL_STATE.built = false;
          buildTimeline();
        }
      }, 220);
    });
  }

  /* ---------- 启动 ---------- */
  function hideLoading() {
    if (loadingDone) return;
    loadingDone = true;
    $('#loadingMask').classList.add('hide');
  }

  function boot() {
    loadVisited();
    loadMusicPref();
    initIntro();
    renderRoutes();
    updateProgress();
    updateRoute();
    bindEvents();
    document.addEventListener('pointerdown', e => {
      if (music.on && !music.started && !e.target.closest('.music-btn')) startMusic();
    }, { once: true, capture: true });

    const first = DATA.rooms[0].exhibits.map(ex => ex.hero.src);
    let loaded = 0;
    if (!first.length) hideLoading();
    first.forEach(src => {
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      const done = () => { loaded += 1; if (loaded >= first.length) hideLoading(); };
      img.onload = done;
      img.onerror = done;
      img.src = src;
    });
    setTimeout(hideLoading, 3200);
  }

  boot();
})();
