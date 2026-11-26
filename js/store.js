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
  var S = null;      // 始终指向当前身份的状态（游客时指向内存临时态）
  var lastGaveBlock = false;  // 上一次 recordAnswer 有没有真的发出砖，UI 用它决定提示文案
  var guest = false; // 游客：不写 root、不上云，刷新即清空
  var writeChain = Promise.resolve();

  function randomSpaceId() {
    var a = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
    else for (var i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256);
    return Array.from(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  /* ---------- 身份：昵称即身份 ---------- */
  // 归一化只影响「是不是同一个昵称」的判断，不改用户看到的名字：
  // 去掉所有空白、英文不分大小写。这样「小宇」「 小宇 」「小 宇」都算同一个人，
  // 换设备时随手敲也能接回原来的存档。
  function nickKey(name) {
    return String(name == null ? '' : name).replace(/\s+/g, '').toLowerCase();
  }
  // 同一昵称在任何设备上推出同一个 spaceId，于是「输同一个昵称」就等于「取回同一份云端存档」，
  // 不再需要复制粘贴存档码。两轮不同初值的哈希拼接，短昵称也不容易撞。
  function deriveSpaceId(name) {
    var k = nickKey(name);
    var h = 0x811c9dc5, g = 0x9e3779b9;
    for (var i = 0; i < k.length; i++) {
      var c = k.charCodeAt(i);
      h = (h ^ c) >>> 0; h = Math.imul(h, 0x01000193) >>> 0;
      g = (g ^ (c + i + 1)) >>> 0; g = Math.imul(g, 0x85ebca6b) >>> 0;
    }
    return 'sn' + ('0000000' + h.toString(16)).slice(-8) + ('000' + g.toString(16)).slice(-4);
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
      // 新档案从第 1 课开始：有了「一课一关」，一上来就跳到第 15 课等于把闸门让开了
      progress: { unit: 1, lesson: 1 },
      digUnit: 1, digLesson: 1,
      pendingRound: null,
      examScope: { midterm: [1, 2, 3, 4], final: [1, 2, 3, 4, 5, 6, 7, 8] },
      blocks: 0, level: 1, streak: 0, lastActiveDate: null,
      noAnim: false,
      lastRun: null,   // 上一趟的结果，只存本机，用于回首页后展示，不进云端快照
      // qstat[qid] = { d, seen, scored }：这道题今天是否已计入统计 / 是否已发过砖。
      // 用于保证「同一道题当天只算一次」，防止反复订正同一题刷砖、刷正确率、刷掌握度。
      qstat: {},
      // 每日挑战的徽章只做纪念：不加砖、不计入掌握度，也不进云端快照。
      badges: {},
      // n = 当天已经出过几道「打字」题（填空），全天最多两道；
      // kinds = 当天出过的输出题类型，用来轮换 spot/fill/order，避免连着几趟同一种。
      fillDay: { d: '', n: 0, kinds: [] },
      // BOSS 战利品：礼物库在云端（全局共享，只有家长账号能写），这里只缓存一份。
      // 战利品可分解成字块碎片、碎片可兑换礼物；二者都有价值，随云端日快照走。
      prizePool: [], loot: [], shards: 0, bossDone: {}, giftPool: [], giftPoolAt: '',
      // 字块大陆三难度进度（老存档缺这个字段时由 leagueState() 自动补默认值）
      league: null,
      attempts: [], kpHistory: {}, wrong: {}, daily: {},
      saves: {}, pendingSync: [],
      // 一课一关的过关记录，键是「册次:课号」
      gates: {},
      // 最近一次做过「本周回看」是哪一周（周一日期做键），一周只提醒一次
      weekDone: '',
    };
  }

  // 游客：内存里的一份临时状态，永远不进 root、不进云端，关掉页面就没了
  function guestState() {
    var p = profileDefaults('游客');
    p.id = 'guest';
    p.spaceId = '';
    p.guest = true;
    return p;
  }

  // 全新安装时没有默认使用者：先让用户选身份（已有昵称 / 新昵称 / 游客）
  function rootDefaults() {
    return { v: 3, activeId: null, profiles: {} };
  }

  /* ---------- 专项突破：阅读理解 / 生词认记背默 ----------
   * 与原有砖、段位、碎片完全隔离：只记专项掌握度与错字本，走 1/3/7 天回访。
   * 默写按「字」判定：一个词里错哪个字就记哪个字，不错整词一刀切。
   */
  var COACH_GAPS = [1, 3, 7];
  function coachState() {
    if (!S.coach) S.coach = { read: {}, words: {}, wordWrong: {}, due: {} };
    var C = S.coach;
    C.read = C.read || {}; C.words = C.words || {};
    C.wordWrong = C.wordWrong || {}; C.due = C.due || {};
    return C;
  }
  function coachReadMastery(layer) {
    var h = (coachState().read[layer] || {}).h || [];
    if (!h.length) return 0;
    var sum = 0, w = 0;
    h.slice(-8).forEach(function (ok, i) { var wt = i + 1; w += wt; if (ok) sum += wt; });
    return w ? Math.round(sum / w * 100) : 0;
  }
  function coachWordMastery(id) {
    var e = coachState().words[id];
    return e ? (e.pct || 0) : 0;
  }
  // 默写：逐字比对，返回每个字的对错；错的字才进错字本
  function checkDictation(wordId, input) {
    var w = (window.YW_COACH_WORDS || []).filter(function (x) { return x.id === wordId; })[0];
    if (!w) return { ok: false, reason: '找不到这个词' };
    var raw = String(input == null ? '' : input).replace(/[\s，。！？、：；"'·]/g, '');
    var target = w.word, chars = target.split(''), typed = raw.split('');
    var flags = chars.map(function (c, i) { return typed[i] === c; });
    var right = flags.filter(Boolean).length;
    var C = coachState(), t = todayKey();
    var entry = C.words[wordId] || { pct: 0, n: 0, ok: 0, wrongChars: {} };
    entry.n = (entry.n || 0) + 1;
    entry.last = t;
    flags.forEach(function (good, i) {
      if (good) return;
      entry.wrongChars = entry.wrongChars || {};
      entry.wrongChars[chars[i]] = (entry.wrongChars[chars[i]] || 0) + 1;
      var wid = wordId + ':' + chars[i];
      var we = C.wordWrong[wid] || { ch: chars[i], word: target, stage: 0, due: t, seen: 0, ok: 0 };
      we.seen = (we.seen || 0) + 1; we.due = t; C.wordWrong[wid] = we;
    });
    if (right === chars.length) {
      entry.ok = (entry.ok || 0) + 1;
      var perfectRate = Math.round(entry.ok / entry.n * 100);
      entry.pct = Math.max(entry.pct || 0, Math.min(100, perfectRate + 20));
      // 全对一次就推进该词所有错字的复习间隔
      Object.keys(C.wordWrong).forEach(function (k) {
        if (k.indexOf(wordId + ':') !== 0) return;
        var we2 = C.wordWrong[k];
        we2.ok = (we2.ok || 0) + 1;
        we2.stage = Math.min((we2.stage || 0) + 1, COACH_GAPS.length - 1);
        we2.due = addDays(t, COACH_GAPS[we2.stage]);
      });
    } else {
      entry.pct = Math.max(0, Math.round(right / chars.length * 100));
    }
    C.words[wordId] = entry;
    persist();
    return { ok: right === chars.length, word: target, flags: flags, right: right,
             total: chars.length, pct: entry.pct, wrongChars: chars.filter(function (c, i) { return !flags[i]; }) };
  }
  // 「用一句话说出来」：不用语义模型，只看关键词覆盖。
  // 三年级要求的是说出主要意思，句式怎么写都行，所以只要命中足够多的关键信息、
  // 字数够（不是「好」「不知道」这种敷衍），就算过；过完给参考答句自己对照。
  function normSay(s) {
    return String(s == null ? '' : s)
      .replace(/[\s\u3000]/g, '')
      .replace(/[，。！？、：；,.!?:;"'“”‘’（）()《》〈〉…—～~\-]/g, '');
  }
  function judgeSay(q, input) {
    var t = normSay(input);
    var hits = 0, hitIdx = [], missIdx = [];
    (q.keys || []).forEach(function (group, i) {
      var ok = group.some(function (k) { return t.indexOf(normSay(k)) >= 0; });
      if (ok) { hits += 1; hitIdx.push(i); } else { missIdx.push(i); }
    });
    var need = q.need || 2;
    var min = q.min || 10;
    var longEnough = t.length >= min;
    return { ok: longEnough && hits >= need, hits: hits, need: need,
             longEnough: longEnough, len: t.length, min: min, ref: q.ref || '' };
  }

  function coachRecordReading(layer, correct) {
    var C = coachState();
    var e = C.read[layer] || { h: [] };
    e.h = (e.h || []).concat([!!correct]).slice(-8);
    e.n = (e.n || 0) + 1;
    if (correct) e.ok = (e.ok || 0) + 1;
    C.read[layer] = e;
    persist();
    return coachReadMastery(layer);
  }
  function coachDueWords(date) {
    var d = date || todayKey(), C = coachState();
    return Object.keys(C.wordWrong)
      .filter(function (k) { return C.wordWrong[k].due <= d; })
      .map(function (k) { return Object.assign({ id: k }, C.wordWrong[k]); });
  }
  function weakLayers() {
    return (window.YW_COACH_LAYERS || []).map(function (l) {
      return { key: l.key, label: l.label, pct: coachReadMastery(l.key) };
    }).sort(function (a, b) { return a.pct - b.pct; });
  }

  /* ---------- 弱点：把专项考点接进 BOSS 通关 ----------
   * 光练不加成，孩子没有理由去练；所以每只 boss 认一个弱点，弱点练到门槛就带加成出战：
   *   阅读类（某一层）→ 我方 +1 颗心（看懂了题意，少挨一下）
   *   生词类（认记背默）→ boss −1 颗心（字认准了，出手更重）
   * 门槛随难度抬高（普通 50 / 噩梦 65 / 地狱 80）：
   * 想打更难的档，就得先把这一档的短板再练上去，练习和通关互为因果。
   */
  var BOSS_WEAK = {
    u1: { kind: 'read', layer: 'info',   tip: '它把关键句藏在段落里，先练「找信息」' },
    u2: { kind: 'read', layer: 'gist',   tip: '它说话绕圈，先练「概括内容」' },
    u3: { kind: 'read', layer: 'word',   tip: '它爱换词糊弄人，先练「理解词句」' },
    u4: { kind: 'read', layer: 'feel',   tip: '它专挑心情下手，先练「体会情感」' },
    u5: { kind: 'read', layer: 'craft',  tip: '它的招都是花样，先练「赏析方法」' },
    u6: { kind: 'read', layer: 'lesson', tip: '它绕完还要问你道理，先练「感悟启示」' },
    u7: { kind: 'word', layer: '',       tip: '它烧的是字，先把生词默写练稳' },
    u8: { kind: 'word', layer: '',       tip: '它把词语撞散，先把生词默写练稳' },
    midterm: { kind: 'word', layer: '',  tip: '它把词序打乱，先把生词默写练稳' },
    final: { kind: 'read', layer: '',    tip: '它六层通考，先把最弱的那一层补上' },
  };
  var WEAK_NEED = { normal: 50, nightmare: 65, hell: 80 };
  var WORD_COVER = 8;   // 生词弱点按「至少练过 8 个词」折算，防止只默对 1 个词就满格
  function layerLabel(key) {
    var l = (window.YW_COACH_LAYERS || []).filter(function (x) { return x.key === key; })[0];
    return l ? l.label : '阅读';
  }
  // 生词总体掌握：练过的词平均分 × 覆盖系数（练够 8 个词才计满分）
  function coachWordStat() {
    var C = coachState(), ids = Object.keys(C.words).filter(function (id) {
      return (C.words[id].n || 0) > 0;
    });
    var avg = ids.length
      ? Math.round(ids.reduce(function (n, id) { return n + (C.words[id].pct || 0); }, 0) / ids.length)
      : 0;
    var pct = Math.round(avg * Math.min(1, ids.length / WORD_COVER));
    return { count: ids.length, cover: WORD_COVER, avg: avg, pct: pct };
  }
  // 阅读六层综合：只算动过手的层，一层没练时是 0，不是「默认满分」
  function coachReadOverall() {
    var ps = [];
    (window.YW_COACH_LAYERS || []).forEach(function (l) {
      if (hasLayerTry(l.key)) ps.push(coachReadMastery(l.key));
    });
    if (!ps.length) return 0;
    return Math.round(ps.reduce(function (a, b) { return a + b; }, 0) / ps.length);
  }
  function hasLayerTry(key) {
    var e = coachState().read[key];
    return !!(e && (e.n || 0) > 0);
  }
  function bossWeakInfo(key, league) {
    var w = BOSS_WEAK[key] || BOSS_WEAK.u1;
    var pct, label;
    if (w.kind === 'word') {
      pct = coachWordStat().pct;
      label = '生词默写';
    } else if (w.layer) {
      pct = coachReadMastery(w.layer);
      label = layerLabel(w.layer);
    } else {
      pct = coachReadOverall();
      label = '六层综合';
    }
    var need = WEAK_NEED[league] || WEAK_NEED.normal;
    return {
      key: key, kind: w.kind, layer: w.layer || '', label: label, league: league,
      pct: pct, need: need, gap: Math.max(0, need - pct), ready: pct >= need,
      perk: w.kind === 'word' ? 'bosshp' : 'myhp',
      perkText: w.kind === 'word' ? 'boss 少 1 颗心' : '出战多 1 颗心',
      tip: w.tip,
    };
  }
  // 哪只 boss 把某一层（或生词）当弱点——练习面板上用来点名，避免文案和映射走偏
  function bossForWeak(kind, layer) {
    var keys = Object.keys(BOSS_WEAK);
    for (var i = 0; i < keys.length; i++) {
      var w = BOSS_WEAK[keys[i]];
      if (w.kind !== kind) continue;
      if (kind === 'word') return keys[i];
      if (w.layer === layer) return keys[i];
    }
    return '';
  }
  // 弱点已破时把加成落到这一场的血条上（心数永远不超过题数）
  function applyWeakBuff(spec, weak) {
    if (!spec || !weak || !weak.ready) return spec;
    if (weak.perk === 'myhp') spec.myHp = (Number(spec.myHp) || 0) + 1;
    else spec.bossHp = Math.max(1, (Number(spec.bossHp) || 1) - 1);
    return spec;
  }
  // 生词组卷：先到期的错字，再从没练过的词里挑，最后才是已经练得不错的
  function coachWordSet(bookId, n) {
    var all = (window.YW_COACH_WORDS || []).filter(function (w) { return w.book === bookId; });
    if (all.length < (n || 4)) all = (window.YW_COACH_WORDS || []).slice();
    var C = coachState(), due = {};
    Object.keys(C.wordWrong).forEach(function (k) { due[C.wordWrong[k].word] = 1; });
    var pool = all.map(function (w) {
      var e = C.words[w.id] || {};
      var s = (due[w.word] ? -100 : 0) + (e.n ? (e.pct || 0) : 50) + Math.random() * 6;
      return { w: w, s: s };
    }).sort(function (a, b) { return a.s - b.s; });
    return pool.slice(0, n || 4).map(function (x) { return x.w; });
  }
  // 「认 / 记 / 背」三步答对只把掌握度推到 40：认得出不等于写得对，
  // 想过弱点门槛（≥50）必须真的在「默」这一步默对一次。
  function coachWordDrill(id, ok) {
    if (!ok) return coachWordMastery(id);
    var C = coachState();
    var e = C.words[id] || { pct: 0, n: 0, ok: 0, wrongChars: {} };
    e.drill = (e.drill || 0) + 1;
    e.pct = Math.max(e.pct || 0, Math.min(40, 12 + (e.drill - 1) * 7));
    C.words[id] = e;
    persist();
    return e.pct;
  }

  // 当前册次：组卷、单元名、BOSS 卡都依赖它；切档案/切年级后必须同步
  function syncBookContext() {
    if (!window.YW_BOOK_OF || !S) return;
    var b = window.YW_BOOK_OF(S.grade, S.term);
    window.__YW_CURRENT_BOOK__ = b ? b.id : '';
    if (b) {
      var CN = ['零', '一', '二', '三', '四', '五', '六'];
      window.YW_EDITION = (CN[b.grade] || b.grade) + '年级' + b.term + '册 · 人教统编版';
    }
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

  // 老档案没有 qstat（这个字段是 2026-11-14 修「订正刷砖」时加的）。
  // 升级当天要把「今天已经答过的题」补记进去，否则今天再订正同一题会被当成第一次，
  // 白送一块砖、把今日正确率也算多一次。
  function rebuildQstat(p) {
    if (p.qstat && Object.keys(p.qstat).length) return;
    var t = todayKey();
    p.qstat = {};
    (p.attempts || []).forEach(function (a) {
      if (!a || a.d !== t || !a.q) return;
      var qs = p.qstat[a.q];
      if (!qs) qs = p.qstat[a.q] = { d: t, seen: true, scored: false };
      // 旧版只要答对就发砖，所以今天答对过的题一律视为已计分
      if (a.ok) qs.scored = true;
    });
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
    rebuildQstat(p);
    return p;
  }

  function buildRoot(parsed) {
    if (!parsed) return rootDefaults();
    var r;
    if (parsed.profiles) {
      r = parsed;
      r.v = 3;
    } else {
      // 旧版单使用者数据自动迁成第一个档案，历史记录不丢；原 spaceId 原样保留，
      // 不清算旧存档码，避免升级瞬间把已经在用的云端记录变成孤岛。
      var legacy = Object.assign({}, parsed);
      var id = legacy.spaceId || randomSpaceId();
      r = { v: 3, activeId: id, profiles: {} };
      r.profiles[id] = normalizeProfile(legacy, id, '学习者');
    }
    if (!r.profiles) r.profiles = {};
    var ids = Object.keys(r.profiles);
    ids.forEach(function (id) { r.profiles[id] = normalizeProfile(r.profiles[id], id, '学习者'); });
    // 没有身份、或指向的档案已不存在 → 留给启动流程弹身份选择
    if (!r.activeId || !r.profiles[r.activeId]) r.activeId = null;
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
    if (root.activeId && root.profiles[root.activeId]) {
      S = root.profiles[root.activeId];
      guest = false;
    } else {
      // 还没选身份：先挂一份临时游客态，避免上层拿到 null
      S = guestState();
      guest = true;
    }
    // 老存档的战利品没有 uid，启动就补齐，否则分解按钮不会出现
    if (!guest) ensureLootIds();
    syncBookContext();
    // 已经在学后面的孩子：把之前的课按已通关补齐，别被闸门挡在门外
    if (!guest) seedGates();
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

  /* ---------- 本周回看：一周抽一次，专治「当天做对、一周后忘光」 ---------- */
  // 键取所在周的周一日期，跨周自动换新，不依赖服务器时间。
  function weekKey(date) {
    var d = date || todayKey();
    var parts = String(d).split('-');
    var dt = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
    var dow = dt.getUTCDay();                 // 0=周日
    var back = (dow + 6) % 7;                 // 周一为一周之始
    dt.setUTCDate(dt.getUTCDate() - back);
    return dt.toISOString().slice(0, 10);
  }
  // 本周做过的题：最近 7 天作答日志去重。
  // 排序优先级：真错过的最该回看；其次是「只做对过一次、再没被验证」的——
  // 这类最危险，孩子自己觉得会，其实只是当时记住了。
  function weekPool() {
    var today = todayKey();
    var since = addDays(today, -6);
    var seenId = {}, okCount = {}, wrongCount = {}, lastDate = {};
    (S.attempts || []).forEach(function (a) {
      if (!a || !a.d || a.d < since) return;
      seenId[a.q] = 1;
      if (a.ok) okCount[a.q] = (okCount[a.q] || 0) + 1;
      else wrongCount[a.q] = (wrongCount[a.q] || 0) + 1;
      if (!lastDate[a.q] || a.d > lastDate[a.q]) lastDate[a.q] = a.d;
    });
    return Object.keys(seenId).filter(function (id) { return !!window.YW_Q_BY_ID[id]; })
      .map(function (id) {
        return {
          id: id,
          wrong: wrongCount[id] || 0,
          ok: okCount[id] || 0,
          // 分数越小越靠前：错过一次 -3，只对过一次 +2（没被第二次验证）
          score: (wrongCount[id] ? -3 * wrongCount[id] : 0) + (okCount[id] <= 1 ? 2 : 0),
          last: lastDate[id] || '',
        };
      });
  }
  function weekRecap() {
    var pool = weekPool();
    var order = pool.slice().sort(function (a, b) {
      if (a.score !== b.score) return a.score - b.score;
      return a.last < b.last ? -1 : (a.last > b.last ? 1 : 0);   // 同一档里先看更早做的
    });
    var ids = order.slice(0, 10).map(function (x) { return x.id; })
      .filter(function (id) { return !!window.YW_Q_BY_ID[id]; });
    return { done: !!S.weekDone && S.weekDone === weekKey(), pool: pool.length, ids: ids };
  }
  function markWeekDone() {
    S.weekDone = weekKey();
    return persist();
  }

  // meta（可选）：{ slow: 用时明显偏长, switched: 中途改过几次选项 }
  // 用来抓「侥幸做对」——对了不代表会，改三四次、磨了两分钟才蒙对，两天后得再看一眼。
  function recordAnswer(q, selected, correct, isReview, meta) {
    var t = todayKey();
    var type = correct ? '' : classify(q, selected);
    lastGaveBlock = false;

    // 同一道题当天只算一次（2026-11-14 修）：原来只要答对就 +1 砖，导致反复订正同一道错题
    // 可以无限刷砖，同时把今日正确率、知识点掌握度一起刷高。
    // 现在的口径：
    //   · 统计与掌握度按「当天第一次作答」——订正不重复计入，正确率是真实的首次正确率
    //   · 砖按「当天第一次答对」发放——第一次订正对仍给 1 块，之后重复订正不再给
    var qs = S.qstat[q.id];
    if (!qs || qs.d !== t) { qs = S.qstat[q.id] = { d: t, seen: false, scored: false }; }
    var firstToday = !qs.seen;
    if (firstToday) qs.seen = true;

    // 作答日志保留每一次（错题分析要取「上次错选的是哪一项」），但它不参与计分
    S.attempts.push({ q: q.id, d: t, ok: !!correct, t: type, s: selected });
    if (S.attempts.length > 200) S.attempts = S.attempts.slice(-200);

    if (firstToday) {
      (S.kpHistory[q.kp] = S.kpHistory[q.kp] || []).push(!!correct);
      if (S.kpHistory[q.kp].length > 12) S.kpHistory[q.kp] = S.kpHistory[q.kp].slice(-12);
    }

    var day = S.daily[t] = S.daily[t] || { attempts: 0, correct: 0, careless: 0, blocks: 0 };
    if (firstToday) day.attempts += 1;
    if (firstToday && correct) day.correct += 1;
    if (firstToday && type === 'careless') day.careless += 1;

    if (correct && !qs.scored) {
      qs.scored = true;
      S.blocks += 1;
      day.blocks += 1;
      lastGaveBlock = true;
    }

    S.level = 1 + Math.floor(S.blocks / 20);
    if (S.lastActiveDate !== t) {
      S.streak = (S.lastActiveDate === addDays(t, -1)) ? S.streak + 1 : 1;
      S.lastActiveDate = t;
    }

    var w = S.wrong[q.id];
    if (isReview && w) {
      if (correct) {
        w.okCount = (w.okCount || 0) + 1;
        w.lastDate = t;
        if (w.light) {
          // 轻量复习只要再对一次就毕业：它本来只是「疑似侥幸」，不是真错题
          w.graduated = true;
        } else {
          w.stage = Math.min((w.stage || 0) + 1, REVIEW_GAPS.length - 1);
          w.due = addDays(t, REVIEW_GAPS[w.stage]);
          if (w.okCount >= 2) w.graduated = true;
        }
      } else {
        w.okCount = 0; w.stage = 0; w.due = addDays(t, 1); w.lastDate = t;
        // 轻量条目复习时又错了，说明是真没掌握：升级成常规错题，走完整 1/3/7 复习
        if (w.light) { w.light = 0; w.type = type; countRealWrong(w); }
      }
    } else if (!correct && !q.say) {
      // 「用一句话说出来」不进错题队列：开放题没有标准答案，
      // 写得不全给参考句对照就够了，明天再考同一道没有意义。
      S.wrong[q.id] = w
        ? Object.assign(w, { type: type, stage: 0, due: addDays(t, 1), okCount: 0, count: (w.count || 0) + 1, graduated: false, light: 0, lastDate: t })
        : { qid: q.id, type: type, stage: 0, due: addDays(t, 1), okCount: 0, count: 1, graduated: false, lastDate: t };
    } else if (meta && !w && ((meta.switched || 0) >= 2 || (meta.slow && (meta.switched || 0) >= 1))) {
      // 做对了，但明显在试探：改选两次以上，或者磨了很久还改过。
      // 不记成错题（错题集只放真错的），只排进两天后的轻量复习，再对一次就消失。
      S.wrong[q.id] = {
        qid: q.id, type: '', stage: 0, due: addDays(t, 2), okCount: 0, count: 0,
        graduated: false, lastDate: t, light: 1, why: (meta.switched || 0) >= 2 ? 'switched' : 'slow',
      };
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
      dig: { unit: S.digUnit, lesson: S.digLesson },
      examScope: { midterm: (S.examScope || {}).midterm || [1, 2, 3, 4],
                   final: (S.examScope || {}).final || [1, 2, 3, 4, 5, 6, 7, 8] },
      daily: S.daily || {},
      today: S.daily[d] || { attempts: 0, correct: 0, careless: 0, blocks: 0 },
      // 碎片与战利品有真实价值，换设备必须带走
      shards: S.shards || 0,
      loot: (S.loot || []).map(function (x) {
        return { uid: x.uid, name: x.name, tier: x.tier, from: x.from, at: x.at, league: x.league };
      }),
      // 字块大陆进度：解锁/征服/段位/准备度是长期成长，必须能换设备带走。
      // 券与连对是每日配额，恢复时只在「快照日期就是今天」才生效。
      coach: (function () { var C = coachState(); return { read:C.read, words:C.words, wordWrong:C.wordWrong, due:C.due }; })(),
      league: (function () {
        var L = leagueState();
        return {
          unlocked: L.unlocked, conquest: L.conquest, train: L.train,
          xp: L.xp || 0, pity: L.pity || 0,
          // 轮次也要带走：换台设备接着打，不能把「这一轮已经领过的礼物」又领一遍
          lap: L.lap, wins: L.wins,
          tickets: L.tickets, combo: L.combo || 0, bonusDay: L.bonusDay || '',
        };
      })(),
      mastery: allMastery(),
      // 掌握度的原始作答序列（每位一个 0/1 字符，最多 12 位，与 kpHistory 上限一致）。
      // 只存 0/1，不存题干也不存答案；体积约 150 字节，换设备后掌握度能逐位复原，
      // 连加权窗口都与原机一致。旧存档没有这个字段时走原来的近似恢复。
      kpH: (function () {
        var o = {};
        Object.keys(S.kpHistory).forEach(function (k) {
          var h = S.kpHistory[k];
          if (h && h.length) o[k] = h.slice(-12).map(function (x) { return x ? '1' : '0'; }).join('');
        });
        return o;
      })(),
      wrong: Object.keys(S.wrong).filter(function (id) { return !S.wrong[id].graduated; })
        .map(function (id) {
          return { q: id, t: S.wrong[id].type, s: S.wrong[id].stage, due: S.wrong[id].due,
                   l: S.wrong[id].light ? 1 : 0 };
        }),
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
    if (p.progress && validUnit(p.progress.unit)) {
      S.progress.unit = Number(p.progress.unit);
      S.progress.lesson = normalizeLesson(S.progress.unit, p.progress.lesson, false);
    }
    if (p.dig && validUnit(p.dig.unit)) {
      S.digUnit = Number(p.dig.unit);
      S.digLesson = normalizeLesson(S.digUnit, p.dig.lesson, true);
    }
    if (p.examScope) S.examScope = p.examScope;
    if (p.coach) { var C = coachState(); ['read','words','wordWrong'].forEach(function(k){ if (p.coach[k]) C[k] = p.coach[k]; }); }
    // 碎片与战利品：快照是「当天全量」，以快照为准；老 loot 没有 uid 时补齐
    if (typeof p.shards === 'number') S.shards = p.shards;
    if (p.loot) {
      S.loot = p.loot.map(function (x) {
        return { uid: x.uid, name: x.name, tier: x.tier, from: x.from, at: x.at, league: x.league };
      });
      ensureLootIds();
    }
    // 字块大陆：长期成长取并集 / 取较大值，避免旧设备的一日快照把新进度盖回去；
    // 每日券只有快照日期就是今天才接管。
    if (p.league) {
      var L = leagueState();
      ['unlocked', 'conquest', 'train'].forEach(function (k) {
        var src = p.league[k] || {};
        Object.keys(src).forEach(function (key) {
          // 解锁只能从 false 升到 true，不能被旧快照的 false 盖回去
          if (k === 'unlocked') { if (src[key] === true) L[k][key] = true; }
          else if (!(key in L[k])) L[k][key] = src[key];
          else if (k === 'train' && (src[key].pct || 0) > (L[k][key].pct || 0)) L[k][key] = src[key];
        });
      });
      if (typeof p.league.xp === 'number') L.xp = Math.max(L.xp || 0, p.league.xp);
      if (typeof p.league.pity === 'number') L.pity = Math.max(L.pity || 0, p.league.pity);
      // 轮次只往前不回头：旧设备的一日快照不能把本机已经进到的下一轮盖回去
      if (p.league.lap) {
        LEAGUE_KEYS.forEach(function (k) {
          var v = Number(p.league.lap[k]) || 0;
          if (v > (L.lap[k] || 1)) L.lap[k] = v;
        });
      }
      if (p.league.wins) {
        Object.keys(p.league.wins).forEach(function (key) {
          var v = Number(p.league.wins[key]) || 0;
          if (!(key in L.wins) || v > (L.wins[key] || 0)) L.wins[key] = v;
        });
      }
      if (p.date === todayKey() && p.league.tickets) {
        L.d = p.date; L.tickets = p.league.tickets;
        L.combo = p.league.combo || 0; L.bonusDay = p.league.bonusDay || '';
      }
    }
    if (typeof p.grade === 'number') S.grade = p.grade;
    if (p.term) S.term = p.term;
    if (p.daily) Object.keys(p.daily).forEach(function (d) { S.daily[d] = p.daily[d]; });
    if (p.today && p.date) S.daily[p.date] = p.today;
    if (p.wrong) {
      p.wrong.forEach(function (w) {
        if (!window.YW_Q_BY_ID[w.q]) return;
        // okCount 与 stage 同步：stage 就是「已经复习对过几次」，丢掉它会让换设备后的
        // 错题永远停在「还差一次才毕业」，复习了两遍也不出池。
        S.wrong[w.q] = { qid: w.q, type: w.t, stage: w.s || 0, due: w.due,
                         okCount: Math.min(w.s || 0, 2), count: 1, graduated: false };
      });
    }

    // 掌握度：优先用快照里的原始 0/1 序列精确复原（新存档都带 kpH）。
    // 本机已经有同一知识点的历史时保留本机的，避免同一天两台设备互相覆盖出重复条目。
    var kpRestored = false;
    if (p.kpH) {
      Object.keys(p.kpH).forEach(function (k) {
        var str = String(p.kpH[k] || '');
        if (!str) return;
        if (S.kpHistory[k] && S.kpHistory[k].length) return;
        S.kpHistory[k] = str.split('').map(function (c) { return c === '1'; });
        kpRestored = true;
      });
    }

    if (p.attempts && p.date) {
      var qBy = window.YW_Q_BY_ID, seenToday = {}, okToday = {};
      p.attempts.forEach(function (a) {
        var q = qBy[a.q]; if (!q) return;
        if (a.ok) okToday[a.q] = 1;
        if (seenToday[a.q]) return;
        seenToday[a.q] = 1;
        // 老存档没有 kpH，只能按「当天每题第一次」近似补；新存档已精确复原，不再重复追加
        if (!kpRestored) (S.kpHistory[q.kp] = S.kpHistory[q.kp] || []).push(!!a.ok);
      });
      Object.keys(S.kpHistory).forEach(function (k) {
        S.kpHistory[k] = S.kpHistory[k].slice(-12);
      });
      // 当天已计分的题也要跟着回来：否则换设备后把上午做过的题再做一遍，
      // 「当天每题最多一块砖」会被绕过，白送砖。
      Object.keys(seenToday).forEach(function (qid) {
        var cur = S.qstat[qid];
        if (cur && cur.d === p.date) {
          cur.seen = true;
          if (okToday[qid]) cur.scored = true;   // 只升不降，不会把本机已发的砖又退回去
        } else {
          S.qstat[qid] = { d: p.date, seen: true, scored: !!okToday[qid] };
        }
      });
      S.attempts = S.attempts.concat(p.attempts.map(function (a) {
        return { q: a.q, d: p.date, ok: !!a.ok, t: a.t || '', s: -1 };
      })).slice(-200);
    }
    if (p.date) S.saves[p.date] = p;
    persist();
  }

  /* ---------- 组卷：日常 / 回忆录 / 重点 / 全面 / 专项 / 期中期末 ---------- */
  function isWrong(qid) {
    var w = S.wrong[qid];
    // 轻量条目（做对但明显在猜）不进错题集，免得家长看到「错题一堆」却没有一道真错
    return !!(w && !w.graduated && !w.light);
  }
  // 轻量复习条目：做对了但改选多次/磨太久，两天后回看一眼
  function isPending(qid) {
    var w = S.wrong[qid];
    return !!(w && !w.graduated && w.light);
  }
  function countRealWrong(w) {
    if (w) w.count = (w.count || 0) + 1;
    return w;
  }
  // 最近做过的题加惩罚分，让它排到后面——同一只 boss 反复打才不会总撞同样的题。
  // 惩罚只影响抽题顺序，不碰掌握度、计分和错题。
  function rank(pool, recent) {
    var avoid = {};
    if (recent) (recent || []).forEach(function (id) { avoid[id] = 1; });
    return pool.map(function (q) {
      var penalty = avoid[q.id] ? 60 : 0;
      return { q: q, score: masteryOf(q.kp) + Math.random() * 40 + penalty };
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

  // 三档题库差异化：普通=基础维度，噩梦=理解应用维度为主、基础穿插，地狱=跨单元混错题与薄弱点。
  // 只是选题策略不同，判定、计分、错题、掌握度全部沿用原口径。
  var LEAGUE_DIMS = {
    // 普通档也放句子/阅读/修辞：只练字词的话，孩子打到通关也没碰到真正的理解题。
    normal: ['pinyin', 'zici', 'beisong', 'ciyu', 'xingjinzi', 'duoyinzi', 'yicuoyin', 'gushi',
             'yuedu', 'gaini', 'xiuci', 'biaodian', 'deDiDe', 'xinxi', 'qinggan'],
    nightmare: ['juzi', 'yuedu', 'changshi', 'bingju', 'biaodian', 'deDiDe',
                'lijie', 'wenyan', 'guancha', 'ciyu', 'gaini', 'qishi', 'renwu', 'xiuci'],
  };
  function inDims(q, dims) { return dims.indexOf(q.dim) >= 0 || dims.indexOf(q.kp) >= 0; }
  // 题库分档：普通只用原有基础题；噩梦/地狱以扩展能力题为主，掺入基础题防止断层。
  function tierPool(pool, league, n) {
    // 普通档也要掺难题：原来把带 tier 的题全排除，孩子打普通 boss 永远只见到基础题。
    // 现在普通档按 7:3 混基础与提高题，疆梦/地狱仍以各自 tier 为主。
    if (!league || league === 'normal') {
      var plain0 = pool.filter(function (q) { return !q.tier; });
      var hard0 = pool.filter(function (q) { return !!q.tier; });
      var wantHard0 = Math.min(hard0.length, Math.max(1, Math.round((n || 6) * 0.3)));
      return rank(plain0).slice(0, Math.max(0, (n || plain0.length) - wantHard0))
        .concat(rank(hard0).slice(0, wantHard0));
    }
    var main = league === 'hell' ? 'hell' : 'nightmare';
    var primary = pool.filter(function (q) { return q.tier === main; });
    var secondary = pool.filter(function (q) { return q.tier && q.tier !== main; });
    var plain = pool.filter(function (q) { return !q.tier; });
    var pm = Math.ceil(n * 0.6), ps = Math.ceil(n * 0.25);
    var out = rank(primary).slice(0, pm)
      .concat(rank(secondary).slice(0, ps))
      .concat(rank(plain).slice(0, Math.max(0, n - pm - ps)));
    if (out.length < n) {
      var used = {};
      out.forEach(function (q) { used[q.id] = 1; });
      out = out.concat(rank(pool.filter(function (q) { return !used[q.id]; })).slice(0, n - out.length));
    }
    return out.slice(0, n);
  }
  function leaguePick(pool, league, n, recent) {
    n = n || pool.length;
    pool = tierPool(pool, league, n);
    if (!pool.length) return [];
    if (!league || league === 'normal') {
      // 普通档优先「认字读词」这类地基：LEAGUE_DIMS.normal 后来把阅读/修辞也纳进来了，
      // 用它当偏好等于没偏好，普通 boss 里基础题会被理解题挤到一半以下。
      var CORE = ['pinyin', 'zici', 'beisong', 'ciyu', 'xingjinzi', 'duoyinzi', 'yicuoyin'];
      var base = pool.filter(function (q) {
        return CORE.indexOf(q.dim) >= 0 || CORE.indexOf(q.kp) >= 0;
      });
      var used = {};
      base.forEach(function (q) { used[q.id] = 1; });
      return rank(base, recent).concat(rank(pool.filter(function (q) { return !used[q.id]; }), recent)).slice(0, n);
    }
    if (league === 'nightmare') {
      var deep = rank(pool.filter(function (q) { return inDims(q, LEAGUE_DIMS.nightmare); }), recent);
      var seen = {};
      pool.filter(function (q) { return inDims(q, LEAGUE_DIMS.nightmare); })
          .forEach(function (q) { seen[q.id] = 1; });
      var rest = rank(pool.filter(function (q) { return !seen[q.id]; }), recent);
      var out = [];
      while (out.length < n && (deep.length || rest.length)) {
        if (deep.length && out.length < n) out.push(deep.shift());
        if (deep.length && out.length < n) out.push(deep.shift());
        if (rest.length && out.length < n) out.push(rest.shift());
      }
      return out.slice(0, n);
    }
    var ids = Object.keys(S.wrong).filter(isWrong);
    var wrongQ = rank(ids.map(function (id) { return window.YW_Q_BY_ID[id]; })
      .filter(function (q) { return q && pool.indexOf(q) >= 0; }), recent);
    var s1 = {}; wrongQ.forEach(function (q) { s1[q.id] = 1; });
    var weak = rank(pool.filter(function (q) { return !s1[q.id] && masteryOf(q.kp) < 60; }), recent);
    var s2 = {}; weak.forEach(function (q) { s2[q.id] = 1; });
    var other = pool.filter(function (q) { return !s1[q.id] && !s2[q.id]; });
    return wrongQ.concat(weak, balanced(other, Math.max(0, n - wrongQ.length - weak.length))).slice(0, n);
  }

  function buildRound(spec) {
    spec = spec || {};
    var mode = spec.mode || 'daily';
    var n = spec.count || (mode === 'exam' ? 10 : mode === 'full' ? 10 : 5);
    // 默认题池锁定当前册次：回忆录/过往专项才用全库，避免三上题混进三下 BOSS 战
    var all = spec.scope === 'past' || mode === 'past'
      ? window.YW_QUESTIONS
      : window.YW_QUESTIONS.filter(function (q) { return window.YW_IS_CURRENT ? window.YW_IS_CURRENT(q, S.grade, S.term) : true; });
    var wrongIds = Object.keys(S.wrong).filter(isWrong);
    var picked = [], label = '今日挖掘', note = '';

    if (mode === 'daily') {
      var digU = spec.unit || S.digUnit || S.progress.unit;
      var digL = (spec.lesson !== undefined && spec.lesson !== null)
        ? spec.lesson : (S.digLesson || S.progress.lesson);
      var due = dueWrong().slice(0, 2).map(function (id) { return window.YW_Q_BY_ID[id]; }).filter(Boolean);
      var seen = {}; due.forEach(function (q) { seen[q.id] = 1; });
      var need = Math.max(0, n - due.length);
      var cur = window.YW_currentQuestions(S.grade, S.term).filter(function (q) { return !seen[q.id]; });
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
      label = '回忆录 · 复习';
      var past = window.YW_pastQuestions(S.grade, S.term);
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
      picked = balanced(spec.scope === 'past' ? window.YW_pastQuestions(S.grade, S.term) : window.YW_currentQuestions(S.grade, S.term), n);
      note = '按单元 / 年级均衡覆盖';
    } else if (mode === 'weekly') {
      label = '本周回看';
      var recap = weekRecap();
      picked = recap.ids.map(function (id) { return window.YW_Q_BY_ID[id]; })
        .filter(Boolean).slice(0, spec.count || 10);
      note = '这一周练过的题里抽 ' + picked.length + ' 道，看还在不在';
    } else if (mode === 'topic') {
      label = spec.training ? '训练场 · 单元小 boss'
            : spec.bossKey ? 'BOSS 战 · 单元小 boss' : '专项复习';
      var tp = all.filter(function (q) {
        var okKp = spec.kp ? q.kp === spec.kp : true;
        var okDim = spec.dim ? q.dim === spec.dim : true;
        var okUnit = spec.units ? spec.units.indexOf(q.unit) >= 0 : true;
        var okScope = spec.scope === 'past' ? q.grade < S.grade
                    : spec.scope === 'current' ? q.grade === S.grade : true;
        return okKp && okDim && okUnit && okScope;
      });
      // 地狱跨单元：不再只出本单元，扩到已学到单元的整册范围
      if (spec.league === 'hell') {
        tp = all.filter(function (q) {
          return q.grade === S.grade && q.unit <= (S.progress.unit || 8) &&
                 (!spec.kp || q.kp === spec.kp) && (!spec.dim || q.dim === spec.dim);
        });
      }
      var recentIds = spec.bossKey ? (leagueState().recent[spec.league + ':' + spec.bossKey] || []) : [];
      picked = leaguePick(tp, spec.league, n, recentIds);
      note = spec.league === 'hell' ? '地狱 · 跨单元混合 + 错题/薄弱点'
           : spec.league === 'nightmare' ? '噩梦 · 句子阅读方法加量，基础穿插'
           : spec.dim ? ((window.YW_DIMS[spec.dim] || {}).label || '所选维度')
           : spec.kp ? ((window.YW_KP[spec.kp] || {}).label || '所选知识点') : '基础字词句';
    } else if (mode === 'lesson') {
      // 本课闯关：三类题按固定配比各抽几道，一趟把三道关一起考掉，
      // 比「分三关各点一次」少三次进出，孩子更容易接受。
      // 已经过掉的关不再重复出题——只补还差的那几关，否则孩子要陪着做一遍已经会的东西。
      var lu = Number(spec.unit), ll = Number(spec.lesson);
      label = '第 ' + ll + ' 课 · 过关';
      var lp = all.filter(function (q) { return q.unit === lu && q.lesson === ll; });
      var wPool = lp.filter(function (q) { return !q.recite && !q.passage; });
      var bPool = lp.filter(function (q) { return !!q.recite; });
      var rPool = lp.filter(function (q) { return !!q.passage; });
      var gt = gateOf(ll);
      var parts = [], missName = [];
      // 阅读类一律留一个位置给「用一句话说出来」：认得出 ≠ 说得清，
      // 所以选择题从 3 道减到 2 道，加 1 道自己组织的，总数仍是 8 道。
      var sayQ = (window.YW_SAY_BY_LESSON || {})[ll] || null;
      var rPick = sayQ ? 2 : 3;
      if (!gt.w) { parts.push(rank(wPool).slice(0, 3)); missName.push('字词'); }
      if (!gt.b) { parts.push(rank(bPool).slice(0, 2)); missName.push('背诵'); }
      if (!gt.r) {
        var rl = rank(rPool).slice(0, rPick);
        if (sayQ) rl.push(sayQ);
        parts.push(rl); missName.push('阅读');
      }
      if (!parts.length) {
        // 三关都过了还来闯：当复测，三类全考一遍
        parts = [rank(wPool).slice(0, 3), rank(bPool).slice(0, 2), rank(rPool).slice(0, rPick)];
        if (sayQ) parts[2].push(sayQ);
        missName = ['字词', '背诵', '阅读'];
      }
      picked = [].concat.apply([], parts);
      note = '这一趟考' + missName.join('、') + '，到线就算过关';
    } else if (mode === 'exam') {
      var ex = window.YW_EXAM[spec.examKey || 'midterm'];
      label = spec.training ? '训练场 · ' + ex.label
            : spec.bossKey ? ('BOSS 战 · ' + ex.label) : ex.label;
      var units = S.examScope[ex.key] || ex.units;
      var epool = spec.league === 'hell'
        ? window.YW_currentQuestions(S.grade, S.term)
        : window.YW_currentQuestions(S.grade, S.term, units);
      var examRecent = spec.bossKey ? (leagueState().recent[spec.league + ':' + spec.bossKey] || []) : [];
      picked = leaguePick(epool, spec.league, spec.count || ex.count, examRecent);
      note = (spec.league === 'hell' ? '地狱 · 全册随机 + 错题薄弱' : ex.desc) +
             ' · 当前范围：第 ' + (spec.league === 'hell' ? '1–' + (S.progress.unit || 8) : units.join('、')) + ' 单元';
    }

    var t = todayKey();
    if (!S.fillDay || S.fillDay.d !== t) S.fillDay = { d: t, n: 0, kinds: [] };
    if (!S.fillDay.kinds) S.fillDay.kinds = [];
    var typeLeft = Math.max(0, 2 - (S.fillDay.n || 0)); // 只约束打字题

    // 输出题呈现：spot 挑错字（点一下）/ fill 补一个字（打字）/ order 排顺序（点选）。
    // 按「今天还没出过的优先」轮换，避免连着几趟都是同一种。
    function tryKind(q, k) {
      if (k === 'spot') return !!(q && q.spot);
      if (k === 'fill') return !!(q && q.fill && typeLeft > 0);
      if (k === 'order') return !!(q && q.order);
      return false;
    }
    function outKind(q) {
      if (!q) return null;
      var fresh = ['spot', 'fill', 'order'].filter(function (k) { return S.fillDay.kinds.indexOf(k) < 0; });
      var seen = ['spot', 'fill', 'order'].filter(function (k) { return S.fillDay.kinds.indexOf(k) >= 0; });
      var order = fresh.concat(seen);
      for (var i = 0; i < order.length; i++) if (tryKind(q, order[i])) return order[i];
      return null;
    }

    // 主动补足：以前只靠随机命中，实测每趟平均只有 1.08 道、21% 的趟一道不出。
    // 现在每组都从「本课 → 本单元 → 已学」里找带输出标记的题，替换末尾的普通新题，
    // 补足到两道；到期错题和已做过的题不参与替换。打字题全天仍最多两道。
    if (mode === 'daily') {
      var pool = [];
      var seenPool = {};
      [].concat(typeof inLesson !== 'undefined' ? inLesson : [],
                typeof inUnit !== 'undefined' ? inUnit : [],
                typeof learned !== 'undefined' ? learned : [],
                window.YW_currentQuestions(S.grade, S.term)).forEach(function (q) {
        if (q && !seenPool[q.id]) { seenPool[q.id] = 1; pool.push(q); }
      });
      var pickedIds = {};
      picked.forEach(function (q) { if (q) pickedIds[q.id] = 1; });
      var usedKinds = {};
      picked.forEach(function (q) {
        var k = q && !isWrong(q.id) ? outKind(q) : null;
        if (k) usedKinds[k] = 1;
      });
      var needOut = Math.max(0, 2 - Object.keys(usedKinds).length);
      var candidates = rank(pool.filter(function (q) {
        return q && !pickedIds[q.id] && !isWrong(q.id) && outKind(q);
      }));
      // 同一趟里两道输出题尽量不同类型：先选本趟还没用过的类型
      candidates.sort(function (a, b) {
        return (usedKinds[outKind(a)] ? 1 : 0) - (usedKinds[outKind(b)] ? 1 : 0);
      });
      for (var ci = 0; ci < candidates.length && needOut > 0; ci++) {
        var cand = candidates[ci];
        var candKind = outKind(cand);
        if (usedKinds[candKind]) continue;   // 本趟已有同类型，跳过换下一道
        for (var pi = picked.length - 1; pi >= 0; pi--) {
          var old = picked[pi];
          if (!old || isWrong(old.id) || outKind(old)) continue;
          picked[pi] = cand; usedKinds[candKind] = 1; needOut--; break;
        }
      }
    }

    var uniq = {}, items = [], outUsed = 0, typedUsed = 0, kindSeen = {};
    picked.forEach(function (q) {
      if (!q || uniq[q.id]) return;
      uniq[q.id] = 1;
      var review = isWrong(q.id);
      // 背诵题一律要真的写出来，不给四选一——选择题蒙对不等于背下来。
      // 日常练习仍然受「全天两道打字题」的限制，闯关是刻意练，不占这个额度。
      var want = null;
      if (mode === 'lesson') {
        // 闯关是刻意练：背诵题一律要写出来，不给四选一蒙对的机会
        want = (q.recite && q.fill) ? 'fill' : (!review && outUsed < 2 ? outKind(q) : null);
      } else if (!review && mode === 'daily' && outUsed < 2) {
        // 日常仍守「一趟最多两道打字题」：背诵题有 fill 字段，outKind 自然会判成填空
        want = outKind(q);
      } else if (review && q.recite && q.fill && outUsed < 2) {
        // 错过的背诵题再回来时也得写，变成四选一就白复习了
        want = 'fill';
      }
      // 同一趟里同一种输出题只保留一道：随机撞型的第二道降级为普通选择题，
      // 免得孩子连着做两道「挑错字」以为是卡住了。闯关模式例外——两道背诵题就该都填空。
      var kind = (want && (mode === 'lesson' || !kindSeen[want])) ? want : null;
      if (kind) {
        outUsed++; kindSeen[kind] = 1;
        if (kind === 'fill' && mode !== 'lesson') { typedUsed++; S.fillDay.n++; }
        if (mode !== 'lesson' && S.fillDay.kinds.indexOf(kind) < 0) S.fillDay.kinds.push(kind);
      }
      items.push({ q: q, isReview: review, outKind: kind || '' });
    });
    // 记下这一趟的题目，下次打同一个 boss 时这些题会被降权（训练场不记，免得占用正式池）
    if (spec.bossKey && !spec.training) {
      var rk = spec.league + ':' + spec.bossKey;
      var LR = leagueState();
      var last = (LR.recent[rk] || []).slice();
      items.forEach(function (it) { last = last.filter(function (id) { return id !== it.q.id; }); });
      items.forEach(function (it) { last.push(it.q.id); });
      LR.recent[rk] = last.slice(-Math.max(n * 2, 12));
    }
    if (outUsed || spec.bossKey) persist();
    return { mode: mode, label: label, note: note, items: items, count: items.length };
  }

  function pickRound(n) { return buildRound({ mode: 'daily', count: n || 5 }); }

  /* ---------- 身份（昵称）---------- */
  function profileList() {
    return Object.keys(root.profiles).map(function (id) {
      var p = root.profiles[id];
      return {
        id: id, name: p.name, blocks: p.blocks || 0, level: p.level || 1,
        wrong: Object.keys(p.wrong || {}).filter(function (q) {
          return !p.wrong[q].graduated && !p.wrong[q].light;
        }).length,
        pending: Object.keys(p.wrong || {}).filter(function (q) {
          return !p.wrong[q].graduated && p.wrong[q].light;
        }).length,
        progress: p.progress, active: !guest && id === root.activeId,
      };
    });
  }
  function findByName(name) {
    var k = nickKey(name);
    if (!k) return null;
    var hit = Object.keys(root.profiles).filter(function (id) {
      return nickKey(root.profiles[id].name) === k;
    })[0];
    return hit || null;
  }
  async function switchProfile(id) {
    if (!root.profiles[id]) throw new Error('找不到这个使用者');
    root.activeId = id;
    S = root.profiles[id];
    guest = false;
    seedGates();     // 换到别人的档案也补一次，别让老进度被闸门挡住
    await persist();
    return S;
  }
  // 昵称即身份：新建时 spaceId 由昵称推导，同名（归一化后）直接接上原来那份，不重复建档
  async function createProfile(name) {
    var n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 12);
    if (!n) throw new Error('先给这个使用者起个昵称');
    var existed = findByName(n);
    if (existed) return switchProfile(existed);
    var p = profileDefaults(n);
    p.spaceId = deriveSpaceId(n);
    root.profiles[p.id] = p;
    root.activeId = p.id;
    S = p;
    guest = false;
    await persist();
    return p;
  }
  // 改名不改 spaceId：改的是称呼，不动的存档归属，避免改个错别字就把进度丢在半路
  async function renameProfile(name, id) {
    var n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 12);
    if (!n) throw new Error('名字不能为空');
    var target = (id && root.profiles[id]) ? root.profiles[id] : S;
    target.name = n;
    await persist();
  }
  async function deleteProfile(id) {
    if (!root.profiles[id]) return;
    delete root.profiles[id];
    if (root.activeId === id) {
      root.activeId = null;
      S = guestState();
      guest = true;
    }
    await persist();
  }
  // 进入游客：只练不存。root.activeId 置空，下次打开会重新问一次身份
  async function enterGuest() {
    root.activeId = null;
    S = guestState();
    guest = true;
    await persist();
    return S;
  }
  function needIdentity() { return !root.activeId; }

  /* ---------- 未完成的这一趟（待办） ---------- */
  // 只存题号与进度，不存题干；题库调整后仍能还原，且每个使用者各自一份。
  function saveRound(r) {
    if (!r) { S.pendingRound = null; persist(); return; }
    S.pendingRound = {
      spec: r.spec || {},
      label: r.label, note: r.note || '', mode: r.mode,
      isRedo: !!r.isRedo,
      challenge: !!r.challenge,
      battle: r.battle === 'boss' ? 'boss' : '',
      bossKey: r.bossKey || '',
      league: r.league || '',
      training: !!r.training,
      wrongDmg: Number(r.wrongDmg) || 1,
      coach: r.coach || '',
      layer: r.layer || '',
      weak: r.weak || null,
      cw: r.cw || null,
      bossHp: Number(r.bossHp) || 0,
      bossHpMax: Number(r.bossHpMax) || 0,
      myHp: Number(r.myHp) || 0,
      myHpMax: Number(r.myHpMax) || 0,
      fillMode: r.fillMode === 'choice' ? 'choice' : 'fill',
      fillInput: r.fillInput || '',
      orderPicks: (r.orderPicks || []).slice(0, 2),
      items: (r.items || []).map(function (it) {
        return { q: it.q.id, isReview: !!it.isReview, outKind: it.outKind || (it.asFill ? 'fill' : '') };
      }),
      idx: r.idx || 0,
      results: r.results || [],
      selected: r.selected,
      phase: r.phase || 'ask',
    };
    persist();
  }
  function loadRound() {
    var p = S.pendingRound;
    if (!p || p.phase === 'done') return null;
    // 生词闯关没有「题」，进度全在 cw 里；它也要能刷新续上，所以单独放行
    var isWord = p.coach === 'word' && !!p.cw;
    if ((!p.items || !p.items.length) && !isWord) return null;
    var items = (p.items || []).map(function (x) {
      var q = window.YW_Q_BY_ID[x.q];
      return q ? { q: q, isReview: !!x.isReview,
                   outKind: x.outKind || (x.asFill ? 'fill' : '') } : null;
    }).filter(Boolean);
    if (!items.length && !isWord) return null;
    return {
      spec: p.spec || {}, label: p.label || '练习', note: p.note || '',
      mode: p.mode || 'daily', items: items,
      isRedo: !!p.isRedo,
      challenge: !!p.challenge,
      battle: p.battle === 'boss' ? 'boss' : '',
      bossKey: p.bossKey || '',
      league: p.league || '',
      training: !!p.training,
      wrongDmg: Number(p.wrongDmg) || 1,
      coach: p.coach || '',
      layer: p.layer || '',
      weak: p.weak || null,
      cw: p.cw || null,
      bossHp: Number(p.bossHp) || 0,
      bossHpMax: Number(p.bossHpMax) || 0,
      myHp: Number(p.myHp) || 0,
      myHpMax: Number(p.myHpMax) || 0,
      fillMode: p.fillMode === 'choice' ? 'choice' : 'fill',
      fillInput: p.fillInput || '',
      orderPicks: (p.orderPicks || []).slice(0, 2),
      idx: items.length ? Math.min(p.idx || 0, items.length - 1) : 0,
      results: (p.results || []).slice(0, items.length || 99),
      selected: p.selected,
      phase: p.phase === 'feedback' ? 'feedback' : 'ask',
    };
  }
  function clearRound() { S.pendingRound = null; persist(); }

  // 今日挑战徽章：只留在本地档案里做纪念，不加砖、不进云端快照。
  function markChallenge(date) {
    var d = date || todayKey();
    S.badges = S.badges || {};
    var first = !S.badges[d];
    S.badges[d] = true;
    persist();
    return first;
  }
  function hasChallenge(date) { return !!(S.badges || {})[date || todayKey()]; }

  /* ---------- 字块大陆：三难度联赛 ----------
   * 普通 / 噩梦 / 地狱：各自的题库维度、血量容错、每日挑战券。
   * 挑战券用完不代表没得练：训练场无限，练满还能赢回一张（每天最多一张）。
   * 经验与段位是「确定性成长」：哪怕输了、哪怕没掉好礼物，也在往前走。
   */
  var LEAGUES = {
    normal:    { key: 'normal',    name: '普通', tickets: 5, unlockAt: '',          xpMul: 1 },
    nightmare: { key: 'nightmare', name: '噩梦', tickets: 3, unlockAt: 'normal',    xpMul: 2 },
    hell:      { key: 'hell',      name: '地狱', tickets: 1, unlockAt: 'nightmare', xpMul: 3 },
  };
  var LEAGUE_KEYS = ['normal', 'nightmare', 'hell'];
  // boss 心数必须 <= 题数（普通 6/10/14），否则数学上必败。
  var BOSS_HP = {
    normal:    { small: 4, mid: 7,  big: 10 },
    nightmare: { small: 5, mid: 8,  big: 11 },
    hell:      { small: 5, mid: 9,  big: 12 },
  };
  var MY_HP = {
    normal:    { small: 3, mid: 4, big: 5 },
    nightmare: { small: 2, mid: 3, big: 3 },
    hell:      { small: 2, mid: 2, big: 3 },
  };
  var WRONG_DMG = { normal: 1, nightmare: 1, hell: 2 };
  var RANKS = [
    { min: 0,   name: '见习学徒' }, { min: 60,  name: '青铜学徒' },
    { min: 180, name: '白银学者' }, { min: 400, name: '黄金学长' },
    { min: 800, name: '字块大师' },
  ];
  function leagueDefaults() {
    return {
      d: todayKey(),
      tickets: { normal: 5, nightmare: 3, hell: 1 },
      unlocked: { normal: true, nightmare: false, hell: false },
      conquest: {}, pity: 0, xp: 0, train: {}, combo: 0, bonusDay: '',
      // 轮次（周目）：一个难度的 10 只 boss 全打赢后整版重置，礼物可以再掉一轮。
      // lap 记「第几轮」，wins 记「某只 boss 是在哪一轮打赢的」（键：难度:boss）。
      lap: { normal: 1, nightmare: 1, hell: 1 }, wins: {},
    };
  }
  function leagueState() {
    if (!S.league) S.league = leagueDefaults();
    var L = S.league;
    // 只有「每日配额」随日期重置，成长类字段（解锁/征服/经验/保底/准备度）永久保留
    if (!L.tickets || L.d !== todayKey()) {
      L.d = todayKey();
      L.tickets = { normal: 5, nightmare: 3, hell: 1 };
      L.bonusDay = ''; L.combo = 0;
    }
    L.unlocked = L.unlocked || { normal: true, nightmare: false, hell: false };
    L.tickets = L.tickets || { normal: 5, nightmare: 3, hell: 1 };
    L.conquest = L.conquest || {}; L.train = L.train || {};
    L.recent = L.recent || {};   // 每只 boss 最近出过的题，抽题时降权，避免反复撞同一批
    // 轮次：老存档没有 wins 时按「已征服」补一次，避免一夜之间白拿一整套礼物
    if (!L.wins) migrateLapRounds(L);
    L.lap = L.lap || {};
    LEAGUE_KEYS.forEach(function (k) { if (!(L.lap[k] >= 1)) L.lap[k] = 1; });
    // 老存档迁移：旧版准备度的键是「u1」这种裸 bossKey，归到普通难度，别让孩子白练
    Object.keys(L.train).forEach(function (k) {
      if (k.indexOf(':') >= 0) return;
      var dest = 'normal:' + k;
      if (!L.train[dest] || (L.train[k].pct || 0) > (L.train[dest].pct || 0)) L.train[dest] = L.train[k];
      delete L.train[k];
    });
    return L;
  }
  function leagueInfo(k) { return LEAGUES[k] || LEAGUES.normal; }
  function leagueUnlocked(k) { return !!leagueState().unlocked[k]; }
  function leagueLeft(k) { return Math.max(0, leagueState().tickets[k] || 0); }
  function spendTicket(k) {
    var L = leagueState();
    if (!L.unlocked[k] || (L.tickets[k] || 0) <= 0) return false;
    L.tickets[k] -= 1; persist(); return true;
  }
  // 战斗中主动退出：把这张券退回去（没拿到任何进度，退券不会被人刷）
  function refundTicket(k) {
    var L = leagueState();
    if (!LEAGUES[k]) return false;
    L.tickets[k] = (L.tickets[k] || 0) + 1;
    persist(); return true;
  }
  function gainXp(n) {
    var L = leagueState();
    L.xp = (L.xp || 0) + Math.max(0, Math.round(n));
    persist();
    return L.xp;
  }
  function rankInfo() {
    var xp = leagueState().xp || 0, cur = RANKS[0], next = null, i;
    for (i = 0; i < RANKS.length; i++) if (xp >= RANKS[i].min) { cur = RANKS[i]; next = RANKS[i + 1] || null; }
    return {
      name: cur.name, xp: xp, next: next, toNext: next ? Math.max(0, next.min - xp) : 0,
      pct: next ? Math.min(100, Math.round((xp - cur.min) / (next.min - cur.min) * 100)) : 100,
    };
  }
  // 通关记录按「难度:boss」分开，三档各有自己的首次掉落；旧 bossDone 只做总体征服标记
  function isConquered(league, key) { return !!leagueState().conquest[league + ':' + key]; }
  // 逐只解锁：噩梦的某只 boss，必须先打赢普通里的同一只；地狱同理。
  // 训练场不在此限制内——它本来就是拿来准备下一档的。
  function bossUnlocked(league, key) {
    if (league === 'normal') return true;
    var prev = league === 'hell' ? 'nightmare' : 'normal';
    return isConquered(prev, key);
  }
  function prevBossName(league, key) {
    if (league === 'normal') return '';
    return (league === 'hell' ? '噩梦' : '普通') + '里的这只 boss';
  }
  function markConquest(league, key) {
    var L = leagueState(), id = league + ':' + key;
    var first = !L.conquest[id];
    if (first) L.conquest[id] = todayKey();
    // 逐只解锁：打通这一只，只解锁下一难度里的同一只 boss
    var next = null;
    if (first) {
      var i = LEAGUE_KEYS.indexOf(league);
      if (i >= 0 && i < LEAGUE_KEYS.length - 1) {
        next = LEAGUE_KEYS[i + 1];
        L.unlocked[next] = true;   // 兼容旧字段：仅作「该档已开始解锁」标记，不作准入门槛
      }
    }
    gainXp(8 * (leagueInfo(league).xpMul) + (first ? 6 : 0));
    persist();
    return { first: first, unlocked: next, bossKey: key };
  }
  /* ---------- 轮次（周目）：整版重置 ----------
   * 一个难度的 10 只 boss 全部打赢，这一轮就通了：lap + 1，10 只重新变成「本轮没打赢」，
   * 于是又能各掉一次礼物。conquest（永久征服）不动——噩梦/地狱的逐只解锁靠它，
   * 重置绝不能把「已经征服过」洗掉，否则孩子打了半天的进度会莫名回锁。
   * 老存档迁移：把已有的 conquest 当作第 1 轮打过的，若第 1 轮已全清则直接开第 2 轮，
   * 这样不会在一夜之间白送一整套礼物，也算认了老玩家的战绩。
   */
  function lapOf(league) { return Math.max(1, leagueState().lap[league] || 1); }
  function lapDone(league, key) {
    return (leagueState().wins[league + ':' + key] || 0) === lapOf(league);
  }
  function lapState(league) {
    var lap = lapOf(league), W = leagueState().wins || {}, cleared = 0;
    BOSS_KEYS.forEach(function (k) { if ((W[league + ':' + k] || 0) === lap) cleared++; });
    return { lap: lap, cleared: cleared, total: BOSS_KEYS.length, all: cleared >= BOSS_KEYS.length };
  }
  function migrateLapRounds(L) {
    L.wins = {}; L.lap = L.lap || {};
    LEAGUE_KEYS.forEach(function (lg) {
      var all = true;
      BOSS_KEYS.forEach(function (k) {
        if (L.conquest[lg + ':' + k]) L.wins[lg + ':' + k] = 1;
        else all = false;
      });
      // 全清过的直接进第 2 轮（版面是新的），没全清的老老实实待在第 1 轮继续打
      L.lap[lg] = all ? 2 : 1;
    });
  }
  // 训练场：不判胜负、不扣券、不掉礼物；只给准备度、经验和「连对 10 题赢回 1 张券」
  // 准备度按「难度:boss」分开：普通练满分不代表地狱也准备好了。
  function trainId(league, bossKey) {
    return (LEAGUES[league] ? league : 'normal') + ':' + bossKey;
  }
  function setTraining(bossKey, league, pct, total) {
    var L = leagueState();
    var id = trainId(league, bossKey);
    var prev = L.train[id] || { pct: 0, n: 0 };
    L.train[id] = {
      pct: Math.max(prev.pct || 0, pct), n: (prev.n || 0) + (total || 0), at: todayKey(),
    };
    gainXp((total || 0) * 2);
    var bonus = null;
    if (pct === 100 && (total || 0) >= 5) {
      L.combo = (L.combo || 0) + total;
      if (L.combo >= 10 && L.bonusDay !== todayKey()) {
        L.bonusDay = todayKey(); L.combo = 0;
        L.tickets.normal = (L.tickets.normal || 0) + 1;
        bonus = 'normal';
      }
    } else { L.combo = 0; }
    persist();
    return { bonus: bonus, combo: L.combo || 0 };
  }
  function trainingReady(bossKey, league) {
    var t = (leagueState().train || {})[trainId(league, bossKey)];
    return t ? (t.pct || 0) : 0;
  }

  /* ---------- BOSS 战：奖品池 / 战利品 ---------- */
  var BOSS_KEYS = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'midterm', 'final'];

  /* ---------- 全局礼物库：四档稀有度 + 权重掉落 ----------
   * 礼物清单存在云端 gift_pool 表，所有设备共用一份；只有 GIFT_OWNER 这个昵称
   * 能往里加/删（数据库 RLS 也按 created_by 拦了一层）。
   * 掉率参考「暗黑」类刷装的思路：小 boss 多白绿，越大的 boss 越容易出橙。
   */
  var GIFT_OWNER = '三重刘德华';
  var GIFT_TIERS = ['white', 'green', 'purple', 'orange'];
  var GIFT_TIER = {
    white:  { key: 'white',  label: '普通', color: '#e9e7df', ink: '#33322c', pct: '' },
    green:  { key: 'green',  label: '精良', color: '#79d96a', ink: '#12330f', pct: '' },
    purple: { key: 'purple', label: '稀有', color: '#c07bff', ink: '#2b1241', pct: '' },
    orange: { key: 'orange', label: '传说', color: '#ffa53d', ink: '#3f2100', pct: '' },
  };
  // 每个难度档位的掉落权重（合计 100）
  // 传说要真的稀有：原来小boss 3% + 满血翻倍，打完三档 36 次几乎必出传说（96.6%）。
  // 现在降一档权重，并限制满血重掷不能产出传说（见 rollTier），让传说成为惊喜而非常态。
  var GIFT_WEIGHTS = {
    small: { white: 64, green: 27, purple: 8.5, orange: 0.5 },
    mid:   { white: 46, green: 33, purple: 19,  orange: 2 },
    big:   { white: 32, green: 36, purple: 27,  orange: 5 },
  };
  function bossTierOf(key) {
    return key === 'final' ? 'big' : (key === 'midterm' ? 'mid' : 'small');
  }
  function giftOwner() { return GIFT_OWNER; }
  function canManageGifts() { return S.name === GIFT_OWNER; }

  // 云端礼物库的本地缓存：没网也能看能掉，下次联网再刷新
  function setGiftPool(list) {
    S.giftPool = (list || []).map(function (g) {
      return { id: g.id, name: String(g.name || '').slice(0, 24), tier: g.tier, note: g.note || '' };
    }).filter(function (g) { return g.name && GIFT_TIERS.indexOf(g.tier) >= 0; });
    S.giftPoolAt = todayKey();
    persist();
    return S.giftPool;
  }
  function giftPool() { return S.giftPool || []; }

  // 难度越高，权重整体往上挪：普通按原表，噩梦挪一档、地狱挪两档
  function shiftWeights(w, steps) {
    var out = {};
    GIFT_TIERS.forEach(function (t) { out[t] = w[t] || 0; });
    for (var s = 0; s < steps; s++) {
      var m1 = Math.round(out.white * 0.35); out.white -= m1; out.green += m1;
      var m2 = Math.round(out.green * 0.25); out.green -= m2; out.purple += m2;
      var m3 = Math.round(out.purple * 0.20); out.purple -= m3; out.orange += m3;
    }
    return out;
  }
  function leagueWeights(league, bossKey) {
    var w = GIFT_WEIGHTS[bossTierOf(bossKey)] || GIFT_WEIGHTS.small;
    var steps = league === 'hell' ? 2 : (league === 'nightmare' ? 1 : 0);
    return steps ? shiftWeights(w, steps) : w;
  }
  function rollTier(bossKey, luck, league) {
    var w = leagueWeights(league || 'normal', bossKey);
    var total = 0, i;
    for (i = 0; i < GIFT_TIERS.length; i++) total += w[GIFT_TIERS[i]];
    var r = Math.random() * total, acc = 0, tier = GIFT_TIERS[0];
    for (i = 0; i < GIFT_TIERS.length; i++) {
      acc += w[GIFT_TIERS[i]];
      if (r < acc) { tier = GIFT_TIERS[i]; break; }
    }
    // 满血通关（luck）重掷一次取更好的那档，奖励打得干净的。
    // 但重掷只在白/绿/紫里进行：不能靠「打得干净」把传说刷出来，传说只能靠第一次那一抽。
    if (luck) {
      var luckTotal = total - (w.orange || 0);
      var r2 = Math.random() * luckTotal, acc2 = 0, t2 = GIFT_TIERS[0];
      for (i = 0; i < GIFT_TIERS.length - 1; i++) {
        acc2 += w[GIFT_TIERS[i]];
        if (r2 < acc2) { t2 = GIFT_TIERS[i]; break; }
        if (i === GIFT_TIERS.length - 2) t2 = GIFT_TIERS[i];
      }
      if (GIFT_TIERS.indexOf(t2) > GIFT_TIERS.indexOf(tier)) tier = t2;
    }
    // 保底：连续 3 次只掉白板，第 4 次强制绿以上（暗黑式「别让人一直空手」）
    if ((leagueState().pity || 0) >= 3 && GIFT_TIERS.indexOf(tier) === 0) tier = 'green';
    return tier;
  }
  function pityLeft() { return Math.max(0, 3 - (leagueState().pity || 0)); }

  // 先按档位抽，该档空了就往下退一档，全空返回 null（提示家长去塞礼物）
  function rollGift(bossKey, opts) {
    var pool = giftPool();
    if (!pool.length) return null;
    var luck = !!(opts && opts.perfect);
    var league = (opts && opts.league) || 'normal';
    var want = rollTier(bossKey, luck, league);
    var from = GIFT_TIERS.indexOf(want);
    for (var i = from; i >= 0; i--) {
      var tier = GIFT_TIERS[i];
      var bucket = pool.filter(function (g) { return g.tier === tier; });
      if (bucket.length) {
        var pick = bucket[Math.floor(Math.random() * bucket.length)];
        return { name: pick.name, tier: tier, id: pick.id };
      }
    }
    return null;
  }

  function addPrize(name) {
    var n = String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, 16);
    if (!n) return false;
    S.prizePool = S.prizePool || [];
    if (S.prizePool.indexOf(n) >= 0) return false;  // 同名不重复
    S.prizePool.push(n);
    persist();
    return true;
  }
  function removePrize(name) {
    if (!S.prizePool) return;
    var i = S.prizePool.indexOf(name);
    if (i >= 0) { S.prizePool.splice(i, 1); persist(); }
  }
  /* 掉落按「轮」算：这一轮第一次打赢它 → 掉一件礼物；同一轮再打只涨经验。
   * 这一轮 10 只全清 → 整版重置（lap + 1），10 只重新可掉。
   * 券是每天发，所以一轮大概要分两三天打完，不存在一天刷爆的问题。
   */
  function winBoss(key, gift, opts) {
    opts = opts || {};
    var league = opts.league || 'normal';
    if (BOSS_KEYS.indexOf(key) < 0) return null;
    S.bossDone = S.bossDone || {};
    S.bossDone[key] = todayKey();
    var conq = markConquest(league, key);   // 永久征服：只涨不降，负责解锁下一难度
    var L = leagueState();
    S.loot = S.loot || [];
    var lapBefore = lapOf(league);
    var drop = !lapDone(league, key);       // 本轮还没打赢过 → 这次能掉
    if (drop) L.wins[league + ':' + key] = lapBefore;
    var got = null;
    if (drop && gift && gift.name) {
      got = { uid: lootUid(), name: gift.name, tier: gift.tier || 'white', from: key,
              at: todayKey(), league: league };
      S.loot.push(got);
    }
    // 保底计数：只有真正掉到白板才累加，掉了绿以上就清零
    if (drop && got) L.pity = got.tier === 'white' ? (L.pity || 0) + 1 : 0;
    // 刚记完这一次，看看这一轮是不是全清了；全清就立刻开下一轮
    var before = lapState(league), reset = null;
    if (before.all) {
      L.lap[league] = lapBefore + 1;
      reset = { was: lapBefore, now: lapBefore + 1, league: league };
    }
    persist();
    return {
      repeat: !drop, gift: got, loot: S.loot,
      noGift: drop && !got, conquest: conq, pityLeft: pityLeft(),
      lap: reset ? reset.now : lapBefore,
      lapReset: reset,
      // 重置后返回的是新一轮的进度；没重置时就是刚才这一轮的进度
      lapProgress: lapState(league),
    };
  }
  /* ---------- 字块碎片：分解战利品 → 攒碎片 → 兑换想要的礼物 ----------
   * 分解 = 档位价值 ×3（普通 15 / 精良 60 / 稀有 150 / 传说 300）
   * 兑换 = 档位价值 ×10（普通 50 / 精良 200 / 稀有 500 / 传说 1000）
   * 约 70% 损耗，避免「分解再兑换」无损套利；碎片与战利品都进云端日快照。
   */
  var GIFT_VALUE = { white: 5, green: 20, purple: 50, orange: 100 };
  function shardSell(tier) { return (GIFT_VALUE[tier] || 5) * 3; }
  function shardBuy(tier) { return (GIFT_VALUE[tier] || 5) * 10; }
  function shards() { return S.shards || 0; }
  function lootUid() {
    return 'L' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36);
  }
  // 老存档的战利品没有唯一编号，补上才能逐件分解（同名多件不会一起消失）
  function ensureLootIds() {
    S.loot = S.loot || [];
    var changed = false;
    S.loot.forEach(function (x) {
      if (!x.uid) { x.uid = lootUid(); changed = true; }
    });
    if (typeof S.shards !== 'number') { S.shards = 0; changed = true; }
    if (changed) persist();
  }
  function sellLoot(uid) {
    ensureLootIds();
    var idx = -1;
    for (var i = 0; i < S.loot.length; i++) if (S.loot[i].uid === uid) { idx = i; break; }
    if (idx < 0) return { ok: false, reason: '这件战利品已经不在了' };
    var item = S.loot[idx];
    var gain = shardSell(item.tier);
    S.loot.splice(idx, 1);
    S.shards = (S.shards || 0) + gain;
    persist();
    return { ok: true, gain: gain, name: item.name, tier: item.tier, total: S.shards };
  }
  function buyGift(id) {
    var pool = giftPool();
    var gift = null;
    for (var i = 0; i < pool.length; i++) if (String(pool[i].id) === String(id)) { gift = pool[i]; break; }
    if (!gift) return { ok: false, reason: '这件礼物已经下架了' };
    var cost = shardBuy(gift.tier);
    if ((S.shards || 0) < cost) return { ok: false, reason: '碎片不够，还差 ' + (cost - (S.shards || 0)) };
    S.shards -= cost;
    S.loot = S.loot || [];
    var got = { uid: lootUid(), name: gift.name, tier: gift.tier, from: 'exchange',
                at: todayKey(), league: '' };
    S.loot.push(got);
    persist();
    return { ok: true, gift: got, cost: cost, left: S.shards };
  }

  function bossBeaten(key) { return !!(S.bossDone || {})[key]; }
  function bossList(league) {
    league = league || 'normal';
    return BOSS_KEYS.map(function (k) {
      var isExam = k === 'midterm' || k === 'final';
      return {
        key: k,
        name: isExam ? (k === 'midterm' ? '墨影将' : '墨影龙')
                     : (window.YW_UNITS.filter(function (u) { return u.id === Number(k.slice(1)); })[0] || {}).name,
        beaten: isConquered(league, k),           // 永久征服：解锁下一难度用
        lapDone: lapDone(league, k),              // 本轮已打赢：决定还能不能再掉礼物
        lap: lapOf(league),
        unlocked: bossUnlocked(league, k),
        tier: isExam ? (k === 'final' ? '大' : '中') : '小',
      };
    });
  }
  function bossSpec(key, league) {
    league = LEAGUES[league] ? league : 'normal';
    var tier = key === 'final' ? 'big' : (key === 'midterm' ? 'mid' : 'small');
    var count = tier === 'big' ? 14 : (tier === 'mid' ? 10 : 6);
    var hp = (BOSS_HP[league] || BOSS_HP.normal)[tier];
    if (hp > count) hp = count;      // 硬约束：心数永远不能大于题数
    var spec;
    if (key === 'midterm' || key === 'final') {
      var ex = window.YW_EXAM[key];
      spec = { mode: 'exam', examKey: key, count: ex.count || count, bossKey: key };
    } else {
      var u = Number(String(key).slice(1));
      spec = { mode: 'topic', units: [u], count: count, bossKey: key };
    }
    spec.league = league;
    spec.bossHp = hp;
    spec.myHp = (MY_HP[league] || MY_HP.normal)[tier];
    spec.wrongDmg = WRONG_DMG[league] || 1;
    return spec;
  }

  // 上一趟结果：结算完即回首页，结果作为一条可收起的条留在首页顶部
  function setLastRun(r) {
    S.lastRun = r ? {
      label: r.label || '练习', mode: r.mode || 'daily', spec: r.spec || {},
      note: r.note || '', at: r.at || todayKey(),
      // 闯关的三关结果要跟着结果条一起留着，否则回到首页就看不到这课过没过
      gate: r.gate || null,
      results: (r.results || []).map(function (x) {
        return { qid: x.qid, correct: !!x.correct, type: x.type || '' };
      }),
    } : null;
    return persist();
  }
  function setDigScope(u, l) {
    var unit = validUnit(u) ? Number(u) : S.progress.unit;
    S.digUnit = unit;
    S.digLesson = normalizeLesson(unit, l, true);
    return persist();
  }
  function setProgress(u, l) {
    var unit = validUnit(u) ? Number(u) : 1;
    var les = normalizeLesson(unit, l, false);
    // 闸门在这里也要生效：否则直接改下拉就能跳到第 8 单元，绕开一课一关
    if (!(S.progress && S.progress.unit === unit && S.progress.lesson === les) && !lessonUnlocked(les)) {
      throw new Error('先过前面那几课，这一课才会打开');
    }
    S.progress = { unit: unit, lesson: les };
    return persist();
  }

  /* ---------- 一课一关 ----------
   * 为什么要有闸门：题目再多，只要允许自由跳，孩子就一定只刷自己会的课。
   * 每课设三道关——字词、背诵、阅读，三类都到线才算这课通了，才解锁下一课。
   *
   * 判定口径：
   *   · 一趟里按题目类别分三桶（recite → 背诵，passage → 阅读，其余 → 字词）
   *   · 每桶要过 ceil(题数 × 2/3) 题：3 题对 2、2 题对 2、1 题对 1
   *   · 只升不降——这次没过不收回已经拿到的关（遗忘由错题复习队列兜底），
   *     否则孩子一次手滑就把进度打回去，会直接不想玩
   * 键带册次前缀，避免三上第 1 课和三下第 1 课串在一起。
   */
  function bookIdNow() {
    var b = window.YW_BOOK_OF ? window.YW_BOOK_OF(S.grade, S.term) : null;
    return b ? b.id : 'g3s1';
  }
  function lessonSeq() {
    var b = window.YW_BOOK_OF ? window.YW_BOOK_OF(S.grade, S.term) : null;
    var units = (b && b.units) || window.YW_UNITS || [];
    var seq = [];
    units.forEach(function (u) {
      (u.lessons || []).forEach(function (l) { seq.push({ unit: u.id, lesson: l.n, title: l.t }); });
    });
    return seq;
  }
  function gateKey(lesson) { return bookIdNow() + ':' + Number(lesson); }
  function gateOf(lesson) {
    var g = (S.gates || {})[gateKey(lesson)] || null;
    return {
      w: !!(g && g.w), b: !!(g && g.b), r: !!(g && g.r),
      all: !!(g && g.w && g.b && g.r), at: (g && g.at) || '',
    };
  }
  // 结算时用：按类别分桶算这一趟每关过没过
  function gateResultOf(results) {
    var b = { w: { t: 0, ok: 0 }, b: { t: 0, ok: 0 }, r: { t: 0, ok: 0 } };
    (results || []).forEach(function (x) {
      var q = window.YW_Q_BY_ID[x.qid];
      if (!q) return;
      var k = q.recite ? 'b' : (q.passage ? 'r' : 'w');
      b[k].t += 1;
      if (x.correct) b[k].ok += 1;
    });
    var out = {};
    Object.keys(b).forEach(function (k) {
      var o = b[k];
      out[k] = { total: o.t, ok: o.ok, pass: o.t > 0 && o.ok >= Math.ceil(o.t * 2 / 3) };
    });
    return out;
  }
  function saveGate(lesson, res) {
    if (!res) return Promise.resolve();
    S.gates = S.gates || {};
    var k = gateKey(lesson);
    var cur = S.gates[k] || { w: 0, b: 0, r: 0 };
    ['w', 'b', 'r'].forEach(function (x) {
      if (!res[x]) return;
      if (res[x].pass) cur[x] = 1;
      // 这一课本来就没有这类题（比如某课没编阅读题），不能拿它当关卡把人永久锁死
      else if (!res[x].total) cur[x] = 1;
    });
    cur.at = todayKey();
    S.gates[k] = cur;
    return persist();
  }
  // 顺序解锁：本课之前每一课都要三关全通，本课才开
  function lessonUnlocked(lesson) {
    var seq = lessonSeq();
    var at = -1;
    for (var i = 0; i < seq.length; i++) { if (seq[i].lesson === Number(lesson)) { at = i; break; } }
    if (at <= 0) return true;
    for (var j = 0; j < at; j++) { if (!gateOf(seq[j].lesson).all) return false; }
    return true;
  }
  // 老档案兼容：一开始就没有 gates 记录、但进度已经推到后面的孩子，
  // 把当前课之前的课全部按「已通关」处理，不能把人一夜之间锁在门外。
  function seedGates() {
    if (S.gates && Object.keys(S.gates).length) return;
    var cur = Number(S.progress.lesson) || 0;
    if (cur <= 1) return;
    // 一次题都没做过的是全新档案，不能把 1..cur 白送成「已通关」——那闸门就形同虚设
    var practiced = (S.attempts && S.attempts.length) || (S.blocks > 0) ||
                    Object.keys(S.wrong || {}).length;
    if (!practiced) return;
    S.gates = S.gates || {};
    lessonSeq().forEach(function (s) {
      if (s.lesson < cur) S.gates[gateKey(s.lesson)] = { w: 1, b: 1, r: 1, at: todayKey(), seeded: 1 };
    });
  }

  function exportAll() {
    return { v: 2, exportedFrom: window.YW_EDITION, root: root };
  }

  async function importAll(obj) {
    if (!obj) throw new Error('文件格式不对');
    var source = obj.root || obj.state || null;
    if (!source) throw new Error('文件格式不对');
    root = buildRoot(source);
    if (root.activeId && root.profiles[root.activeId]) { S = root.profiles[root.activeId]; guest = false; }
    else { S = guestState(); guest = true; }
    await persist();
  }

  function resetLocal() {
    if (guest) return Promise.resolve();
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
    isWrong: isWrong, isPending: isPending,
    lastGaveBlock: function () { return lastGaveBlock; },
    buildDaySnapshot: buildDaySnapshot, finalizeDay: finalizeDay, markSynced: markSynced,
    applySnapshot: applySnapshot, pickRound: pickRound, buildRound: buildRound,
    saveRound: saveRound, loadRound: loadRound, clearRound: clearRound, setDigScope: setDigScope,
    setLastRun: setLastRun, markChallenge: markChallenge, hasChallenge: hasChallenge,
    exportAll: exportAll, importAll: importAll, resetLocal: resetLocal,
    isFallback: function () { return useLS; },
    profileList: profileList, switchProfile: switchProfile, createProfile: createProfile,
    renameProfile: renameProfile, deleteProfile: deleteProfile,
    findByName: findByName, enterGuest: enterGuest, needIdentity: needIdentity,
    isGuest: function () { return guest; },
    spaceForName: function (name) { return deriveSpaceId(name); },
    profileId: function () { return S.id; }, profileName: function () { return S.name; },
    setSpaceId: function (code) { S.spaceId = String(code || '').trim(); return persist(); },
    setProgress: setProgress,
    // 一课一关
    gateOf: gateOf, gateResultOf: gateResultOf, saveGate: saveGate,
    lessonUnlocked: lessonUnlocked, lessonSeq: lessonSeq,
    // 侥幸做对 → 轻量复习；本周回看
    isPending: isPending, weekRecap: weekRecap, weekKey: weekKey, markWeekDone: markWeekDone,
    setGrade: function (g, t) { S.grade = Number(g); S.term = t || S.term; syncBookContext(); return persist(); },
    setExamScope: function (key, units) { S.examScope[key] = units; return persist(); },
    addPrize: addPrize, removePrize: removePrize, winBoss: winBoss,
    bossBeaten: bossBeaten, bossList: bossList, bossSpec: bossSpec,
    // 字块大陆三难度：券/解锁/征服/保底/经验段位/训练场
    LEAGUES: LEAGUES, LEAGUE_KEYS: LEAGUE_KEYS, leagueInfo: leagueInfo,
    leagueUnlocked: leagueUnlocked, leagueLeft: leagueLeft, spendTicket: spendTicket,
    refundTicket: refundTicket,
    isConquered: isConquered, markConquest: markConquest,
    // 轮次（周目）：一整版 10 只全清后自动重置，礼物可以再掉一轮
    lapOf: lapOf, lapDone: lapDone, lapState: lapState,
    bossUnlocked: bossUnlocked, prevBossName: prevBossName,
    coachReadMastery: coachReadMastery, coachWordMastery: coachWordMastery,
    checkDictation: checkDictation, judgeSay: judgeSay, coachRecordReading: coachRecordReading,
    coachDueWords: coachDueWords, weakLayers: weakLayers, coachState: coachState,
    coachWordStat: coachWordStat, coachReadOverall: coachReadOverall,
    coachWordSet: coachWordSet, coachWordDrill: coachWordDrill,
    bossWeakInfo: bossWeakInfo, applyWeakBuff: applyWeakBuff, bossForWeak: bossForWeak, WEAK_NEED: WEAK_NEED, layerLabel: layerLabel,
    gainXp: gainXp, rankInfo: rankInfo, pityLeft: pityLeft,
    setTraining: setTraining, trainingReady: trainingReady,
    leagueWeights: leagueWeights,
    // 全局礼物库：四档稀有度、权重掉落、只有 owner 昵称能管理
    GIFT_TIERS: GIFT_TIERS, GIFT_TIER: GIFT_TIER, GIFT_WEIGHTS: GIFT_WEIGHTS,
    giftPool: giftPool, setGiftPool: setGiftPool, rollGift: rollGift, rollTier: rollTier,
    giftOwner: giftOwner, canManageGifts: canManageGifts, bossTierOf: bossTierOf,
    // 字块碎片：分解 / 兑换
    shards: shards, shardSell: shardSell, shardBuy: shardBuy,
    sellLoot: sellLoot, buyGift: buyGift, ensureLootIds: ensureLootIds,
    pastCount: function () { return window.YW_pastQuestions(S.grade, S.term).length; },
    setNoAnim: function (v) { S.noAnim = !!v; document.documentElement.classList.toggle('no-anim', !!v); return persist(); },
  };
})();
