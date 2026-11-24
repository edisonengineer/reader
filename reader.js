/* =========================================================================
   The Registry · private reader
   - book.enc holds the whole novel, encrypted (AES-GCM, key from your password).
     Nothing readable is on the website without the password.
   - Progress, bookmarks and settings stay in this browser (localStorage).
   - A page counts as read after you have had it open for a while (READ_SECONDS).
     Each newly read page is sent, with its summary, to your Google Sheet, which
     emails you the summaries 2 hours after you stop reading.
   ========================================================================= */
(function () {
    'use strict';

    const READ_SECONDS = 20;          // time on a page before it counts as read
    const STORE = 'registry.reader.v1';
    const KEY_STORE = 'registry.reader.key';
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => Array.from(document.querySelectorAll(s));

    /* ---------- saved state ---------- */
    const state = Object.assign({
        pos: 0, read: {}, bookmarks: [], queue: [],
        size: 100, theme: 'paper', font: 'serif', endpoint: '', lastSent: 0
    }, safeParse(localStorage.getItem(STORE)));
    function save() { localStorage.setItem(STORE, JSON.stringify(state)); }
    function safeParse(s) { try { return JSON.parse(s) || {}; } catch (e) { return {}; } }

    let BOOK = null, PAGES = [], SUM = {}, CFG = {};

    /* ---------- crypto ---------- */
    const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const toB64 = (buf) => btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));

    async function deriveRaw(password, salt, iter) {
        const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
        return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, 256);
    }
    async function decrypt(pack, raw) {
        const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(pack.iv) }, key, b64(pack.data));
        const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
        return JSON.parse(await new Response(stream).text());
    }
    let PACK = null;
    async function loadPack() {
        if (!PACK) {
            const r = await fetch('book.enc?v=' + Date.now().toString().slice(0, 7), { cache: 'no-cache' });
            if (!r.ok) throw new Error('The book file did not load (' + r.status + ').');
            PACK = await r.json();
        }
        return PACK;
    }
    async function unlock(password, remember) {
        const pack = await loadPack();
        const raw = await deriveRaw(password, b64(pack.salt), pack.iter);
        const data = await decrypt(pack, raw);          // throws on a wrong password
        if (remember) localStorage.setItem(KEY_STORE, pack.salt + ':' + toB64(raw));
        else sessionStorage.setItem(KEY_STORE, pack.salt + ':' + toB64(raw));
        return data;
    }
    async function unlockSaved() {
        const saved = localStorage.getItem(KEY_STORE) || sessionStorage.getItem(KEY_STORE);
        if (!saved) return null;
        const pack = await loadPack();
        const [salt, raw] = saved.split(':');
        if (salt !== pack.salt) return null;              // the book was re-encrypted with a new password
        try { return await decrypt(pack, b64(raw)); } catch (e) { return null; }
    }

    /* ---------- book ---------- */
    function setBook(data) {
        BOOK = data.book; SUM = data.summaries || {}; CFG = data.config || {};
        PAGES = [];
        BOOK.sections.forEach((s, si) => s.pages.forEach((p, pi) => {
            s.start = s.start === undefined ? PAGES.length : s.start;
            PAGES.push({ id: p.id, html: p.html, words: p.words, sec: s, si, pi });
        }));
        if (state.pos >= PAGES.length) state.pos = 0;
    }
    const readCount = () => PAGES.filter((p) => state.read[p.id]).length;
    const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
    function minutesLeft(from) {
        let w = 0;
        for (let i = from; i < PAGES.length; i++) w += PAGES[i].words;
        return Math.round(w / 230);
    }
    const hm = (min) => (min >= 60 ? Math.floor(min / 60) + ' h ' + (min % 60) + ' min' : min + ' min');

    /* ---------- views ---------- */
    function show(id) {
        $$('.view').forEach((v) => { v.hidden = v.id !== id; });
        document.body.dataset.view = id;
        if (id !== 'reader') stopTimer();
        window.scrollTo(0, 0);
    }

    function renderHome() {
        const n = readCount();
        $('#home-progress-bar').style.width = pct(n, PAGES.length) + '%';
        $('#home-stats').textContent = n
            ? n + ' of ' + PAGES.length + ' pages read (' + pct(n, PAGES.length) + '%) · about ' + hm(minutesLeft(state.pos)) + ' left'
            : PAGES.length + ' pages · about ' + hm(minutesLeft(0)) + ' of reading';
        $('#continue-btn').textContent = state.pos > 0 || n ? 'Continue: ' + PAGES[state.pos].sec.label + ', page ' + (PAGES[state.pos].pi + 1) : 'Start reading';
        $('#recap-btn').hidden = !n;

        let html = '', act = -1;
        BOOK.sections.forEach((s) => {
            if (s.kind === 'act') {
                if (act !== -1) html += '</ol>';
                act = s.act;
                html += '<h2 class="toc-act"><button type="button" data-goto="' + s.start + '">' + esc(s.label) + ' · ' + esc(s.title) + '</button></h2><ol class="toc-list">';
                return;
            }
            const done = s.pages.filter((p) => state.read[p.id]).length;
            const cls = done === s.pages.length ? 'done' : done ? 'part' : '';
            html += '<li class="' + cls + '"><button type="button" data-goto="' + s.start + '"><span class="toc-num">' + s.num + '</span><span class="toc-title">' + esc(s.title) + '</span><span class="toc-pages">' + (done ? done + '/' : '') + s.pages.length + ' pp</span></button></li>';
        });
        $('#toc').innerHTML = html + '</ol>';

        const bm = state.bookmarks.filter((id) => PAGES.some((p) => p.id === id));
        $('#bookmarks-wrap').hidden = !bm.length;
        $('#bookmarks').innerHTML = bm.map((id) => {
            const i = PAGES.findIndex((p) => p.id === id);
            const p = PAGES[i];
            return '<li><button type="button" data-goto="' + i + '">' + esc(p.sec.label) + ', page ' + (p.pi + 1) + ' <span>' + esc(p.sec.title) + '</span></button></li>';
        }).join('');
    }

    function renderPage(i, dir) {
        i = Math.max(0, Math.min(PAGES.length - 1, i));
        state.pos = i; save();
        const p = PAGES[i], s = p.sec;
        let head = '';
        if (p.pi === 0) {
            head = s.kind === 'act'
                ? '<header class="act-head"><p class="kicker">' + esc(s.label) + '</p><h1>' + esc(s.title) + '</h1></header>'
                : '<header class="ch-head"><p class="kicker">Chapter ' + s.num + '</p><h1>' + esc(s.title) + '</h1></header>';
        }
        const page = $('#page');
        page.className = 'page' + (p.pi === 0 ? ' first' : '') + (s.kind === 'act' ? ' act' : '') + (dir ? ' turn-' + dir : '');
        page.innerHTML = head + '<div class="text">' + p.html + '</div>' +
            (i === PAGES.length - 1 ? '<p class="the-end">The End</p>' : '');
        $('#bar-title').textContent = s.kind === 'act' ? s.label : s.label + ' · ' + s.title;
        $('#page-num').textContent = s.kind === 'act' ? s.label : 'Page ' + (p.pi + 1) + ' of ' + s.pages.length;
        $('#page-progress-bar').style.width = pct(i + 1, PAGES.length) + '%';
        $('#prev').disabled = i === 0;
        $('#next').disabled = i === PAGES.length - 1;
        const marked = state.bookmarks.includes(p.id);
        $('#bookmark-btn').innerHTML = marked ? '&#9733;' : '&#9734;';
        $('#bookmark-btn').setAttribute('aria-pressed', String(marked));
        $('#read-dot').classList.toggle('on', !!state.read[p.id]);
        history.replaceState(null, '', '#' + p.id);
        lastActive = Date.now();
        window.scrollTo(0, 0);
        page.focus({ preventScroll: true });
        startTimer();
    }

    function openReader(i) { show('reader'); renderPage(i === undefined ? state.pos : i); }
    const next = () => { if (state.pos < PAGES.length - 1) renderPage(state.pos + 1, 'next'); };
    const prev = () => { if (state.pos > 0) renderPage(state.pos - 1, 'prev'); };

    function renderRecap() {
        let html = '', any = false;
        BOOK.sections.forEach((s) => {
            const items = s.pages.filter((p) => state.read[p.id] && SUM[p.id]);
            if (!items.length) return;
            any = true;
            html += '<section><h2>' + esc(s.label) + (s.kind === 'chapter' ? ': ' + esc(s.title) : ' · ' + esc(s.title)) + '</h2><ol>' +
                items.map((p) => '<li><button type="button" class="recap-page" data-goto="' + PAGES.findIndex((x) => x.id === p.id) + '">p. ' + (s.pages.indexOf(p) + 1) + '</button> ' + esc(SUM[p.id]) + '</li>').join('') +
                '</ol></section>';
        });
        $('#recap-body').innerHTML = any ? html : '<p class="hint">Summaries appear here as you read.</p>';
    }

    /* ---------- reading time and "read" pages ---------- */
    let timer = null, onPage = 0;
    function startTimer() {
        stopTimer();
        onPage = 0;
        const p = PAGES[state.pos];
        const need = p.words < 60 ? 3 : READ_SECONDS;
        if (state.read[p.id]) return;
        timer = setInterval(() => {
            if (document.hidden) return;
            onPage += 1;
            if (onPage >= need) { stopTimer(); markRead(p); }
        }, 1000);
    }
    function stopTimer() { if (timer) clearInterval(timer); timer = null; }

    function markRead(p) {
        if (state.read[p.id]) return;
        state.read[p.id] = Date.now();
        readThisVisit = true;
        $('#read-dot').classList.add('on');
        state.queue.push({
            t: new Date().toISOString(), id: p.id, n: PAGES.indexOf(p) + 1,
            label: p.sec.label, title: p.sec.title, page: p.pi + 1, of: p.sec.pages.length,
            summary: SUM[p.id] || ''
        });
        save();
        flush();
    }

    /* ---------- Google Sheet ---------- */
    let sending = false;
    async function post(body) {
        // text/plain + no-cors: Apps Script accepts it without a CORS preflight
        await fetch(state.endpoint, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
    }
    async function flush() {
        updateQueueStatus();
        if (sending || !state.endpoint || !state.queue.length || !navigator.onLine) return;
        sending = true;
        const batch = state.queue.slice(0, 40);
        try {
            await post({ token: CFG.token, type: 'read', events: batch, url: location.href.split('#')[0] });
            state.queue = state.queue.slice(batch.length);
            state.lastSent = Date.now();
            save();
        } catch (e) { /* offline or blocked: kept for the next try */ }
        sending = false;
        updateQueueStatus();
        if (state.queue.length) setTimeout(flush, 15000);
    }
    function updateQueueStatus() {
        const el = $('#queue-status');
        if (!el) return;
        el.textContent = !state.endpoint ? 'Not connected yet: read pages are saved and will be sent once you add the URL.'
            : state.queue.length ? state.queue.length + ' read page(s) waiting to be sent.'
            : state.lastSent ? 'All read pages sent (last ' + new Date(state.lastSent).toLocaleString() + ').' : 'Connected.';
    }
    // "Still reading": when you leave the reader, tell the sheet when you last turned or scrolled a page,
    // so the 2 hours count from when you actually stopped, not from the last page counted as read.
    let lastActive = 0, readThisVisit = false;
    const touch = () => { lastActive = Date.now(); };
    window.addEventListener('scroll', touch, { passive: true });
    function sendActive() {
        if (!state.endpoint || !readThisVisit || !lastActive) return;
        const body = JSON.stringify({ token: CFG.token, type: 'active', t: new Date(lastActive).toISOString() });
        if (!(navigator.sendBeacon && navigator.sendBeacon(state.endpoint, new Blob([body], { type: 'text/plain' })))) {
            fetch(state.endpoint, { method: 'POST', mode: 'no-cors', keepalive: true, headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body }).catch(() => {});
        }
    }
    window.addEventListener('online', flush);
    document.addEventListener('visibilitychange', () => { if (document.hidden) { flush(); sendActive(); } });
    window.addEventListener('pagehide', sendActive);

    /* ---------- settings ---------- */
    function applySettings() {
        document.body.dataset.theme = state.theme;
        document.body.dataset.font = state.font;
        document.documentElement.style.setProperty('--size', (state.size / 100) * 1.22 + 'rem');
        $('#size-out').textContent = state.size + '%';
        $$('[data-theme-set]').forEach((b) => b.classList.toggle('on', b.dataset.themeSet === state.theme));
        $$('[data-font-set]').forEach((b) => b.classList.toggle('on', b.dataset.fontSet === state.font));
        const meta = document.querySelector('meta[name="theme-color"]');
        meta.content = { paper: '#f6f1e7', sepia: '#efe3c8', night: '#16181d' }[state.theme];
    }

    function toast(msg) {
        const t = $('#toast');
        t.textContent = msg; t.hidden = false;
        clearTimeout(toast.t);
        toast.t = setTimeout(() => { t.hidden = true; }, 3200);
    }
    function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    /* ---------- events ---------- */
    function wire() {
        document.addEventListener('click', (e) => {
            const g = e.target.closest('[data-goto]');
            if (g) { openReader(Number(g.dataset.goto)); return; }
            const o = e.target.closest('[data-open]');
            if (o) { $('#' + o.dataset.open).showModal(); updateQueueStatus(); return; }
            const sz = e.target.closest('[data-size]');
            if (sz) { state.size = Math.max(80, Math.min(160, state.size + Number(sz.dataset.size) * 10)); save(); applySettings(); return; }
            const th = e.target.closest('[data-theme-set]');
            if (th) { state.theme = th.dataset.themeSet; save(); applySettings(); return; }
            const f = e.target.closest('[data-font-set]');
            if (f) { state.font = f.dataset.fontSet; save(); applySettings(); }
        });
        $('#continue-btn').addEventListener('click', () => openReader());
        $('#to-home').addEventListener('click', () => { renderHome(); show('home'); history.replaceState(null, '', '#'); });
        $('#next').addEventListener('click', next);
        $('#prev').addEventListener('click', prev);
        $('#recap-btn').addEventListener('click', () => { renderRecap(); show('recap'); });
        $('#recap-back').addEventListener('click', () => { renderHome(); show('home'); });
        $('#bookmark-btn').addEventListener('click', () => {
            const id = PAGES[state.pos].id;
            const i = state.bookmarks.indexOf(id);
            if (i > -1) state.bookmarks.splice(i, 1); else state.bookmarks.push(id);
            save(); renderPage(state.pos);
            toast(i > -1 ? 'Bookmark removed' : 'Bookmarked');
        });
        document.addEventListener('keydown', (e) => {
            if (document.body.dataset.view !== 'reader' || e.target.closest('input, dialog')) return;
            if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && atBottom())) { e.preventDefault(); next(); }
            if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); prev(); }
        });
        // Swipe left / right on phones
        let sx = 0, sy = 0, st = 0;
        $('#page').addEventListener('touchstart', (e) => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; st = Date.now(); }, { passive: true });
        $('#page').addEventListener('touchend', (e) => {
            const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
            if (Date.now() - st < 700 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) { dx < 0 ? next() : prev(); }
        }, { passive: true });

        $('#endpoint').value = state.endpoint;
        $('#endpoint-save').addEventListener('click', () => {
            const v = $('#endpoint').value.trim();
            if (v && !/^https:\/\/script\.google(usercontent)?\.com\/.+\/exec$/.test(v)) { $('#endpoint-status').textContent = 'That doesn\'t look like a Web app URL: it should start with https://script.google.com/ and end in /exec.'; return; }
            state.endpoint = v; save();
            $('#endpoint-status').textContent = v ? 'Saved. Read pages will be sent to your sheet.' : 'Removed.';
            flush();
        });
        $('#endpoint-test').addEventListener('click', async () => {
            if (!state.endpoint) { $('#endpoint-status').textContent = 'Save the URL first.'; return; }
            try {
                await post({ token: CFG.token, type: 'test', url: location.href.split('#')[0] });
                $('#endpoint-status').textContent = 'Test sent. Check your email in a minute: the sheet sends a short "connected" message.';
            } catch (e) { $('#endpoint-status').textContent = 'Could not reach the sheet. Check the URL and your connection.'; }
        });
        $('#lock-now').addEventListener('click', () => {
            localStorage.removeItem(KEY_STORE); sessionStorage.removeItem(KEY_STORE);
            location.hash = ''; location.reload();
        });
        $('#reset-progress').addEventListener('click', () => {
            if (!confirm('Forget which pages you have read, your place and your bookmarks on this device?')) return;
            state.read = {}; state.pos = 0; state.bookmarks = []; state.queue = []; save();
            $('#settings').close(); renderHome(); show('home');
        });
        window.addEventListener('pagehide', flush);
    }
    function atBottom() { return window.innerHeight + window.scrollY >= document.body.scrollHeight - 4; }

    function start(data) {
        setBook(data);
        wire();
        applySettings();
        const id = decodeURIComponent(location.hash.slice(1));
        const i = PAGES.findIndex((p) => p.id === id);
        if (i > -1) openReader(i);
        else if (id === 'continue') openReader();
        else { renderHome(); show('home'); }
        flush();
    }

    /* ---------- boot ---------- */
    applySettings();
    $('#lock-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('#unlock-btn'), err = $('#lock-error');
        btn.disabled = true; btn.textContent = 'Opening…'; err.hidden = true;
        try {
            start(await unlock($('#pw').value, $('#remember').checked));
        } catch (ex) {
            err.textContent = /did not load/.test(ex.message) ? ex.message : 'That password didn\'t open the book. Try again.';
            err.hidden = false;
        }
        btn.disabled = false; btn.textContent = 'Open the book';
    });
    if (!window.crypto || !crypto.subtle || typeof DecompressionStream === 'undefined') {
        $('#lock-error').textContent = 'This browser is too old to open the book. Use a recent Chrome, Safari, Edge or Firefox.';
        $('#lock-error').hidden = false;
    }
    unlockSaved().then((data) => { if (data) start(data); else $('#pw').focus(); }).catch(() => {});
})();
