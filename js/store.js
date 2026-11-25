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
      progress: { unit: 5, lesson: 15 },
      digUnit: 5, digLesson: 15,
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
      league: (function () {
        var L = leagueState();
        return {
          unlocked: L.unlocked, conquest: L.conquest, train: L.train,
          xp: L.xp || 0, pity: L.pity || 0,
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
    if (p.progress && validUnit(p.progress.unit)) {
      S.progress.unit = Number(p.progress.unit);
      S.progress.lesson = normalizeLesson(S.progress.unit, p.progress.lesson, false);
    }
    if (p.dig && validUnit(p.dig.unit)) {
      S.digUnit = Number(p.dig.unit);
      S.digLesson = normalizeLesson(S.digUnit, p.dig.lesson, true);
    }
    if (p.examScope) S.examScope = p.examScope;
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

  // 三档题库差异化：普通=基础维度，噩梦=理解应用维度为主、基础穿插，地狱=跨单元混错题与薄弱点。
  // 只是选题策略不同，判定、计分、错题、掌握度全部沿用原口径。
  var LEAGUE_DIMS = {
    normal: ['pinyin', 'zici', 'beisong', 'ciyu', 'xingjinzi', 'duoyinzi', 'yicuoyin', 'gushi'],
    nightmare: ['juzi', 'yuedu', 'changshi', 'bingju', 'biaodian', 'deDiDe',
                'lijie', 'wenyan', 'guancha', 'ciyu'],
  };
  function inDims(q, dims) { return dims.indexOf(q.dim) >= 0 || dims.indexOf(q.kp) >= 0; }
  // 题库分档：普通只用原有基础题；噩梦/地狱以扩展能力题为主，掺入基础题防止断层。
  function tierPool(pool, league, n) {
    if (!league || league === 'normal') return pool.filter(function (q) { return !q.tier; });
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
  function leaguePick(pool, league, n) {
    n = n || pool.length;
    pool = tierPool(pool, league, n);
    if (!pool.length) return [];
    if (!league || league === 'normal') {
      var base = pool.filter(function (q) { return inDims(q, LEAGUE_DIMS.normal); });
      var used = {}; base.forEach(function (q) { used[q.id] = 1; });
      return rank(base).concat(rank(pool.filter(function (q) { return !used[q.id]; }))).slice(0, n);
    }
    if (league === 'nightmare') {
      var deep = rank(pool.filter(function (q) { return inDims(q, LEAGUE_DIMS.nightmare); }));
      var seen = {};
      pool.filter(function (q) { return inDims(q, LEAGUE_DIMS.nightmare); })
          .forEach(function (q) { seen[q.id] = 1; });
      var rest = rank(pool.filter(function (q) { return !seen[q.id]; }));
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
      .filter(function (q) { return q && pool.indexOf(q) >= 0; }));
    var s1 = {}; wrongQ.forEach(function (q) { s1[q.id] = 1; });
    var weak = rank(pool.filter(function (q) { return !s1[q.id] && masteryOf(q.kp) < 60; }));
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
      picked = leaguePick(tp, spec.league, n);
      note = spec.league === 'hell' ? '地狱 · 跨单元混合 + 错题/薄弱点'
           : spec.league === 'nightmare' ? '噩梦 · 句子阅读方法加量，基础穿插'
           : spec.dim ? ((window.YW_DIMS[spec.dim] || {}).label || '所选维度')
           : spec.kp ? ((window.YW_KP[spec.kp] || {}).label || '所选知识点') : '基础字词句';
    } else if (mode === 'exam') {
      var ex = window.YW_EXAM[spec.examKey || 'midterm'];
      label = spec.training ? '训练场 · ' + ex.label
            : spec.bossKey ? ('BOSS 战 · ' + ex.label) : ex.label;
      var units = S.examScope[ex.key] || ex.units;
      var epool = spec.league === 'hell'
        ? window.YW_currentQuestions(S.grade, S.term)
        : window.YW_currentQuestions(S.grade, S.term, units);
      picked = leaguePick(epool, spec.league, spec.count || ex.count);
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
      var want = (mode === 'daily' && !review && outUsed < 2) ? outKind(q) : null;
      // 同一趟里同一种输出题只保留一道：随机撞型的第二道降级为普通选择题，
      // 免得孩子连着做两道「挑错字」以为是卡住了。
      var kind = (want && !kindSeen[want]) ? want : null;
      if (kind) {
        outUsed++; kindSeen[kind] = 1;
        if (kind === 'fill') { typedUsed++; S.fillDay.n++; }
        if (S.fillDay.kinds.indexOf(kind) < 0) S.fillDay.kinds.push(kind);
      }
      items.push({ q: q, isReview: review, outKind: kind || '' });
    });
    if (outUsed) persist();
    return { mode: mode, label: label, note: note, items: items, count: items.length };
  }

  function pickRound(n) { return buildRound({ mode: 'daily', count: n || 5 }); }

  /* ---------- 身份（昵称）---------- */
  function profileList() {
    return Object.keys(root.profiles).map(function (id) {
      var p = root.profiles[id];
      return {
        id: id, name: p.name, blocks: p.blocks || 0, level: p.level || 1,
        wrong: Object.keys(p.wrong || {}).filter(function (q) { return !p.wrong[q].graduated; }).length,
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
      bossHp: Number(r.bossHp) || 0,
      bossHpMax: Number(r.bossHpMax) || 0,
      myHp: Number(r.myHp) || 0,
      myHpMax: Number(r.myHpMax) || 0,
      fillMode: r.fillMode === 'choice' ? 'choice' : 'fill',
      fillInput: r.fillInput || '',
      orderPicks: (r.orderPicks || []).slice(0, 2),
      items: r.items.map(function (it) {
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
    if (!p || !p.items || !p.items.length || p.phase === 'done') return null;
    var items = p.items.map(function (x) {
      var q = window.YW_Q_BY_ID[x.q];
      return q ? { q: q, isReview: !!x.isReview,
                   outKind: x.outKind || (x.asFill ? 'fill' : '') } : null;
    }).filter(Boolean);
    if (!items.length) return null;
    return {
      spec: p.spec || {}, label: p.label || '练习', note: p.note || '',
      mode: p.mode || 'daily', items: items,
      isRedo: !!p.isRedo,
      challenge: !!p.challenge,
      battle: p.battle === 'boss' ? 'boss' : '',
      bossKey: p.bossKey || '',
      bossHp: Number(p.bossHp) || 0,
      bossHpMax: Number(p.bossHpMax) || 0,
      myHp: Number(p.myHp) || 0,
      myHpMax: Number(p.myHpMax) || 0,
      fillMode: p.fillMode === 'choice' ? 'choice' : 'fill',
      fillInput: p.fillInput || '',
      orderPicks: (p.orderPicks || []).slice(0, 2),
      idx: Math.min(p.idx || 0, items.length - 1),
      results: (p.results || []).slice(0, items.length),
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
  function markConquest(league, key) {
    var L = leagueState(), id = league + ':' + key;
    var first = !L.conquest[id];
    if (first) L.conquest[id] = todayKey();
    var next = null;
    if (first) {
      var i = LEAGUE_KEYS.indexOf(league);
      if (i >= 0 && i < LEAGUE_KEYS.length - 1) {
        var nk = LEAGUE_KEYS[i + 1];
        if (!L.unlocked[nk]) { L.unlocked[nk] = true; next = nk; }
      }
    }
    gainXp(8 * (leagueInfo(league).xpMul) + (first ? 6 : 0));
    persist();
    return { first: first, unlocked: next };
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
  var GIFT_WEIGHTS = {
    small: { white: 60, green: 26, purple: 11, orange: 3 },
    mid:   { white: 40, green: 30, purple: 22, orange: 8 },
    big:   { white: 24, green: 30, purple: 30, orange: 16 },
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
    // 满血通关（luck）重掷一次取更好的那档，奖励打得干净的
    if (luck) {
      var r2 = Math.random() * total, acc2 = 0, t2 = GIFT_TIERS[0];
      for (i = 0; i < GIFT_TIERS.length; i++) {
        acc2 += w[GIFT_TIERS[i]];
        if (r2 < acc2) { t2 = GIFT_TIERS[i]; break; }
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
  // 每个难度各自首次通关才掉落，三档都能拿到一次礼物；重复通关只涨经验。
  function winBoss(key, gift, opts) {
    opts = opts || {};
    var league = opts.league || 'normal';
    if (BOSS_KEYS.indexOf(key) < 0) return null;
    S.bossDone = S.bossDone || {};
    S.bossDone[key] = todayKey();
    var conq = markConquest(league, key);
    var L = leagueState();
    S.loot = S.loot || [];
    var got = null;
    if (conq.first && gift && gift.name) {
      got = { uid: lootUid(), name: gift.name, tier: gift.tier || 'white', from: key,
              at: todayKey(), league: league };
      S.loot.push(got);
    }
    // 保底计数：只有真正掉到白板才累加，掉了绿以上就清零
    if (conq.first && got) L.pity = got.tier === 'white' ? (L.pity || 0) + 1 : 0;
    persist();
    return {
      repeat: !conq.first, gift: got, loot: S.loot,
      noGift: conq.first && !got, conquest: conq, pityLeft: pityLeft(),
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
        beaten: isConquered(league, k),
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
    setGrade: function (g, t) { S.grade = Number(g); S.term = t || S.term; syncBookContext(); return persist(); },
    setExamScope: function (key, units) { S.examScope[key] = units; return persist(); },
    addPrize: addPrize, removePrize: removePrize, winBoss: winBoss,
    bossBeaten: bossBeaten, bossList: bossList, bossSpec: bossSpec,
    // 字块大陆三难度：券/解锁/征服/保底/经验段位/训练场
    LEAGUES: LEAGUES, LEAGUE_KEYS: LEAGUE_KEYS, leagueInfo: leagueInfo,
    leagueUnlocked: leagueUnlocked, leagueLeft: leagueLeft, spendTicket: spendTicket,
    refundTicket: refundTicket,
    isConquered: isConquered, markConquest: markConquest,
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
