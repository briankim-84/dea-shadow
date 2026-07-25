/*! DEWB Shadow — sync.js v1.0 (2026-07)
 *  학생코드 기반 진도 동기화 (Auth 없음 / Firestore compat SDK)
 *  - 게이트(공용 비번) → 학생코드 입력 → progress/<code> 문서와 합집합 동기화
 *  - 대상 키: IndexedDB `prog|<sceneId>`, `keep|<sceneId>`
 *  - 녹음(rec|...)은 동기화하지 않음 (로컬 전용)
 *
 *  설치: 각 앱/허브 index.html 의 </body> 직전, 기존 인라인 <script> 뒤에
 *        <script src="../sync.js"></script>   (허브는 <script src="sync.js"></script>)
 */
(function () {
  'use strict';
  if (window.DEWBSync) return;

  /* ─────────────────────────── 설정 ─────────────────────────── */
  var CFG = {
    apiKey: "AIzaSyD5kLt6W6MJ9MCwYEv0zQtxxxuOKxzOfUU",
    authDomain: "dewb-shadow.firebaseapp.com",
    projectId: "dewb-shadow",
    storageBucket: "dewb-shadow.firebasestorage.app",
    messagingSenderId: "363536062096",
    appId: "1:363536062096:web:85eb34a42e6c4fd1edaa15"
  };
  var GATE_PW = 'shadow1234';           // 공용 게이트 비번 (대소문자 무관)
  var SDK = 'https://www.gstatic.com/firebasejs/10.12.5/';
  var DEBOUNCE = 1500;                  // 업로드 디바운스 (ms)

  var K_GATE = 'ls_gate', K_STUDENT = 'ls_student', K_MIGRATED = 'ls_migrated',
      K_SKIP = 'ls_local_only';

  /* ─────────────────────────── 유틸 ─────────────────────────── */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function log() { if (window.DEWB_SYNC_DEBUG) console.log.apply(console, ['[sync]'].concat([].slice.call(arguments))); }

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = res; s.onerror = function () { rej(new Error('load fail: ' + src)); };
      document.head.appendChild(s);
    });
  }

  /* ───────────────────── 로컬 KV (앱 엔진과 동일) ───────────────────── */
  var DBN = 'dewb_shadow_app', ST = 'kv';
  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DBN, 1);
      r.onupgradeneeded = function () { if (!r.result.objectStoreNames.contains(ST)) r.result.createObjectStore(ST); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function rawGet(k) {
    return idb().then(function (d) {
      return new Promise(function (r) {
        var q = d.transaction(ST, 'readonly').objectStore(ST).get(k);
        q.onsuccess = function () { r(q.result == null ? null : q.result); };
        q.onerror = function () { r(null); };
      });
    }).catch(function () { return null; });
  }
  function rawSet(k, v) {
    return idb().then(function (d) {
      return new Promise(function (r) {
        var t = d.transaction(ST, 'readwrite');
        t.objectStore(ST).put(v, k);
        t.oncomplete = function () { r(1); }; t.onerror = function () { r(0); };
      });
    }).catch(function () { return 0; });
  }
  function rawKeys() {
    return idb().then(function (d) {
      return new Promise(function (r) {
        var q = d.transaction(ST, 'readonly').objectStore(ST).getAllKeys();
        q.onsuccess = function () { r(q.result || []); };
        q.onerror = function () { r([]); };
      });
    }).catch(function () { return []; });
  }

  /* ───────────────────────── 상태 ───────────────────────── */
  var state = {
    ready: false,        // 게이트 통과 + 코드 판정 완료
    linked: false,       // 클라우드 연결됨
    code: null,
    name: null,
    db: null,
    dirty: {},           // { key: true }
    timer: null,
    booting: false
  };

  /* ───────────────────────── 오버레이 UI ───────────────────────── */
  var STYLE_ID = 'dewb-sync-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '#dewb-ov,#dewb-ov *{box-sizing:border-box;}',
      '#dewb-ov{position:fixed;inset:0;z-index:99999;background:rgba(8,8,10,.92);',
      'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;',
      'align-items:center;justify-content:center;padding:22px;}',
      '#dewb-ov .bx{width:100%;max-width:360px;background:#14141A;border:1px solid rgba(217,188,140,.28);',
      'border-radius:16px;padding:26px 22px;color:#F5F2EC;',
      'font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;',
      'box-shadow:0 18px 50px rgba(0,0,0,.6);}',
      '#dewb-ov .bd{font-size:10px;letter-spacing:3px;color:#E7B43D;font-weight:800;}',
      '#dewb-ov h3{margin:10px 0 6px;font-size:19px;font-weight:700;letter-spacing:-.2px;}',
      '#dewb-ov p{margin:0 0 16px;font-size:13px;line-height:1.6;color:#9C99A3;}',
      '#dewb-ov input{width:100%;padding:13px 14px;border-radius:10px;border:1px solid rgba(245,242,236,.18);',
      'background:#0B0B0E;color:#F5F2EC;font-size:16px;outline:none;}',
      '#dewb-ov input:focus{border-color:#D9BC8C;}',
      '#dewb-ov .btn{width:100%;margin-top:12px;padding:13px;border:none;border-radius:10px;',
      'background:#E7B43D;color:#17140C;font-size:15px;font-weight:800;cursor:pointer;}',
      '#dewb-ov .btn:active{transform:translateY(1px);}',
      '#dewb-ov .lnk{display:block;width:100%;margin-top:10px;background:none;border:none;',
      'color:#8B8892;font-size:12px;text-decoration:underline;cursor:pointer;padding:6px;}',
      '#dewb-ov .err{margin-top:10px;font-size:12px;color:#E0687C;min-height:16px;}',
      '#dewb-banner{position:fixed;left:0;right:0;bottom:0;z-index:9998;padding:9px 14px;',
      'padding-bottom:calc(9px + env(safe-area-inset-bottom));background:rgba(20,20,26,.96);',
      'border-top:1px solid rgba(217,188,140,.22);color:#C9C6CE;font-size:11.5px;text-align:center;',
      'font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;}',
      '#dewb-banner b{color:#E7B43D;cursor:pointer;text-decoration:underline;}',
      '#dewb-banner .x{position:absolute;right:10px;top:6px;color:#6E6B75;cursor:pointer;padding:4px 6px;}'
    ].join('');
    document.head.appendChild(s);
  }

  function overlay(html, wire) {
    injectStyle();
    var d = document.getElementById('dewb-ov');
    if (!d) { d = document.createElement('div'); d.id = 'dewb-ov'; document.body.appendChild(d); }
    d.innerHTML = '<div class="bx">' + html + '</div>';
    if (wire) wire(d);
  }
  function closeOverlay() {
    var d = document.getElementById('dewb-ov');
    if (d && d.parentNode) d.parentNode.removeChild(d);
  }

  function showBanner(msg) {
    injectStyle();
    if (document.getElementById('dewb-banner')) return;
    var b = document.createElement('div');
    b.id = 'dewb-banner';
    b.innerHTML = msg + ' <b id="dewb-link-now">코드 연결</b><span class="x" id="dewb-bx">✕</span>';
    document.body.appendChild(b);
    b.querySelector('#dewb-bx').onclick = function () { b.remove(); };
    b.querySelector('#dewb-link-now').onclick = function () {
      b.remove(); lsDel(K_SKIP); askCode();
    };
  }

  /* ───────────────────────── 게이트 ───────────────────────── */
  function askGate() {
    return new Promise(function (res) {
      if (lsGet(K_GATE) === 'ok') return res(true);
      overlay(
        '<div class="bd">DO ENGLISH WITH BRIAN</div>' +
        '<h3>Listen &amp; Shadow</h3>' +
        '<p>수강생 전용 페이지예요.<br>안내받은 비밀번호를 입력해 주세요.</p>' +
        '<input id="dewb-pw" type="password" inputmode="text" autocomplete="off" placeholder="비밀번호">' +
        '<button class="btn" id="dewb-pwok">들어가기</button>' +
        '<div class="err" id="dewb-pwerr"></div>',
        function (d) {
          var inp = d.querySelector('#dewb-pw'), err = d.querySelector('#dewb-pwerr');
          function go() {
            var v = (inp.value || '').trim().toLowerCase();
            if (v === GATE_PW.toLowerCase()) { lsSet(K_GATE, 'ok'); closeOverlay(); res(true); }
            else { err.textContent = '비밀번호가 달라요. 다시 확인해 주세요.'; inp.value = ''; inp.focus(); }
          }
          d.querySelector('#dewb-pwok').onclick = go;
          inp.onkeydown = function (e) { if (e.key === 'Enter') go(); };
          setTimeout(function () { inp.focus(); }, 80);
        }
      );
    });
  }

  /* ───────────────────────── 학생 코드 ───────────────────────── */
  function askCode() {
    return new Promise(function (res) {
      overlay(
        '<div class="bd">STUDENT CODE</div>' +
        '<h3>학생 코드 입력</h3>' +
        '<p>수강생 코드가 있어야 이용할 수 있어요.<br>코드를 넣으면 폰·PC 어디서든 진도가 이어져요.</p>' +
        '<input id="dewb-code" type="text" inputmode="text" autocapitalize="off" autocorrect="off" ' +
        'spellcheck="false" autocomplete="off" placeholder="예: hong-3921">' +
        '<button class="btn" id="dewb-cok">연결하기</button>' +
        '<div class="err" id="dewb-cerr"></div>',
        function (d) {
          var inp = d.querySelector('#dewb-code'),
              err = d.querySelector('#dewb-cerr'),
              btn = d.querySelector('#dewb-cok');
          function go() {
            var code = (inp.value || '').trim().toLowerCase().replace(/\s+/g, '');
            if (!code) { err.textContent = '코드를 입력해 주세요.'; return; }
            btn.disabled = true; btn.textContent = '확인 중…'; err.textContent = '';
            verifyCode(code).then(function (name) {
              lsSet(K_STUDENT, JSON.stringify({ code: code, name: name || '' }));
              lsDel(K_SKIP);
              state.code = code; state.name = name || ''; state.linked = true;
              closeOverlay(); res(true);
            }).catch(function (e) {
              btn.disabled = false; btn.textContent = '연결하기';
              err.textContent = (e && e.code === 'not-found')
                ? '등록되지 않은 코드예요. 오타를 확인해 주세요.'
                : '연결에 실패했어요. 네트워크를 확인하고 다시 시도해 주세요.';
            });
          }
          btn.onclick = go;
          inp.onkeydown = function (e) { if (e.key === 'Enter') go(); };
          setTimeout(function () { inp.focus(); }, 80);
        }
      );
    });
  }

  function verifyCode(code) {
    return ensureDb().then(function (db) {
      return db.collection('students').doc(code).get();
    }).then(function (snap) {
      if (!snap.exists) { var e = new Error('not found'); e.code = 'not-found'; throw e; }
      var d = snap.data() || {};
      return d.name || '';
    });
  }

  /* ───────────────────────── Firebase ───────────────────────── */
  var dbPromise = null;
  function ensureDb() {
    if (state.db) return Promise.resolve(state.db);
    if (dbPromise) return dbPromise;
    dbPromise = loadScript(SDK + 'firebase-app-compat.js')
      .then(function () { return loadScript(SDK + 'firebase-firestore-compat.js'); })
      .then(function () {
        if (!window.firebase.apps.length) window.firebase.initializeApp(CFG);
        state.db = window.firebase.firestore();
        return state.db;
      })
      .catch(function (e) { dbPromise = null; throw e; });
    return dbPromise;
  }

  /* ───────────────────────── 병합 로직 ───────────────────────── */
  // prog: true(구버전, t=0 취급) 또는 {v:1|0,t} — t 큰 쪽이 이김. v:0 = 완료 취소(전파용)
  /* prog 항목 포맷: true(legacy 완료) | {t} 완료 | {del:1,t} 완료취소 — t 큰 쪽 승자 */
  function pnorm(e) {
    if (e === true) return { t: 0 };
    if (e && typeof e === 'object') return e;
    return null;
  }
  function mergeProg(local, remote) {
    var out = {}, keys = {}, k, l, r, w;
    local = local || {}; remote = remote || {};
    for (k in local) keys[k] = 1;
    for (k in remote) keys[k] = 1;
    for (k in keys) {
      l = pnorm(local[k]); r = pnorm(remote[k]);
      if (!l && !r) continue;
      w = (l && r) ? (stampOf(l) >= stampOf(r) ? l : r) : (l || r);
      out[k] = (!w.del && !(w.t > 0)) ? true : w;
    }
    return out;
  }
  // keep: {lineIdx:{en,ko,t}} / 삭제 표식 {del:1,t} — t(타임스탬프) 큰 쪽이 이김
  function stampOf(e) { return (e && e.t) || 0; }
  function mergeKeep(local, remote) {
    var out = {}, keys = {}, k, l, r, w;
    local = local || {}; remote = remote || {};
    for (k in local) keys[k] = 1;
    for (k in remote) keys[k] = 1;
    for (k in keys) {
      l = local[k]; r = remote[k];
      w = stampOf(l) >= stampOf(r) ? (l || r) : r;
      if (w) out[k] = w;   /* 삭제 표식도 보존해 다른 기기로 전파 */
    }
    return out;
  }
  function changed(a, b) { return JSON.stringify(a || {}) !== JSON.stringify(b || {}); }

  /* ───────────────────────── 클라우드 ↔ 로컬 ───────────────────────── */
  function pullAndMerge() {
    if (!state.linked) return Promise.resolve(false);
    var remoteProg = {}, remoteKeep = {}, touched = false;
    return ensureDb().then(function (db) {
      return db.collection('progress').doc(state.code).get();
    }).then(function (snap) {
      var d = (snap.exists && snap.data()) || {};
      remoteProg = d.prog || {}; remoteKeep = d.keep || {};
      return rawKeys();
    }).then(function (keys) {
      var ids = {}, i, k;
      for (i = 0; i < keys.length; i++) {
        k = String(keys[i]);
        if (k.indexOf('prog|') === 0) ids['prog|' + k.slice(5)] = 1;
        else if (k.indexOf('keep|') === 0) ids['keep|' + k.slice(5)] = 1;
      }
      for (k in remoteProg) ids['prog|' + k] = 1;
      for (k in remoteKeep) ids['keep|' + k] = 1;

      var list = Object.keys(ids), chain = Promise.resolve(), upload = { prog: {}, keep: {} };
      list.forEach(function (key) {
        chain = chain.then(function () {
          var isProg = key.indexOf('prog|') === 0, sid = key.slice(5);
          return rawGet(key).then(function (local) {
            var remote = isProg ? remoteProg[sid] : remoteKeep[sid];
            var merged = isProg ? mergeProg(local, remote) : mergeKeep(local, remote);
            var writes = [];
            if (changed(local, merged)) { touched = true; writes.push(rawSet(key, merged)); }
            if (changed(remote, merged)) {
              if (isProg) upload.prog[sid] = merged; else upload.keep[sid] = merged;
            }
            return Promise.all(writes);
          });
        });
      });
      return chain.then(function () { return upload; });
    }).then(function (upload) {
      var has = Object.keys(upload.prog).length || Object.keys(upload.keep).length;
      if (!has) return;
      return ensureDb().then(function (db) {
        var doc = { code: state.code, name: state.name || '', updatedAt: Date.now() };
        /* 빈 맵을 merge에 명시하면 기존 필드가 {}로 덮일 수 있음 — 내용 있는 맵만 포함 */
        if (Object.keys(upload.prog).length) doc.prog = upload.prog;
        if (Object.keys(upload.keep).length) doc.keep = upload.keep;
        return db.collection('progress').doc(state.code).set(doc, { merge: true });
      });
    }).then(function () {
      lsSet(K_MIGRATED, state.code);
      log('merged', touched);
      if (touched) refreshUI();
      window.dispatchEvent(new CustomEvent('dewb:sync', { detail: { changed: touched } }));
      return touched;
    }).catch(function (e) { log('pull fail', e); return false; });
  }

  function refreshUI() {
    try { if (typeof window.renderList === 'function') window.renderList(); } catch (e) {}
    try { if (typeof window.renderLines === 'function') window.renderLines(); } catch (e) {}
    try { if (typeof window.renderProgress === 'function') window.renderProgress(); } catch (e) {}
  }

  function queue(key) {
    if (!state.linked) return;
    state.dirty[key] = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(flush, DEBOUNCE);
  }

  function flush() {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    var keys = Object.keys(state.dirty);
    if (!state.linked || !keys.length) return Promise.resolve();
    state.dirty = {};
    var payload = { code: state.code, name: state.name || '', updatedAt: Date.now(), prog: {}, keep: {} };
    return Promise.all(keys.map(function (key) {
      var isProg = key.indexOf('prog|') === 0, sid = key.slice(5);
      return rawGet(key).then(function (v) {
        if (isProg) payload.prog[sid] = v || {};
        else payload.keep[sid] = v || {};
      });
    })).then(function () {
      if (!Object.keys(payload.prog).length) delete payload.prog;
      if (!Object.keys(payload.keep).length) delete payload.keep;
      return ensureDb();
    }).then(function (db) {
      return db.collection('progress').doc(state.code).set(payload, { merge: true });
    }).then(function () { log('uploaded', keys); })
      .catch(function (e) {
        log('upload fail', e);
        keys.forEach(function (k) { state.dirty[k] = true; });   // 실패분 재큐
      });
  }

  /* ───────────────────── kvSet 후킹 ───────────────────── */
  function hookKv() {
    var tries = 0;
    (function attempt() {
      if (typeof window.kvSet === 'function' && !window.kvSet.__dewb) {
        var orig = window.kvSet;
        var wrapped = function (k, v) {
          var p = orig.apply(this, arguments);
          try {
            var key = String(k);
            if (key.indexOf('prog|') === 0 || key.indexOf('keep|') === 0) queue(key);
          } catch (e) {}
          return p;
        };
        wrapped.__dewb = 1;
        window.kvSet = wrapped;
        log('kvSet hooked');
        return;
      }
      if (++tries < 60) setTimeout(attempt, 50);
      else log('kvSet not found — 자체 API만 사용');
    })();
  }

  /* ───────────────────── KEEP API ───────────────────── */
  function keepGet(sceneId) {
    return rawGet('keep|' + sceneId).then(function (v) {
      var out = {}, i; v = v || {};
      for (i in v) if (v[i] && !v[i].del) out[i] = v[i];
      return out;
    });
  }
  function keepSet(sceneId, idx, data) {
    var key = 'keep|' + sceneId;
    return rawGet(key).then(function (m) {
      m = m || {};
      if (data === null) m[String(idx)] = { del: 1, t: Date.now() };   // 삭제 표식
      else m[String(idx)] = { en: data.en || '', ko: data.ko || '', t: data.t || Date.now() };
      return rawSet(key, m).then(function () { queue(key); return m; });
    });
  }
  function keepToggle(sceneId, idx, data) {
    return keepGet(sceneId).then(function (m) {
      var e = m && m[String(idx)]; var on = !!(e && !e.del);
      return keepSet(sceneId, idx, on ? null : (data || {})).then(function () { return !on; });
    });
  }
  function keepAll() {
    return rawKeys().then(function (keys) {
      var out = {}, chain = Promise.resolve();
      keys.filter(function (k) { return String(k).indexOf('keep|') === 0; })
        .forEach(function (k) {
          chain = chain.then(function () {
            return rawGet(k).then(function (v) {
              var clean = {}, n = 0, i;
              for (i in (v || {})) if (v[i] && !v[i].del) { clean[i] = v[i]; n++; }
              if (n) out[String(k).slice(5)] = clean;
            });
          });
        });
      return chain.then(function () { return out; });
    });
  }
  function progAll() {
    return rawKeys().then(function (keys) {
      var out = {}, chain = Promise.resolve();
      keys.filter(function (k) { return String(k).indexOf('prog|') === 0; })
        .forEach(function (k) {
          chain = chain.then(function () {
            return rawGet(k).then(function (v) {
              var clean = {}, n = 0, i, e;
              for (i in (v || {})) { e = v[i];
                if (e === true || (e && !e.del)) { clean[i] = true; n++; } }
              if (n) out[String(k).slice(5)] = clean;
            });
          });
        });
      return chain.then(function () { return out; });
    });
  }

  /* ───────────────────── 딥링크 ?scene=&line= ───────────────────── */
  function param(n) {
    try { return new URLSearchParams(location.search).get(n); } catch (e) { return null; }
  }
  function deepLine() {
    var v = param('line');
    if (v == null) return null;
    var n = parseInt(v, 10);
    return (isNaN(n) || n < 0) ? null : n;
  }

  /* ───────────────────── 부팅 ───────────────────── */
  function boot() {
    if (state.booting) return; state.booting = true;
    hookKv();

    var saved = null;
    try { saved = JSON.parse(lsGet(K_STUDENT) || 'null'); } catch (e) {}

    askGate().then(function () {
      if (saved && saved.code) {
        state.code = saved.code; state.name = saved.name || ''; state.linked = true;
        /* 매 접속 재검증: 코드가 명단에서 삭제됐으면 잠금. 네트워크 오류는 통과(오프라인 보호) */
        return verifyCode(saved.code).then(function (name) {
          if (name && name !== state.name) { state.name = name; lsSet(K_STUDENT, JSON.stringify({ code: state.code, name: name })); }
          return true;
        }).catch(function (e) {
          if (e && e.code === 'not-found') {
            lsDel(K_STUDENT); lsDel(K_MIGRATED);
            state.linked = false; state.code = null; state.name = null;
            return askCode();
          }
          return true; /* 일시적 오류 — 기존 연결 유지 */
        });
      }
      return askCode();
    }).then(function (linked) {
      state.ready = true;
      window.dispatchEvent(new CustomEvent('dewb:ready', {
        detail: { linked: !!linked, code: state.code, name: state.name }
      }));
      if (linked) return pullAndMerge();
    });
  }

  /* 페이지 이탈 직전 강제 업로드 */
  function bindUnload() {
    window.addEventListener('pagehide', function () { flush(); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  /* ───────────────────── 공개 API ───────────────────── */
  window.DEWBSync = {
    version: '1.0',
    isReady: function () { return state.ready; },
    isLinked: function () { return state.linked; },
    student: function () { return state.linked ? { code: state.code, name: state.name } : null; },
    link: function () { lsDel(K_SKIP); return askCode().then(function (ok) { if (ok) return pullAndMerge(); }); },
    unlink: function () {
      flush();
      lsDel(K_STUDENT); lsDel(K_MIGRATED);
      state.linked = false; state.code = null; state.name = null;
      return askCode().then(function (ok) { if (ok) return pullAndMerge(); });
    },
    resetGate: function () { lsDel(K_GATE); },
    sync: pullAndMerge,
    flush: flush,
    keepGet: keepGet,
    keepSet: keepSet,
    keepToggle: keepToggle,
    keepAll: keepAll,
    progAll: progAll,
    deepLine: deepLine,
    param: param,
    _state: state
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bindUnload(); boot(); });
  } else { bindUnload(); boot(); }
})();
