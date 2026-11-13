/* 本地状态层：IndexedDB 为主，localStorage 兜底。
 * 所有日期键一律经 window.YW_TZ（Asia/Shanghai）计算，
 * 禁止用 new Date() 直接取日历日，禁止系统时区回落。
 */
(function () {
  'use strict';

  var DB_NAME = 'yuwen-blocks';
  var DB_VER = 1;
  var STORE = 'state';
  var LS_KEY = 'yuwen-blocks-state-v1';
  var REVIEW_GAPS = [1, 3, 7];

  var db = null;
  var useLS = false;
  var root = null;   // { v, activeId, profiles: { <profileId>: 该使用者的完整状态 } }
  var S = null;      // 始终指向 root.profiles[root.activeId]
  var writeChain = Promise.resolve();

  function randomSpaceId() {
    var a = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
    else for (var i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256);
    return Array.from(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  // 每个使用者一份完全独立的状态：错题、掌握度、进度、方块、每日存档都互不干扰。
  // spaceId 即 profileId，云端 UNIQUE(space_id, save_date) 天然等于「一人一天一份」。
  function profileDefaults(name) {
    return {
      v: 1,
      id: randomSpaceId(),
      name: name || '学习者',
      spaceId: '',
      grade: 3, term: '上',
      progress: { unit: 5, lesson: 15 },
      digUnit: 5, digLesson: 15,
      pendingRound: null,
      examScope: { midterm: [1, 2, 3, 4], final: [1, 2, 3, 4, 5, 6, 7, 8] },
      blocks: 0, level: 1, streak: 0, lastActiveDate: null,
      noAnim: false,
      attempts: [], kpHistory: {}, wrong: {}, daily: {},
      saves: {}, pendingSync: [],
    };
  }

  function rootDefaults() {
    var p = profileDefaults('学习者');
    p.spaceId = p.id;
    var r = { v: 2, activeId: p.id, profiles: {} };
    r.profiles[p.id] = p;
    return r;
  }

  /* ---------- 日期：唯一入口 ---------- */
  function dateKey(d) {
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: window.YW_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d || new Date());
    var o = {};
    parts.forEach(function (p) { o[p.type] = p.value; });
    return o.year + '-' + o.month + '-' + o.day;
  }
  function todayKey() { return dateKey(new Date()); }
  function addDays(key, n) {
    var a = key.split('-').map(Number);
    // 取 UTC 正午做纯日期算术，避开任何时区/DST 影响
    return new Date(Date.UTC(a[0], a[1] - 1, a[2] + n, 12)).toISOString().slice(0, 10);
  }

  /* ---------- 持久化 ---------- */
  function openDB() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no indexedDB')); return; }
      var r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = function () {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
      };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  function writeRaw(text) {
    if (useLS || !db) {
      try { localStorage.setItem(LS_KEY, text); } catch (e) { /* 存储受限，内存态仍可用 */ }
      return Promise.resolve();
    }
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(text, 'main');
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  function persist() {
    var text = JSON.stringify(root);
    writeChain = writeChain.then(function () { return writeRaw(text); }).catch(function () {});
    return writeChain;
  }

  function validUnit(id) {
    return (window.YW_UNITS || []).some(function (u) { return u.id === Number(id); });
  }
  function unitById(id) {
    return (window.YW_UNITS || []).filter(function (u) { return u.id === Number(id); })[0]
      || (window.YW_UNITS || [])[0] || null;
  }
  // 任何入口都把「不属于当前单元的课号」纠正到该单元第一课，杜绝下拉显示与实际取值不一致
  function normalizeLesson(unitId, lesson, allowZero) {
    var u = unitById(unitId);
    if (!u || !u.lessons || !u.lessons.length) return lesson;
    if (allowZero && Number(lesson) === 0) return 0;
    return u.lessons.some(function (l) { return l.n === Number(lesson); })
      ? Number(lesson) : u.lessons[0].n;
  }

  function normalizeProfile(p, id, name) {
    var d = profileDefaults(name);
    Object.keys(d).forEach(function (k) { if (p[k] === undefined) p[k] = d[k]; });
    p.id = id;
    if (!p.spaceId) p.spaceId = id;
    if (!p.name) p.name = name || '学习者';
    p.progress = p.progress || d.progress;
    p.progress.unit = Number(p.progress.unit);
    if (!validUnit(p.progress.unit)) p.progress.unit = 1;
    p.digUnit = Number(p.digUnit);
    if (!validUnit(p.digUnit)) p.digUnit = p.progress.unit;
    p.digLesson = normalizeLesson(p.digUnit, p.digLesson, true);
    p.progress.lesson = normalizeLesson(p.progress.unit, p.progress.lesson, false);
    return p;
  }

  function buildRoot(parsed) {
    if (!parsed) return rootDefaults();
    var r;
    if (parsed.v === 2 && parsed.profiles) {
      r = parsed;
    } else {
      // 旧版单使用者数据自动迁成第一个档案，历史记录不丢
      var legacy = Object.assign({}, parsed);
      var id = legacy.spaceId || randomSpaceId();
      r = { v: 2, activeId: id, profiles: {} };
      r.profiles[id] = normalizeProfile(legacy, id, '学习者');
    }
    if (!r.profiles) r.profiles = {};
    var ids = Object.keys(r.profiles);
    if (!ids.length) return rootDefaults();
    ids.forEach(function (id) { r.profiles[id] = normalizeProfile(r.profiles[id], id, '学习者'); });
    if (!r.profiles[r.activeId]) r.activeId = Object.keys(r.profiles)[0];
    return r;
  }

  async function init() {
    var parsed = null;
    try {
      db = await openDB();
      parsed = await new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var rq = tx.objectStore(STORE).get('main');
        rq.onsuccess = function () { resolve(rq.result ? JSON.parse(rq.result) : null); };
        rq.onerror = function () { reject(rq.error); };
      });
    } catch (e) {
      useLS = true;
      try { parsed = JSON.parse(localStorage.getItem(LS_KEY)) || null; }
      catch (e2) { parsed = null; }
    }
    root = buildRoot(parsed);
    S = root.profiles[root.activeId];
    await persist();
    return S;
  }

  /* ---------- 掌握度 ---------- */
  function masteryOf(kp) {
    var h = (S.kpHistory[kp] || []).slice(-8);
    if (!h.length) return 0;
    var sum = 0, w = 0;
    h.forEach(function (ok, i) { var weight = i + 1; w += weight; if (ok) sum += weight; });
    return Math.round(sum / w * 100);
  }
  function allMastery() {
    var out = {};
    Object.keys(window.YW_KP).forEach(function (k) { out[k] = masteryOf(k); });
    return out;
  }
  function unitMastery(unitId) {
    var kps = {};
    window.YW_QUESTIONS.forEach(function (q) { if (q.unit === unitId) kps[q.kp] = 1; });
    var keys = Object.keys(kps);
    if (!keys.length) return 0;
    var sum = keys.reduce(function (a, k) { return a + masteryOf(k); }, 0);
    return Math.round(sum / keys.length);
  }

  /* ---------- 错因与错题 ---------- */
  // type: careless 看错了 / confused 记混了 / unknown 还没学会
  function classify(q, selected) {
    if (q.trap && q.trap.indexOf(selected) >= 0) return 'careless';
    if (q.kp === 'xingjinzi' || q.kp === 'deDiDe' || q.kp === 'duoyinzi') return 'confused';
    return 'unknown';
  }

  function dueWrong() {
    var t = todayKey();
    return Object.keys(S.wrong).filter(function (id) {
      var w = S.wrong[id];
      return w && !w.graduated && w.due <= t;
    });
  }

  function recordAnswer(q, selected, correct, isReview) {
    var t = todayKey();
    var type = correct ? '' : classify(q, selected);

    S.attempts.push({ q: q.id, d: t, ok: !!correct, t: type, s: selected });
    if (S.attempts.length > 200) S.attempts = S.attempts.slice(-200);
    (S.kpHistory[q.kp] = S.kpHistory[q.kp] || []).push(!!correct);
    if (S.kpHistory[q.kp].length > 12) S.kpHistory[q.kp] = S.kpHistory[q.kp].slice(-12);

    var day = S.daily[t] = S.daily[t] || { attempts: 0, correct: 0, careless: 0, blocks: 0 };
    day.attempts += 1;
    if (correct) { day.correct += 1; S.blocks += 1; day.blocks += 1; }
    if (type === 'careless') day.careless += 1;

    S.level = 1 + Math.floor(S.blocks / 20);
    if (S.lastActiveDate !== t) {
      S.streak = (S.lastActiveDate === addDays(t, -1)) ? S.streak + 1 : 1;
      S.lastActiveDate = t;
    }

    var w = S.wrong[q.id];
    if (isReview && w) {
      if (correct) {
        w.okCount = (w.okCount || 0) + 1;
        w.stage = Math.min((w.stage || 0) + 1, REVIEW_GAPS.length - 1);
        w.due = addDays(t, REVIEW_GAPS[w.stage]);
        w.lastDate = t;
        if (w.okCount >= 2) w.graduated = true;
      } else {
        w.okCount = 0; w.stage = 0; w.due = addDays(t, 1); w.lastDate = t;
      }
    } else if (!correct) {
      S.wrong[q.id] = w
        ? Object.assign(w, { type: type, stage: 0, due: addDays(t, 1), okCount: 0, count: (w.count || 0) + 1, graduated: false, lastDate: t })
        : { qid: q.id, type: type, stage: 0, due: addDays(t, 1), okCount: 0, count: 1, graduated: false, lastDate: t };
    }

    var payload = finalizeDay(t);
    persist();
    return payload;
  }

  /* ---------- 每日存档快照 ---------- */
  // 只存题号、对错、错因、知识点编号与统计；不存题干、姓名或任何个人信息。
  function buildDaySnapshot(date) {
    var d = date || todayKey();
    return {
      v: 1,
      date: d,
      tz: window.YW_TZ,
      edition: window.YW_EDITION,
      profileId: S.spaceId,
      grade: S.grade, term: S.term,
      blocks: S.blocks,
      level: S.level,
      streak: S.streak,
      progress: { unit: S.progress.unit, lesson: S.progress.lesson },
      today: S.daily[d] || { attempts: 0, correct: 0, careless: 0, blocks: 0 },
      mastery: allMastery(),
      wrong: Object.keys(S.wrong).filter(function (id) { return !S.wrong[id].graduated; })
        .map(function (id) { return { q: id, t: S.wrong[id].type, s: S.wrong[id].stage, due: S.wrong[id].due }; }),
      attempts: S.attempts.filter(function (a) { return a.d === d; })
        .map(function (a) { return { q: a.q, ok: a.ok, t: a.t }; }),
    };
  }

  function finalizeDay(date) {
    var d = date || todayKey();
    var payload = buildDaySnapshot(d);
    S.saves[d] = payload;
    if (S.pendingSync.indexOf(d) < 0) S.pendingSync.push(d);
    persist();
    return payload;
  }

  function markSynced(date) {
    var i = S.pendingSync.indexOf(date);
    if (i >= 0) S.pendingSync.splice(i, 1);
    persist();
  }

  function applySnapshot(p) {
    if (!p || p.v !== 1) throw new Error('存档版本不认识');
    if (typeof p.blocks === 'number') S.blocks = p.blocks;
    if (typeof p.level === 'number') S.level = p.level;
    if (typeof p.streak === 'number') S.streak = p.streak;
    if (p.progress) S.progress = { unit: p.progress.unit, lesson: p.progress.lesson };
    if (typeof p.grade === 'number') S.grade = p.grade;
    if (p.term) S.term = p.term;
    if (p.today && p.date) S.daily[p.date] = p.today;
    if (p.wrong) {
      p.wrong.forEach(function (w) {
        if (!window.YW_Q_BY_ID[w.q]) return;
        S.wrong[w.q] = { qid: w.q, type: w.t, stage: w.s || 0, due: w.due, okCount: 0, count: 1, graduated: false };
      });
    }
    if (p.attempts && p.date) {
      var qBy = window.YW_Q_BY_ID;
      p.attempts.forEach(function (a) {
        var q = qBy[a.q]; if (!q) return;
        (S.kpHistory[q.kp] = S.kpHistory[q.kp] || []).push(!!a.ok);
      });
      Object.keys(S.kpHistory).forEach(function (k) {
        S.kpHistory[k] = S.kpHistory[k].slice(-12);
      });
      S.attempts = S.attempts.concat(p.attempts.map(function (a) {
        return { q: a.q, d: p.date, ok: !!a.ok, t: a.t || '', s: -1 };
      })).slice(-200);
    }
    if (p.date) S.saves[p.date] = p;
    persist();
  }

  /* ---------- 组卷：日常 / 忆往昔 / 重点 / 全面 / 专项 / 期中期末 ---------- */
  function isWrong(qid) {
    var w = S.wrong[qid];
    return !!(w && !w.graduated);
  }
  function rank(pool) {
    return pool.map(function (q) {
      return { q: q, score: masteryOf(q.kp) + Math.random() * 40 };
    }).sort(function (a, b) { return a.score - b.score; })
      .map(function (x) { return x.q; });
  }
  // 均衡抽样：按单元/年级分组轮转，保证每个区块都覆盖到
  function balanced(pool, n) {
    var groups = {};
    pool.forEach(function (q) {
      var k = q.grade === S.grade ? 'u' + q.unit : 'g' + q.grade;
      (groups[k] = groups[k] || []).push(q);
    });
    Object.keys(groups).forEach(function (k) { groups[k] = rank(groups[k]); });
    var keys = Object.keys(groups), out = [], i = 0;
    while (out.length < n) {
      var added = false;
      for (var j = 0; j < keys.length && out.length < n; j++) {
        if (groups[keys[j]].length > i) { out.push(groups[keys[j]][i]); added = true; }
      }
      if (!added) break;
      i++;
    }
    return out;
  }

  function buildRound(spec) {
    spec = spec || {};
    var mode = spec.mode || 'daily';
    var n = spec.count || (mode === 'exam' ? 10 : mode === 'full' ? 10 : 5);
    var all = window.YW_QUESTIONS;
    var wrongIds = Object.keys(S.wrong).filter(isWrong);
    var picked = [], label = '今日挖掘', note = '';

    if (mode === 'daily') {
      var digU = spec.unit || S.digUnit || S.progress.unit;
      var digL = (spec.lesson !== undefined && spec.lesson !== null)
        ? spec.lesson : (S.digLesson || S.progress.lesson);
      var due = dueWrong().slice(0, 2).map(function (id) { return window.YW_Q_BY_ID[id]; }).filter(Boolean);
      var seen = {}; due.forEach(function (q) { seen[q.id] = 1; });
      var need = Math.max(0, n - due.length);
      var cur = window.YW_currentQuestions(S.grade).filter(function (q) { return !seen[q.id]; });
      var inLesson = cur.filter(function (q) { return q.unit === digU && (!digL || q.lesson === digL); });
      var inUnit = cur.filter(function (q) { return q.unit === digU; });
      var learned = cur.filter(function (q) { return q.unit <= digU; });
      var primary = rank(inLesson);
      var used = {}; primary.forEach(function (q) { used[q.id] = 1; });
      var extra = rank(inUnit.filter(function (q) { return !used[q.id]; }));
      extra.forEach(function (q) { used[q.id] = 1; });
      var more = rank(learned.filter(function (q) { return !used[q.id]; }));
      more.forEach(function (q) { used[q.id] = 1; });
      var rest = rank(cur.filter(function (q) { return !used[q.id]; }));
      picked = due.concat(primary.concat(extra, more, rest).slice(0, need));
      note = '范围：第 ' + digU + ' 单元' + (digL ? ' · 第 ' + digL + ' 课' : '（整单元）') +
             (primary.length < need ? ' · 本课题目不够，已用本单元补齐' : '');
    } else if (mode === 'past') {
      label = '忆往昔 · 复习';
      var past = window.YW_pastQuestions(S.grade);
      if (spec.grade) past = past.filter(function (q) { return q.grade === spec.grade; });
      var pw = wrongIds.map(function (id) { return window.YW_Q_BY_ID[id]; })
        .filter(function (q) { return q && q.grade < S.grade && (!spec.grade || q.grade === spec.grade); });
      var seen2 = {}; pw.forEach(function (q) { seen2[q.id] = 1; });
      picked = rank(pw).concat(rank(past.filter(function (q) { return !seen2[q.id]; }))).slice(0, n);
      note = '历史错题排在最前';
    } else if (mode === 'focus') {
      label = '重点复习';
      var wq = wrongIds.map(function (id) { return window.YW_Q_BY_ID[id]; }).filter(Boolean);
      var seen3 = {}; wq.forEach(function (q) { seen3[q.id] = 1; });
      var weak = all.filter(function (q) { return !seen3[q.id] && masteryOf(q.kp) < 60; });
      picked = rank(wq).concat(rank(weak)).slice(0, n);
      note = '错题 + 掌握度低于 60 的知识点';
    } else if (mode === 'full') {
      label = '全面复习';
      picked = balanced(spec.scope === 'past' ? window.YW_pastQuestions(S.grade) : window.YW_currentQuestions(S.grade), n);
      note = '按单元 / 年级均衡覆盖';
    } else if (mode === 'topic') {
      label = '专项复习';
      var tp = all.filter(function (q) {
        var okKp = spec.kp ? q.kp === spec.kp : true;
        var okDim = spec.dim ? q.dim === spec.dim : true;
        var okUnit = spec.units ? spec.units.indexOf(q.unit) >= 0 : true;
        var okScope = spec.scope === 'past' ? q.grade < S.grade
                    : spec.scope === 'current' ? q.grade === S.grade : true;
        return okKp && okDim && okUnit && okScope;
      });
      picked = rank(tp).slice(0, n);
      note = spec.dim ? ((window.YW_DIMS[spec.dim] || {}).label || '所选维度')
           : spec.kp ? ((window.YW_KP[spec.kp] || {}).label || '所选知识点') : '所选范围';
    } else if (mode === 'exam') {
      var ex = window.YW_EXAM[spec.examKey || 'midterm'];
      label = ex.label;
      var units = S.examScope[ex.key] || ex.units;
      picked = balanced(window.YW_currentQuestions(S.grade, units), spec.count || ex.count);
      note = ex.desc + ' · 当前范围：第 ' + units.join('、') + ' 单元';
    }

    var uniq = {}, items = [];
    picked.forEach(function (q) {
      if (!q || uniq[q.id]) return;
      uniq[q.id] = 1;
      items.push({ q: q, isReview: isWrong(q.id) });
    });
    return { mode: mode, label: label, note: note, items: items, count: items.length };
  }

  function pickRound(n) { return buildRound({ mode: 'daily', count: n || 5 }); }

  /* ---------- 多使用者档案 ---------- */
  function profileList() {
    return Object.keys(root.profiles).map(function (id) {
      var p = root.profiles[id];
      return {
        id: id, name: p.name, blocks: p.blocks || 0, level: p.level || 1,
        wrong: Object.keys(p.wrong || {}).filter(function (q) { return !p.wrong[q].graduated; }).length,
        progress: p.progress, active: id === root.activeId,
      };
    });
  }
  async function switchProfile(id) {
    if (!root.profiles[id]) throw new Error('找不到这个使用者');
    root.activeId = id;
    S = root.profiles[id];
    await persist();
    return S;
  }
  async function createProfile(name) {
    var n = String(name || '').trim().slice(0, 12);
    if (!n) throw new Error('先给这个使用者起个名字');
    var p = profileDefaults(n);
    p.spaceId = p.id;
    root.profiles[p.id] = p;
    root.activeId = p.id;
    S = p;
    await persist();
    return p;
  }
  async function renameProfile(name, id) {
    var n = String(name || '').trim().slice(0, 12);
    if (!n) throw new Error('名字不能为空');
    var target = (id && root.profiles[id]) ? root.profiles[id] : S;
    target.name = n;
    await persist();
  }
  async function deleteProfile(id) {
    if (Object.keys(root.profiles).length <= 1) throw new Error('至少要留一个使用者');
    if (!root.profiles[id]) return;
    delete root.profiles[id];
    if (root.activeId === id) root.activeId = Object.keys(root.profiles)[0];
    S = root.profiles[root.activeId];
    await persist();
  }

  /* ---------- 未完成的这一趟（待办） ---------- */
  // 只存题号与进度，不存题干；题库调整后仍能还原，且每个使用者各自一份。
  function saveRound(r) {
    if (!r) { S.pendingRound = null; persist(); return; }
    S.pendingRound = {
      spec: r.spec || {},
      label: r.label, note: r.note || '', mode: r.mode,
      items: r.items.map(function (it) { return { q: it.q.id, isReview: !!it.isReview }; }),
      idx: r.idx || 0,
      results: r.results || [],
      selected: r.selected,
      phase: r.phase || 'ask',
    };
    persist();
  }
  function loadRound() {
    var p = S.pendingRound;
    if (!p || !p.items || !p.items.length || p.phase === 'done') return null;
    var items = p.items.map(function (x) {
      var q = window.YW_Q_BY_ID[x.q];
      return q ? { q: q, isReview: !!x.isReview } : null;
    }).filter(Boolean);
    if (!items.length) return null;
    return {
      spec: p.spec || {}, label: p.label || '练习', note: p.note || '',
      mode: p.mode || 'daily', items: items,
      idx: Math.min(p.idx || 0, items.length - 1),
      results: (p.results || []).slice(0, items.length),
      selected: p.selected,
      phase: p.phase === 'feedback' ? 'feedback' : 'ask',
    };
  }
  function clearRound() { S.pendingRound = null; persist(); }
  function setDigScope(u, l) {
    var unit = validUnit(u) ? Number(u) : S.progress.unit;
    S.digUnit = unit;
    S.digLesson = normalizeLesson(unit, l, true);
    return persist();
  }
  function setProgress(u, l) {
    var unit = validUnit(u) ? Number(u) : 1;
    S.progress = { unit: unit, lesson: normalizeLesson(unit, l, false) };
    return persist();
  }

  function exportAll() {
    return { v: 2, exportedFrom: window.YW_EDITION, root: root };
  }

  async function importAll(obj) {
    if (!obj) throw new Error('文件格式不对');
    var source = obj.root || obj.state || null;
    if (!source) throw new Error('文件格式不对');
    root = buildRoot(source);
    S = root.profiles[root.activeId];
    await persist();
  }

  function resetLocal() {
    var id = S.id, name = S.name, code = S.spaceId;
    S = profileDefaults(name);
    S.id = id; S.spaceId = code || id;
    root.profiles[id] = S;
    return persist();
  }

  window.YWStore = {
    init: init, get: function () { return S; }, persist: persist,
    dateKey: dateKey, todayKey: todayKey, addDays: addDays,
    masteryOf: masteryOf, allMastery: allMastery, unitMastery: unitMastery,
    classify: classify, dueWrong: dueWrong, recordAnswer: recordAnswer,
    buildDaySnapshot: buildDaySnapshot, finalizeDay: finalizeDay, markSynced: markSynced,
    applySnapshot: applySnapshot, pickRound: pickRound, buildRound: buildRound,
    saveRound: saveRound, loadRound: loadRound, clearRound: clearRound, setDigScope: setDigScope,
    exportAll: exportAll, importAll: importAll, resetLocal: resetLocal,
    isFallback: function () { return useLS; },
    profileList: profileList, switchProfile: switchProfile, createProfile: createProfile,
    renameProfile: renameProfile, deleteProfile: deleteProfile,
    profileId: function () { return S.id; }, profileName: function () { return S.name; },
    setSpaceId: function (code) { S.spaceId = String(code || '').trim(); return persist(); },
    setProgress: setProgress,
    setGrade: function (g, t) { S.grade = Number(g); S.term = t || S.term; return persist(); },
    setExamScope: function (key, units) { S.examScope[key] = units; return persist(); },
    pastCount: function () { return window.YW_pastQuestions(S.grade).length; },
    setNoAnim: function (v) { S.noAnim = !!v; document.documentElement.classList.toggle('no-anim', !!v); return persist(); },
  };
})();
