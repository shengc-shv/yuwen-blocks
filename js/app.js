/* 方块语文 · 交互闭环 */
(function () {
  'use strict';

  var St = window.YWStore, Cl = window.YWCloud;
  var view = document.getElementById('view');
  var toastEl = document.getElementById('toast');
  var syncBar = document.getElementById('sync-bar');
  var tab = 'practice';
  var round = null;
  var toastTimer = null;
  var challengeTimer = null;
  var challengeLeft = 30;
  var endToast = null;   // 一趟结束时才给的提示，优先级高于普通答对提示
  var ui = {
    pastGrade: 0, topicKp: '', topicScope: 'all', scopeKey: 'midterm',
    wrongFilter: 'all', cloudSaves: [], cloudOk: false, cloudMsg: '',
    lastSyncAt: '', lastError: '',
    mustIdentity: false,   // 首次进入必须选一个身份，不给「先不选」
    league: 'normal',      // 字块大陆当前查看的难度
  };

  function S() { return St.get(); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg) {
    toastEl.textContent = msg; toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.add('hidden'); }, 2800);
  }
  function setSync(msg, cls) { syncBar.textContent = msg; syncBar.className = 'sync-bar ' + (cls || ''); }

  // 今日挑战的倒计时只展示、不打断：到零也能把题做完，只是少一分紧张感。
  function stopChallengeTimer() {
    if (challengeTimer) { clearInterval(challengeTimer); challengeTimer = null; }
  }
  function updateChallengeUI() {
    var t = document.getElementById('chal-time');
    if (t) t.textContent = challengeLeft;
    var f = document.getElementById('chal-fill');
    if (f) f.style.width = (challengeLeft / 30 * 100) + '%';
  }
  function startChallengeTimer() {
    stopChallengeTimer();
    if (window.__NO_TIMER) return;   // 自动化验证时关掉计时，避免虚拟时间空转
    challengeLeft = 30;
    updateChallengeUI();
    challengeTimer = setInterval(function () {
      if (!round || !round.challenge) { stopChallengeTimer(); return; }
      challengeLeft = Math.max(0, challengeLeft - 1);
      updateChallengeUI();
      if (challengeLeft === 0) {
        stopChallengeTimer();
        toast('时间到，慢慢做完就好，砖照常算');
      }
    }, 1000);
  }
  function comboBurst(n) {
    document.body.classList.remove('combo-burst');
    void document.body.offsetWidth;
    document.body.classList.add('combo-burst');
    setTimeout(function () { document.body.classList.remove('combo-burst'); }, 1000);
  }
  // 像素竞技场：答对己方冲锋、答错 BOSS 反击。纯 CSS 动画，
  // 只在画面层加 class，不碰血量、计分和错题逻辑；动画结束自动清掉。
  // 每种攻击一个特效层：都不占布局，只是绝对定位的 .fx 子元素 + CSS 动画
  var ATTACK_FX = {
    boom:  '<i class="fx-boom"></i><i class="fx-boom b2"></i>',
    arrow: '<i class="fx-arrow"></i>',
    web:   '<i class="fx-web"></i>',
    snow:  '<i class="fx-snow"></i>',
    jump:  '<i class="fx-slam"></i>',
    laser: '<i class="fx-laser"></i>',
    fire:  '<i class="fx-fire"></i>',
    charge: '',
    slash: '<i class="fx-slash"></i>',
    breath: '<i class="fx-breath"></i><i class="fx-breath b2"></i>',
  };

  function playAttack(type) {
    var arena = document.getElementById('arena');
    var fx = document.getElementById('fx');
    if (!arena || !fx) return;
    arena.setAttribute('data-atk', type);
    fx.innerHTML = ATTACK_FX[type] || '';
    void fx.offsetWidth;                       // 强制重排，动画能重放
    fx.classList.add('go');
    setTimeout(function () {
      if (!fx.isConnected) return;
      fx.innerHTML = '';
      fx.classList.remove('go');
      var a = document.getElementById('arena');
      if (a) a.removeAttribute('data-atk');
    }, 760);
  }

  function arenaHit(correct, damage) {
    var arena = document.getElementById('arena');
    if (!arena) return;             // 可能已经打完结算了
    arena.classList.remove('hit-hero', 'hit-enemy');
    void arena.offsetWidth;
    arena.classList.add(correct ? 'hit-enemy' : 'hit-hero');
    // 被打时按 boss 的设定放对应攻击（龙吐息、骷髅射箭、蜘蛛吐丝、苔怪自爆……）
    playAttack(correct ? 'hero' : (BOSS_ATTACK[round && round.bossKey] || 'charge'));
    var dmg = document.getElementById('dmg');
    if (dmg) { dmg.textContent = '-' + damage; }
    setTimeout(function () {
      arena.classList.remove('hit-hero', 'hit-enemy');
      if (dmg) dmg.textContent = '';
    }, 720);
  }

  // 红心血条：cur 满心数 / max 总心数；brokeIdx 是刚被打掉的那颗（播一次碎裂动画）
  function heartsRow(cur, max, who, brokeIdx) {
    var out = ['<span class="hearts hearts-', who, '" role="img" aria-label="生命 ',
      cur, '/', max, '">'];
    for (var i = 0; i < max; i++) {
      out.push('<svg class="heart', (i >= cur ? ' lost' : ''), (i === brokeIdx ? ' broke' : ''),
        '" viewBox="0 0 9 8" aria-hidden="true"><use href="#mc-heart"></use></svg>');
    }
    out.push('</span>');
    return out.join('');
  }

  // 战斗提示：写清这个 boss 怎么打人，别让小朋友莫名其妙掉心
  var ATTACK_HINT = {
    boom: '它贴身就炸，答错会被炸一下',
    arrow: '它会拉弓射箭，答错就中一箭',
    web: '它会吐丝缠人，答错就被糊住',
    snow: '它扔雪球，答错就挨一颗',
    jump: '它会跳起来砸，答错就被压一下',
    laser: '它会放光束，答错就被扫到',
    fire: '它扔火球，答错会烫一下',
    charge: '它会低头冲撞，答错就被顶飞',
    slash: '它会挥刀劈砍，答错就中一刀',
    breath: '它会喷紫色吐息，答错就被烧到',
  };
  function attackHint(key) {
    return ATTACK_HINT[BOSS_ATTACK[key] || 'charge'] || '答对就打它，答错就挨一下';
  }

  function dLabel(k) { return k ? k.slice(5, 7) + '月' + k.slice(8, 10) + '日' : '—'; }
  function kpName(k) { return (window.YW_KP[k] || { label: k }).label; }
  function dimName(d) { return (window.YW_DIMS[d] || { label: '综合' }).label; }
  function topicLabel(v) {
    if (!v) return '';
    if (v.indexOf('dim:') === 0) return (window.YW_DIMS[v.slice(4)] || {}).label || v;
    return kpName(v);
  }
  function typeName(t) { return t === 'careless' ? '看错了' : t === 'confused' ? '记混了' : t === 'unknown' ? '还没学会' : '—'; }
  function unitName(u) { var x = window.YW_UNITS.filter(function (v) { return v.id === u; })[0]; return x ? x.name : '第 ' + u + ' 单元'; }

  // 题目出处：明确到「第几课《课题》」，回忆录题标明年级册次
  function sourceOf(q) {
    if (q.grade !== S().grade) {
      return { book: q.grade + ' 年级' + q.term + '册 · 回忆录', unit: '过往知识重点复习' };
    }
    return {
      book: (q.lesson > 0 ? '第 ' + q.lesson + ' 课 ' : '') + (q.lessonTitle ? '《' + q.lessonTitle + '》' : '本学期'),
      unit: '第 ' + q.unit + ' 单元 · ' + unitName(q.unit),
    };
  }

  /* 原创像素生物头：三种形象轮换，替代原来的方块进度格。
     图形定义在 index.html 的 <symbol>，名字与造型均为本项目自创。 */
  var MOB_KINDS = ['moss', 'stone', 'peach'];
  var MOB_NAMES = { moss: '苔苔', stone: '岩岩', peach: '团团' };
  function mobSvg(kind) {
    // 同时给 href 与 xlink:href，兼容较旧的移动端浏览器
    return '<svg class="mob-head" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true" ' +
           'xmlns:xlink="http://www.w3.org/1999/xlink">' +
           '<use href="#mob-' + kind + '" xlink:href="#mob-' + kind + '"></use></svg>';
  }
  function mobRow(items, results, currentIdx) {
    return items.map(function (x, i) {
      var kind = MOB_KINDS[i % 3], c = 'mob-slot';
      if (i < results.length) c += results[i].correct ? ' done' : ' wrong';
      else if (i === currentIdx) c += ' now';
      else c += ' dim';
      return '<span class="' + c + '" title="' + MOB_NAMES[kind] + '">' + mobSvg(kind) + '</span>';
    }).join('');
  }
  // 伙伴塔：一格一位伙伴，固定 4×5 网格（永远对得齐，不会参差）。
  // 重要：进度按「当前这一座塔」算，用 blocks % 20，不能用 blocks 本身，
  // 否则累计答对超过 20 题以后塔就永远停在满格不动了。
  var TOWER_PER = 20;
  function towerCard() {
    var s = S();
    var filled = s.blocks % TOWER_PER;
    var left = TOWER_PER - filled;
    var slots = '';
    for (var i = 0; i < TOWER_PER; i++) {
      var kind = MOB_KINDS[i % 3], on = i < filled;
      slots += '<span class="tower-slot' + (on ? ' on' : '') + (on && i === filled - 1 ? ' latest' : '') +
               '" title="' + (on ? MOB_NAMES[kind] + ' 已入住' : '空位，答对一题就有伙伴搬进来') + '">' +
               mobSvg(kind) + '</span>';
    }
    return [
      '<div class="card">',
        '<div class="tower-top">',
          '<h3>伙伴塔</h3>',
          '<span class="tower-badge">第 ', s.level, ' 座 · ', filled, ' / ', TOWER_PER, '</span>',
        '</div>',
        '<div class="tower-grid">', slots, '</div>',
        '<div class="tower-bar"><i style="width:', Math.round(filled / TOWER_PER * 100), '%"></i></div>',
        '<p class="tiny"><b>再答对 ', left, ' 题</b>，这座塔就住满、升一级，换一座新塔开工。之前住满的塔都算在等级里，累计已有 ',
          s.blocks, ' 位伙伴。</p>',
      '</div>',
    ].join('');
  }
  // 游客替代伙伴塔的说明卡：不留一个「会归零的塔」让孩子困惑
  function guestCard() {
    return [
      '<div class="card guest-card">',
        '<h3>现在是游客</h3>',
        '<p class="muted">可以随便练，但什么都不会留下：没有伙伴塔、没有错题集、没有回忆录，关掉页面就清空。</p>',
        '<button class="btn wide" style="margin-top:10px" data-action="open-identity">取个昵称，把进度存下来</button>',
      '</div>',
    ].join('');
  }

  function overlay(html) {
    closeOverlay();
    var d = document.createElement('div');
    d.className = 'overlay'; d.id = 'yw-overlay';
    d.innerHTML = '<div class="sheet">' + html + '</div>';
    document.body.appendChild(d);
  }
  function closeOverlay() { var o = document.getElementById('yw-overlay'); if (o) o.remove(); }

  var renameTargetId = null;
  var pendingConfirm = null;
  var pendingStart = null;

  // 应用内确认框：不依赖 window.confirm（嵌入式预览里原生弹窗会被禁用）
  function confirmSheet(title, msg, okLabel, run) {
    pendingConfirm = run;
    overlay([
      '<h2>', esc(title), '</h2>',
      '<p class="muted">', esc(msg), '</p>',
      '<div class="btn-row" style="margin-top:14px">',
        '<button class="btn ghost" data-action="confirm-cancel">取消</button>',
        '<button class="btn danger" data-action="confirm-ok">', esc(okLabel), '</button>',
      '</div>',
    ].join(''));
  }

  // 应用内改名表单：不依赖 window.prompt，可对任意一个使用者改名
  function renameSheet(id) {
    renameTargetId = id || St.profileId();
    var p = St.profileList().filter(function (x) { return x.id === renameTargetId; })[0];
    overlay([
      '<h2>给这个昵称改名</h2>',
      '<p class="muted">改名只改称呼，存档归属不变，进度不会丢。名字只存在本机，不会上传到云端。</p>',
      '<label class="field"><span>名字（最多 12 个字）</span>',
        '<input id="rename-input" maxlength="12" value="', esc(p ? p.name : ''), '" /></label>',
      '<div class="btn-row">',
        '<button class="btn ghost" data-action="open-me">取消</button>',
        '<button class="btn primary" data-action="rename-save">保存</button>',
      '</div>',
    ].join(''));
  }
  function download(name, obj) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
  }

  /* ---------------- 启动与同步 ---------------- */
  async function refreshCloudList(again) {
    if (St.isGuest()) { ui.cloudSaves = []; ui.cloudOk = false; ui.cloudMsg = '游客模式不上云'; if (again) render(); return; }
    try { ui.cloudSaves = await Cl.listSaves(S().spaceId); ui.cloudOk = true; ui.cloudMsg = ''; }
    catch (e) { ui.cloudOk = false; ui.cloudMsg = e.message; }
    if (again) render();
  }
  function isFreshProfile(s) {
    return (!s.blocks) && Object.keys(s.saves || {}).length === 0 &&
           Object.keys(s.wrong || {}).length === 0 &&
           (s.attempts || []).length === 0 &&
           Object.keys(s.daily || {}).length === 0;
  }
  function dateOf(row) { return String(row.save_date || '').slice(0, 10); }
  function applyLatest(rows) {
    if (!rows || !rows.length) return false;
    var p = rows[0].payload;
    if (!p || p.v !== 1) return false;
    St.applySnapshot(p);
    ui.lastSyncAt = '已从云端恢复 ' + dateOf(rows[0]);
    return true;
  }
  // 昵称即身份：本机是空的、而云端这个昵称已经有存档 → 直接接回来，不用用户自己去找
  async function autoRestore() {
    if (!Cl.isReady() || St.isGuest()) return;
    try {
      var mine = await Cl.listSaves(S().spaceId);
      if (mine && mine.length && isFreshProfile(S()) && applyLatest(mine)) {
        toast('已从云端接上「' + St.profileName() + '」的进度');
      }
    } catch (e) { ui.lastError = e.message; }
  }

  async function syncPending() {
    if (!Cl.isReady() || St.isGuest()) return;
    var dates = S().pendingSync.slice();
    for (var i = 0; i < dates.length; i++) {
      var d = dates[i];
      var payload = S().saves[d] || St.buildDaySnapshot(d);
      try { await Cl.uploadSave(S().spaceId, d, payload); St.markSynced(d); }
      catch (e) { ui.cloudMsg = e.message; break; }
    }
  }
  function updateSyncBar() {
    var s = S();
    if (St.isGuest()) { setSync('游客模式 · 只练不存，关掉页面就清空', 'warn'); return; }
    if (!Cl.isReady()) { setSync(Cl.reason() + ' · 本地已保存', 'warn'); return; }
    if (s.pendingSync.length) { setSync(s.pendingSync.length + ' 份待同步 · 本地已保存，稍后自动重试', 'warn'); return; }
    setSync('云端已同步 · 每天一个存档（北京时间）', 'ok');
  }
  async function syncDate(payload) {
    if (St.isGuest()) return;
    try {
      await Cl.uploadSave(S().spaceId, payload.date, payload);
      St.markSynced(payload.date);
      ui.lastSyncAt = new Intl.DateTimeFormat('zh-CN', {
        timeZone: window.YW_TZ, hour: '2-digit', minute: '2-digit',
      }).format(new Date());
      ui.lastError = '';
      setSync('云端已同步 · ' + payload.date + ' 存档已更新', 'ok');
      await refreshCloudList(false);
    } catch (e) {
      ui.lastError = e.message;
      setSync(e.message + '（本地已保存）', 'warn');
    }
  }

  async function boot() {
    try {
      await St.init();
      Cl.init();
      St.setNoAnim(S().noAnim);
      document.getElementById('edition-label').textContent = window.YW_EDITION;
      // 第一次打开（还没选身份）：先问「你以什么身份登录」，选完再同步
      if (St.needIdentity()) {
        tab = 'practice';
        render();
        updateSyncBar();
        renderIdentity(true);
        return;
      }
      if (!St.isGuest()) {
        await syncPending();
        await refreshCloudList(false);
        await autoRestore(false);
      }
      updateSyncBar();
      if (St.isFallback()) toast('浏览器存储受限，建议换个浏览器打开');
      render();
      // 礼物库顺手拉一次（失败不打扰：本地有上次的缓存，照样能开箱）
      refreshGiftPool();
    } catch (e) {
      view.innerHTML = '<div class="error">启动失败：' + esc(e.message) + '</div>';
    }
  }

  /* ---------------- 通用渲染 ---------------- */
  function updateChips() {
    var s = S(), g = St.isGuest();
    document.getElementById('who-name').textContent = g ? '游客' : St.profileName();
    document.getElementById('chip-level').textContent = s.level;
    document.getElementById('chip-blocks').textContent = s.blocks;
    document.getElementById('chip-streak').textContent = s.streak;
    document.getElementById('xp-fill').style.width = ((s.blocks % 20) / 20 * 100) + '%';
    document.body.classList.toggle('is-guest', g);
  }
  function render() {
    updateChips();
    var g = St.isGuest();
    // 游客只有练习：没有错题 / 地图 / 回忆录，底部导航整条收起
    document.querySelector('.tabbar').classList.toggle('hidden', g);
    if (g) tab = 'practice';
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    if (tab === 'past') renderPast();
    else if (tab === 'map') renderMap();
    else if (tab === 'wrong') renderWrong();
    else renderPractice();
  }

  /* ---------------- 身份：你以什么身份登录 ---------------- */
  // 首次进入、以及从「我的」切身份时用同一个面板：
  // 选一个用过的昵称 / 取一个新昵称 / 以游客身份继续（只练不存）
  function renderIdentity(must) {
    ui.mustIdentity = !!must;
    var list = St.profileList();
    var cards = list.map(function (p) {
      return '<button class="profile-card' + (p.active ? ' on' : '') + '" data-action="id-pick" data-id="' + p.id + '">' +
        '<div class="p-ico">' + esc(p.name.slice(0, 1)) + '</div>' +
        '<div class="p-body"><strong>' + esc(p.name) + (p.active ? ' · 上次在用' : '') + '</strong>' +
        '<span>Lv.' + p.level + ' · ' + p.blocks + ' 方块 · ' + p.wrong + ' 道错题</span></div>' +
        '<span class="p-go">' + (p.active ? '继续' : '进入') + '</span></button>';
    }).join('');
    overlay([
      '<h2>你以什么身份登录</h2>',
      '<p class="muted">进度跟着昵称走：同一个昵称，换台设备输进来就能接回原来的存档。</p>',
      list.length
        ? '<div class="id-list">' + cards + '</div>'
        : '<p class="tiny id-empty">这台设备还没用过任何昵称，直接取一个就行。</p>',
      '<label class="field" style="margin-top:10px"><span>新昵称（最多 12 个字）</span>' +
        '<input id="id-name" maxlength="12" placeholder="例如：小宇" autocomplete="off" /></label>',
      '<button class="btn primary wide" data-action="id-create">用这个昵称开始</button>',
      '<button class="btn ghost wide" style="margin-top:8px" data-action="id-guest">以游客身份继续</button>',
      '<p class="tiny" style="margin-top:6px">游客只能练：不存进度、不上云，没有错题集和回忆录，关掉页面就清空。</p>',
      must ? '' : '<button class="btn ghost wide" style="margin-top:6px" data-action="close-overlay">返回</button>',
    ].join(''));
  }

  // 选完身份之后：切标签、拉云端、把同一个昵称已有的存档接回来
  async function afterIdentity(msg) {
    round = null;
    ui.cloudSaves = []; ui.lastError = '';
    St.setNoAnim(S().noAnim);
    tab = 'practice';
    if (St.isGuest()) {
      updateSyncBar(); closeOverlay(); render();
      toast(msg || '游客模式：只练不存');
      return;
    }
    await refreshCloudList(false);
    await autoRestore();
    await syncPending();
    updateSyncBar(); closeOverlay(); render();
    toast(msg || ('已进入 ' + St.profileName()));
  }

  /* ---------------- 我的（身份 / 同步 / 设置） ---------------- */
  function renderMe() {
    var s = S();
    if (St.isGuest()) return renderIdentity(false);
    var list = St.profileList().map(function (p) {
      return '<div class="profile-card' + (p.active ? ' on' : '') + '">' +
        '<div class="p-ico">' + esc(p.name.slice(0, 1)) + '</div>' +
        '<div class="p-body"><strong>' + esc(p.name) + (p.active ? ' · 当前' : '') + '</strong>' +
        '<span>Lv.' + p.level + ' · ' + p.blocks + ' 方块 · ' + p.wrong + ' 道错题</span></div>' +
        (p.active ? '' : '<button class="p-mini" data-action="profile-switch" data-id="' + p.id + '">切换</button>') +
        '<button class="p-mini" data-action="profile-rename" data-id="' + p.id + '">改名</button>' +
        '<button class="p-mini" data-action="profile-delete" data-id="' + p.id + '">删除</button>' +
      '</div>';
    }).join('');
    overlay([
      '<h2>我的</h2>',
      '<p class="muted">当前身份 <b>', esc(s.name), '</b> · Lv.', s.level, ' · ', s.blocks, ' 方块</p>',

      '<h3 style="margin-top:14px">身份</h3>',
      '<p class="tiny">每个昵称各有一份独立的错题、掌握度、进度和存档，互不干扰。改名只改称呼，不动存档。</p>',
      '<div style="margin:10px 0">', list, '</div>',
      '<label class="field"><span>新增一个昵称</span><input id="new-profile-name" placeholder="例如：小宇" maxlength="12" /></label>',
      '<div class="btn-row">',
        '<button class="btn primary" data-action="profile-add">新增</button>',
        '<button class="btn ghost" data-action="open-identity">切换 / 游客</button>',
      '</div>',

      '<h3 style="margin-top:16px">同步</h3>',
      '<div class="report-line"><span>连接</span><b>', (ui.cloudOk ? '已连接 · ' + ui.cloudSaves.length + ' 份存档' : esc(ui.cloudMsg || Cl.reason())), '</b></div>',
      '<div class="report-line"><span>最近同步</span><b>', esc(ui.lastSyncAt || '还没有'), '</b></div>',
      '<div class="report-line"><span>待同步</span><b>', s.pendingSync.length, ' 份</b></div>',
      ui.lastError ? '<p class="tiny" style="color:var(--red)">最近错误：' + esc(ui.lastError) + '</p>' : '',
      '<div class="btn-row" style="margin-top:10px">',
        '<button class="btn primary" data-action="sync-now">立即上传今天</button>',
        '<button class="btn" data-action="cloud-pull">从云端刷新进度</button>',
      '</div>',
      '<p class="tiny" style="margin-top:8px">本地始终先存一份；同步失败会标「待同步」，下次打开自动重试，不会静默丢数据。</p>',

      '<h3 style="margin-top:16px">礼物库</h3>',
      '<p class="tiny">礼物存在云端，所有设备共用一份；只有「', esc(St.giftOwner()), '」这个昵称能往里放礼物。</p>',
      '<button class="btn wide" data-action="gift-pool">打开礼物库（共 ', St.giftPool().length, ' 件）· 战利品 ',
        (s.loot || []).length, ' 件</button>',

      '<h3 style="margin-top:16px">设置</h3>',
      '<div class="switch-row"><span>关闭界面动效</span><button class="btn sm" data-action="toggle-anim">' + (s.noAnim ? '已关闭' : '开启中') + '</button></div>',
      '<div class="btn-row" style="margin-top:10px">',
        '<button class="btn" data-action="export-all">导出全部数据</button>',
        '<button class="btn" data-action="import-all">导入备份</button>',
      '</div>',
      '<button class="btn danger wide" style="margin-top:8px" data-action="reset-local">清空这个昵称的本地记录</button>',

      '<details class="me-adv"><summary>换设备 / 旧存档码</summary>',
        '<p class="tiny" style="margin-top:8px">现在只需要在新设备上输入同一个昵称即可。这里的码只用于升级前建的老档案（那时还没有「昵称即身份」）。</p>',
        '<div class="code-box" style="margin-top:8px"><code id="space-code">' + esc(s.spaceId) + '</code>',
          '<button class="btn sm" data-action="saves-copy">复制</button></div>',
        '<label class="field" style="margin-top:10px"><span>粘贴另一台设备的存档码</span><input id="space-input" placeholder="把存档码粘在这里" /></label>',
        '<button class="btn wide" data-action="saves-code-restore">粘贴并恢复进度</button>',
      '</details>',
      '<button class="btn ghost wide" style="margin-top:12px" data-action="close-overlay">收起</button>',
      '<input type="file" id="import-file" accept=".json,application/json" class="hidden" />',
    ].join(''));
  }

  /* ---------------- BOSS 战 ---------------- */
  var BOSS_NAMES = { u1: '爆爆苔', u2: '骨弓手', u3: '八足蛛', u4: '糖霜巨', u5: '绿胶怪',
                     u6: '尖刺眼', u7: '焰灵', u8: '铁甲猪', midterm: '墨影将', final: '墨影龙' };
  // 每个 boss 的攻击方式都贴合它的造型设定：吐息/射箭/吐丝/扔雪球/跳砸/激光/火球/冲撞/劈砍/自爆
  var BOSS_ATTACK = { u1: 'boom', u2: 'arrow', u3: 'web', u4: 'snow', u5: 'jump',
                      u6: 'laser', u7: 'fire', u8: 'charge', midterm: 'slash', final: 'breath' };
  // 每个 BOSS 一个整只的自绘全身像素形象（见 index.html 的 boss-* symbol）
  var BOSS_ART = { u1: 'boss-u1', u2: 'boss-u2', u3: 'boss-u3', u4: 'boss-u4',
                   u5: 'boss-u5', u6: 'boss-u6', u7: 'boss-u7', u8: 'boss-u8',
                   midterm: 'boss-mid', final: 'boss-final' };

  function startBoss(key, league) {
    league = St.LEAGUES[league] ? league : 'normal';
    if (St.isGuest()) { toast('取个昵称才能打 boss 和收战利品'); return; }
    if (!St.leagueUnlocked(league)) { toast('先把上一档的任意 boss 打通关'); return; }
    if (St.leagueLeft(league) <= 0) { toast('今天的挑战券用完了，去训练场练一练'); return; }
    var spec = St.bossSpec(key, league);
    if (!spec) return;
    if (!St.spendTicket(league)) return;
    startRound(Object.assign({}, spec, {
      battle: 'boss', bossKey: key,
      label: 'BOSS · ' + (BOSS_NAMES[key] || key),
      note: '答对就攻击，答错就挨打；打赢收战利品。',
    }));
  }

  // 训练场：同一只 boss 的题域，不扣券、不掉礼物、不判胜负；做完给准备度报告
  function startTraining(key, league, count) {
    league = St.LEAGUES[league] ? league : 'normal';
    if (St.isGuest()) { toast('取个昵称才能记训练成绩'); return; }
    var spec = St.bossSpec(key, league);
    if (!spec) return;
    startRound(Object.assign({}, spec, {
      count: Number(count) || 5, training: true, battle: '', bossKey: key,
      label: '训练场 · ' + (BOSS_NAMES[key] || key),
      note: '答错不打断，做完给你一份准备度报告。',
    }));
  }

  // 打到一半想撤：不判胜负、不发奖、不记错题，清掉这一趟回 boss 列表
  function quitBoss() {
    if (!round || round.battle !== 'boss') { render(); return; }
    var lg = round.league || 'normal';
    confirmSheet('退出这场战斗？', '这一趟的进度不保留，boss 回满血；这张挑战券会还给你。',
      '退出战斗', function () {
        round = null;
        St.clearRound();
        St.refundTicket(lg);
        render();
        openContinent();
      });
  }

  // 从云端拉一次全局礼物库；返回是否发生了变化（用来决定要不要重绘面板）
  function refreshGiftPool() {
    if (!window.YWCloud || !window.YWCloud.isReady()) return Promise.resolve(false);
    var before = JSON.stringify(St.giftPool());
    return window.YWCloud.listGifts().then(function (rows) {
      St.setGiftPool(rows);
      return before !== JSON.stringify(St.giftPool());
    }).catch(function () { return false; });
  }

  function finishBoss(outcome) {
    var won = outcome === 'win';
    var key = round.bossKey, league = round.league || 'normal';
    var name = BOSS_NAMES[key] || key;
    var myHp = round.myHp, myHpMax = round.myHpMax, bossLeft = round.bossHp;
    var hits = round.results.filter(function (r) { return r.correct; }).length;
    // 满血通关 = 掉两次取更好的那档（暗黑式「运气」，奖励答得干净）
    var perfect = won && myHp === myHpMax;
    var gift = won ? St.rollGift(key, { perfect: perfect, league: league }) : null;
    var result = won ? St.winBoss(key, gift, { league: league }) : null;
    var rk = St.rankInfo();
    var canAgain = St.leagueUnlocked(league) && St.leagueLeft(league) > 0;
    round = null; St.clearRound();
    render();
    var gt = result && result.gift ? (St.GIFT_TIER[result.gift.tier] || St.GIFT_TIER.white) : null;
    overlay([
      '<h2>', won ? '打赢了 ' + esc(name) + '！' : '被 ' + esc(name) + ' 打退了', '</h2>',
      '<p class="muted">' + esc(St.leagueInfo(league).name) + ' · 答对 ', hits, ' 次 · ',
        won ? ('剩 ' + myHp + ' / ' + myHpMax + ' 颗心') : ('boss 还剩 ' + bossLeft + ' 颗心'), '</p>',
      won && result && result.conquest && result.conquest.first
        ? '<p class="tiny">这一档首次征服！' + (result.conquest.unlocked
            ? '解锁「' + esc(St.leagueInfo(result.conquest.unlocked).name) + '」难度。' : '图鉴 +1。') + '</p>' : '',
      won && result && result.repeat
        ? '<p class="tiny">这一档已经打过它了，礼物只领一次；再来涨经验。</p>' : '',
      won && result && result.noGift && !result.repeat
        ? '<p class="tiny">礼物库还空着，让「' + esc(St.giftOwner()) + '」去「我的 → 礼物库」放几件礼物。</p>' : '',
      gt
        ? '<div class="loot-win tier-' + result.gift.tier + '">' +
            '<span class="loot-tier">' + gt.label + '礼物</span>' +
            '<b>' + esc(result.gift.name) + '</b>' +
            (perfect ? '<span class="tiny">满血通关，多掷了一次</span>' : '') +
            '<span class="tiny">不想要？回大陆分解成 ' + St.shardSell(result.gift.tier) + ' 块碎片</span>' +
          '</div>' : '',
      won ? '<p class="tiny">段位 ' + esc(rk.name) + ' · 经验 ' + rk.xp +
             (result ? ' · 保底再 ' + result.pityLeft + ' 次必出精良' : '') + '</p>' : '',
      !won ? '<div class="soft-land"><b>差 ' + bossLeft + ' 下就打倒了</b>' +
        '<span class="tiny">去训练场练一组，回来再打一次，心就稳了。</span></div>' : '',
      '<div class="btn-row" style="margin-top:12px">',
        !won ? '<button class="btn primary" data-action="training-quick" data-key="' + key +
               '" data-league="' + league + '">先练 3 题</button>' : '',
        won && canAgain ? '<button class="btn" data-action="boss-fight" data-key="' + key +
               '" data-league="' + league + '">再打一次</button>' : '',
        '<button class="btn primary" data-action="continent">回到大陆</button>',
        '<button class="btn ghost" data-action="close-overlay">先歇会儿</button>',
      '</div>',
    ].join(''));
  }

  function lootRow(x) {
    var tier = x.tier || 'white';
    var meta = St.GIFT_TIER[tier] || St.GIFT_TIER.white;
    return '<div class="loot-row tier-' + tier + '">' +
      '<span class="tier-dot"></span>' +
      '<b>' + esc(x.name || x.prize || '礼物') + '</b>' +
      '<span class="tier-label">' + meta.label + '</span>' +
      '<span class="tiny">来自 ' + esc(x.from === 'exchange' ? '碎片兑换' : (BOSS_NAMES[x.from] || x.from)) +
        ' · ' + esc(dLabel(x.at)) + '</span>' +
      (x.uid ? '<button class="btn sm ghost sell-btn" data-action="loot-sell" data-uid="' +
        esc(x.uid) + '">分解 +' + St.shardSell(tier) + '</button>' : '') + '</div>';
  }

  // 碎片商店：用分解来的字块碎片兑换礼物库里还存在的礼物
  function openShardShop() {
    if (St.isGuest()) { toast('取个昵称才能攒碎片'); return; }
    refreshGiftPool();
    var have = St.shards();
    var pool = St.giftPool().slice();
    var groups = {};
    St.GIFT_TIERS.forEach(function (t) { groups[t] = []; });
    pool.forEach(function (g) { (groups[g.tier] || groups.white).push(g); });
    var blocks = St.GIFT_TIERS.map(function (t) {
      var meta = St.GIFT_TIER[t], cost = St.shardBuy(t), items = groups[t];
      return [
        '<h3 class="tier-head tier-' + t + '">' + meta.label + ' · ' + cost + ' 碎片（' + items.length + ' 件）</h3>',
        items.length ? items.map(function (g) {
          var can = have >= cost;
          return '<div class="loot-row tier-' + t + '"><span class="tier-dot"></span><b>' + esc(g.name) + '</b>' +
            '<button class="btn sm ' + (can ? 'primary' : 'ghost') + '" data-action="shard-buy" data-id="' +
            esc(g.id) + '"' + (can ? '' : ' disabled') + '>' + cost + ' 碎片</button></div>';
        }).join('') : '<p class="tiny">这一档暂时没有礼物。</p>',
      ].join('');
    }).join('');
    overlay([
      '<h2>字块碎片商店</h2>',
      '<div class="shard-bar"><span>我的碎片</span><b>', have, '</b></div>',
      '<p class="muted">不想要的礼物可以分解成碎片：普通 +15 / 精良 +60 / 稀有 +150 / 传说 +300。',
        '攒够了就能换任意一档想要的礼物，全档通兑。</p>',
      blocks,
      '<div class="btn-row" style="margin-top:12px">',
        '<button class="btn" data-action="continent">回大陆</button>',
        '<button class="btn ghost" data-action="close-overlay">收起</button>',
      '</div>',
    ].join(''));
  }

  function openContinent() {
    if (St.isGuest()) { toast('取个昵称才能打 boss 和收战利品'); return; }
    // 顺手把云端礼物库刷新一下，掉到的礼物才是最新的
    refreshGiftPool().then(function (changed) {
      if (changed && document.querySelector('.overlay')) openContinent();
    });
    var league = ui.league;
    var info = St.leagueInfo(league), unlocked = St.leagueUnlocked(league);
    var rk = St.rankInfo();
    var tabs = St.LEAGUE_KEYS.map(function (k) {
      var L = St.leagueInfo(k), on = St.leagueUnlocked(k);
      return '<button class="league-tab' + (k === league ? ' active' : '') + (on ? '' : ' locked') +
        '" data-action="league-tab" data-league="' + k + '">' + esc(L.name) +
        '<span class="tiny">' + (on ? St.leagueLeft(k) + ' 张券' : '未解锁') + '</span></button>';
    }).join('');
    var cards = St.bossList(league).map(function (b) {
      var ready = St.trainingReady(b.key, league);
      return '<button class="boss-card' + (b.beaten ? ' beaten' : '') + '" data-action="boss-fight" ' +
        'data-key="' + b.key + '" data-league="' + league + '">' +
        '<svg class="boss-ico"><use href="#' + BOSS_ART[b.key] + '"></use></svg>' +
        '<strong>' + esc(BOSS_NAMES[b.key] || b.name) + '</strong>' +
        '<span class="tiny">' + b.tier + ' boss · ' + (b.beaten ? '已征服' : '准备度 ' + ready + '%') + '</span>' +
        '<span class="boss-ready"><i style="width:' + ready + '%"></i></span>' +
        (b.beaten ? '<span class="boss-flag">✓</span>' : '') +
      '</button>';
    }).join('');
    var loot = (S().loot || []).slice().reverse();
    overlay([
      '<h2>字块大陆 · BOSS 挑战</h2>',
      '<div class="league-head"><span class="rank-badge">', esc(rk.name), '</span>',
        '<span class="tiny">经验 ', rk.xp, ' · 保底再 ', St.pityLeft(), ' 次必出精良</span></div>',
      '<div class="league-tabs">', tabs, '</div>',
      unlocked
        ? '<p class="muted">' + esc(info.name) + '：今天还剩 <b>' + St.leagueLeft(league) +
          '</b> 次挑战。题目更活、心数更少；答对攻击，答错掉心。</p>'
        : '<p class="muted">这一档还没解锁。把 ' + esc(St.leagueInfo(info.unlockAt).name) +
          ' 的任意 boss 打通关一次就开了。</p>',
      '<div class="boss-grid">', cards, '</div>',
      '<div class="btn-row" style="margin-top:12px">',
        '<button class="btn" data-action="training-board" data-league="' + league + '">训练场 · 不扣券</button>',
        '<button class="btn" data-action="shard-shop">碎片商店（', St.shards(), '）</button>',
        '<button class="btn" data-action="gift-pool">礼物库（', St.giftPool().length, ' 件）</button>',
        '<button class="btn ghost" data-action="close-overlay">收起</button>',
      '</div>',
      '<h3 style="margin-top:16px">我的战利品（', loot.length, '）</h3>',
      loot.length ? '<div class="loot-list">' + loot.map(lootRow).join('') + '</div>'
                  : '<p class="tiny">还没有战利品。打赢一个 boss 就能开一次箱。</p>',
    ].join(''));
  }
  function openBossBoard() { openContinent(); }

  // 训练场：挑一只 boss 练一组，不扣券、不掉礼物、不判输赢
  function openTrainingBoard() {
    var league = ui.league;
    var cards = St.bossList(league).map(function (b) {
      var ready = St.trainingReady(b.key, league);
      return '<button class="train-card" data-action="training-start" data-key="' + b.key +
        '" data-league="' + league + '">' +
        '<svg class="boss-ico sm"><use href="#' + BOSS_ART[b.key] + '"></use></svg>' +
        '<b>' + esc(BOSS_NAMES[b.key] || b.name) + '</b>' +
        '<span class="tiny">准备度 ' + ready + '%</span>' +
        '<span class="boss-ready"><i style="width:' + ready + '%"></i></span></button>';
    }).join('');
    overlay([
      '<h2>训练场 · ' + esc(St.leagueInfo(league).name) + '</h2>',
      '<p class="muted">随便练，不扣挑战券、不掉礼物、答错也不打断。练到 90% 再上场，心里有底。</p>',
      '<div class="train-grid">', cards, '</div>',
      '<p class="tiny" style="margin-top:10px">训练也涨经验；错题照常进错题本。连续练对 10 题，每天能赢回 1 张普通挑战券。</p>',
      '<button class="btn ghost wide" style="margin-top:10px" data-action="continent">回大陆</button>',
    ].join(''));
  }

  function finishTraining() {
    var total = round.items.length;
    var right = round.results.filter(function (r) { return r.correct; }).length;
    var pct = total ? Math.round(right / total * 100) : 0;
    var key = round.bossKey, league = round.league || 'normal';
    var lgName = St.leagueInfo(league).name;
    var res = St.setTraining(key, league, pct, total);
    var name = BOSS_NAMES[key] || 'boss';
    // 建议只针对当前难度：普通练得好不代表噩梦、地狱也准备好了
    var tip = pct >= 90 ? lgName + '这一档可以上场了' : pct >= 80 ? '再稳一轮就能上场'
            : pct >= 60 ? '继续练，错的地方看解析' : '先把解析看懂，再来一遍';
    round = null; St.clearRound(); render();
    overlay([
      '<h2>训练完成 · ' + esc(name) + '</h2>',
      '<p class="muted">做对 ' + right + ' / ' + total + ' 题</p>',
      '<div class="ready-report"><b>' + pct + '%</b><span>' + esc(tip) + '</span></div>',
      res.bonus ? '<div class="ticket-win">连对 10 题！普通挑战券 +1</div>' : '',
      '<p class="tiny" style="margin-top:10px">训练场不掉礼物、不扣券，但错题会进错题本，答对也照常涨经验。</p>',
      '<div class="btn-row" style="margin-top:12px">',
        '<button class="btn" data-action="training-start" data-key="' + key + '" data-league="' + league + '">再练一组</button>',
        '<button class="btn primary" data-action="boss-fight" data-key="' + key + '" data-league="' + league + '">去挑战</button>',
        '<button class="btn ghost" data-action="continent">回大陆</button>',
      '</div>',
    ].join(''));
  }

  // 全局礼物库：所有人都能看，只有 owner 昵称能加/删（云端 RLS 也按 created_by 拦）
  function openGiftPool(notice) {
    if (St.isGuest()) { toast('取个昵称才能看礼物库'); return; }
    var mine = St.canManageGifts();
    var pool = St.giftPool();
    var groups = {};
    St.GIFT_TIERS.forEach(function (t) { groups[t] = []; });
    pool.forEach(function (g) { (groups[g.tier] || groups.white).push(g); });

    var rateRows = [['small', '小 boss'], ['mid', '中 boss'], ['big', '大 boss']].map(function (p) {
      var w = St.GIFT_WEIGHTS[p[0]];
      return '<div class="rate-row"><span>' + p[1] + '</span>' + St.GIFT_TIERS.map(function (t) {
        return '<b class="tier-' + t + '">' + St.GIFT_TIER[t].label + ' ' + w[t] + '%</b>';
      }).join('') + '</div>';
    }).join('');

    var tierBlocks = St.GIFT_TIERS.map(function (t) {
      var meta = St.GIFT_TIER[t];
      var items = groups[t];
      return [
        '<h3 class="tier-head tier-' + t + '">' + meta.label + '（' + items.length + '）</h3>',
        items.length ? items.map(function (g) {
          return '<div class="loot-row tier-' + t + '"><span class="tier-dot"></span><b>' + esc(g.name) + '</b>' +
            (mine ? '<button class="btn sm ghost" data-action="gift-del" data-id="' + g.id + '">删除</button>' : '') +
            '</div>';
        }).join('') : '<p class="tiny">这一档还空着。</p>',
      ].join('');
    }).join('');

    overlay([
      '<h2>礼物库</h2>',
      '<p class="muted">礼物放在云端，所有设备都能掉同一批。共 ', pool.length, ' 件。</p>',
      notice ? '<p class="tiny" style="color:var(--red)">' + esc(notice) + '</p>' : '',
      '<div class="rate-box"><p class="tiny">掉落概率（暗黑式：越大的 boss 越容易出高阶礼物）</p>', rateRows, '</div>',
      mine
        ? [
            '<div class="gift-form">',
              '<label class="field"><span>礼物名字（最多 16 字）</span>' +
                '<input id="gift-name" maxlength="16" placeholder="例如：周末多玩半小时" /></label>',
              '<label class="field"><span>档次</span><select id="gift-tier">',
                St.GIFT_TIERS.map(function (t) {
                  return '<option value="' + t + '">' + St.GIFT_TIER[t].label + '</option>';
                }).join(''),
              '</select></label>',
              '<button class="btn primary wide" data-action="gift-add">放进礼物库</button>',
            '</div>',
            '<p class="tiny">只有「' + esc(St.giftOwner()) + '」这个昵称能往库里放礼物。</p>',
          ].join('')
        : '<p class="tiny">礼物库由「' + esc(St.giftOwner()) + '」管理，你负责打 boss 开箱。</p>',
      tierBlocks,
      '<div class="btn-row" style="margin-top:12px">',
        '<button class="btn ghost" data-action="gift-refresh">刷新</button>',
        '<button class="btn ghost" data-action="close-overlay">收起</button>',
      '</div>',
    ].join(''));
  }

  /* ---------------- 练习闭环 ---------------- */
  function startRound(spec) {
    // 已有未完成的这一趟时不静默覆盖，改用应用内确认框
    if (!spec.force && St.loadRound()) {
      pendingStart = spec;
      confirmSheet('还有一趟没做完', '要放弃它、重新开始吗？', '放弃并重新开始', function () {
        var next = Object.assign({}, pendingStart, { force: true });
        pendingStart = null;
        startRound(next);
      });
      return;
    }
    pendingStart = null;
    stopChallengeTimer();
    St.clearRound();
    var r = St.buildRound(spec);
    if (!r.items.length) { toast('这个范围里还没有题目，换个范围试试'); return; }
    round = {
      spec: spec, label: spec.label || r.label, note: r.note, mode: r.mode, items: r.items,
      idx: 0, selected: null, phase: 'ask', results: [],
      challenge: !!spec.challenge,
      battle: spec.battle === 'boss' ? 'boss' : '',
      league: spec.league || '',
      training: !!spec.training,
      wrongDmg: Number(spec.wrongDmg) || 1,
      bossKey: spec.bossKey || '',
      bossHp: Number(spec.bossHp) || 0,
      bossHpMax: Number(spec.bossHp) || 0,
      myHp: Number(spec.myHp) || 0,
      myHpMax: Number(spec.myHp) || 0,
      fillMode: 'fill', fillInput: '', orderPicks: [],
    };
    tab = 'practice';
    St.saveRound(round);
    closeOverlay();
    render();
    if (round.challenge) startChallengeTimer();
    window.scrollTo(0, 0);
  }

  function renderPractice() {
    if (!round) return renderPracticeHome();
    return renderQuestion();
  }

  // 上一趟的结果条：结算完直接回首页，结果留成一条可收起的通报，
  // 不再把用户卡在「再来一趟」的结算页上。
  function runCard(run) {
    if (!run || !run.results || !run.results.length) return '';
    var rs = run.results;
    var ok = rs.filter(function (r) { return r.correct; }).length;
    var cnt = { careless: 0, confused: 0, unknown: 0 };
    rs.forEach(function (r) { if (r.type && cnt[r.type] !== undefined) cnt[r.type] += 1; });
    var wrong = rs.length - ok;
    var mobs = rs.map(function (r, i) {
      return '<span class="mob-slot ' + (r.correct ? 'done' : 'wrong') + '" style="--i:' + i + '">' +
             mobSvg(MOB_KINDS[i % 3]) + '</span>';
    }).join('');
    var detail = wrong
      ? (St.isGuest()
          ? '看错了 ' + cnt.careless + ' · 记混了 ' + cnt.confused + ' · 还没学会 ' + cnt.unknown + '（游客模式不入错题集）'
          : '看错了 ' + cnt.careless + ' · 记混了 ' + cnt.confused + ' · 还没学会 ' + cnt.unknown + '，都进错题集了。')
      : '全对！这一趟没有错题。';
    return [
      '<div class="card run-card">',
        '<div class="run-top">',
          '<span class="q-meta">这一趟 · 挖完了</span>',
          '<button class="run-x" data-action="run-dismiss" aria-label="收起这条结果" type="button">×</button>',
        '</div>',
        '<h3>', esc(run.label), '　', rs.length, ' 题 · 对 ', ok, '</h3>',
        '<div class="run-mobs">', mobs, '</div>',
        '<p class="muted">', detail, '</p>',
        '<div class="btn-row" style="margin-top:10px">',
          '<button class="btn sm primary" data-action="again">再挖一趟（同样范围）</button>',
          (wrong && !St.isGuest()) ? '<button class="btn sm ghost" data-action="go-wrong">看错题</button>' : '',
          run.mode === 'exam' ? '<button class="btn sm" data-action="run-report">这次的分析</button>' : '',
        '</div>',
      '</div>',
    ].join('');
  }

  function renderPracticeHome() {
    var s = S(), d = St.todayKey(), today = s.daily[d] || { attempts: 0, correct: 0, careless: 0 };

    // 做到一半的这一趟：待办条，刷新或换设备回来都能接着做
    var pending = St.loadRound();
    var todo = '';
    if (pending) {
      var doneCount = pending.results.length;
      var dots = mobRow(pending.items, pending.results, pending.idx);
      todo = [
        '<div class="card todo-card">',
          '<span class="q-meta">未完成 · 待办</span>',
          '<h3>', esc(pending.label), ' 还差 ', pending.items.length - doneCount, ' 位</h3>',
          '<p class="muted">已经做到第 ', Math.min(doneCount + 1, pending.items.length), ' / ',
            pending.items.length, ' 位，随时可以接着做完。</p>',
          '<div class="round-dots" style="margin:10px 0">', dots, '</div>',
          '<div class="btn-row">',
            '<button class="btn primary" data-action="resume-round">接着做完</button>',
            '<button class="btn ghost" data-action="drop-round">放弃这一趟</button>',
          '</div>',
        '</div>',
      ].join('');
    }

    var rk = St.rankInfo();
    var conqAll = 0;
    St.LEAGUE_KEYS.forEach(function (k) {
      conqAll += St.bossList(k).filter(function (b) { return b.beaten; }).length;
    });

    view.innerHTML = [
      '<div class="section-title"><h2>字块大陆</h2><span class="tiny">', esc(window.YW_EDITION), '</span></div>',
      runCard(s.lastRun),
      todo,
      '<div class="card continent-card">',
        '<div class="rank-line"><span class="rank-badge">', esc(rk.name), '</span>',
          '<span class="tiny">经验 ', rk.xp, rk.next ? ' · 再 ' + rk.toNext + ' 升 ' + esc(rk.next.name) : ' · 已满级',
          '</span></div>',
        '<div class="rank-track"><i style="width:', rk.pct, '%"></i></div>',
        '<h2>今天去哪打</h2>',
        '<p class="muted">普通、噩梦、地狱三档，题目和容错都不一样。训练场随便练，不扣次数。</p>',
        '<button class="btn primary wide continent-entry" data-action="continent">进入字块大陆',
          '<span class="badge-done">', conqAll, '/30 已征服</span></button>',
        '<div class="ticket-row">',
          St.LEAGUE_KEYS.map(function (k) {
            var info = St.leagueInfo(k), on = St.leagueUnlocked(k);
            return '<span class="ticket' + (on ? '' : ' locked') + '">' + esc(info.name) + ' ' +
              (on ? St.leagueLeft(k) + ' 张' : '未解锁') + '</span>';
          }).join(''),
        '</div>',
        '<p class="tiny" style="margin-top:8px">今天做过 ', today.attempts, ' 题，一次就对 ', today.correct, ' 题。',
          St.isGuest() ? '游客模式：进度不存，先取个昵称吧。' : '打到一半会自动存成待办。', '</p>',
      '</div>',
      St.isGuest() ? guestCard() : towerCard(),
      St.isGuest() ? '<p class="tiny" style="text-align:center">想要错题本和回忆录，就取个昵称。</p>'
                   : '<p class="tiny" style="text-align:center">到期的错题会自己冒出来，混进这一趟里。</p>',
    ].join('');
  }

  function highlight(stem, focus) {
    var s = esc(stem);
    (focus || []).forEach(function (w) {
      if (!w) return;
      s = s.split(esc(w)).join('<mark class="focus">' + esc(w) + '</mark>');
    });
    return s;
  }

  function renderQuestion() {
    var it = round.items[round.idx], q = it.q, fb = round.phase === 'feedback';
    var last = round.results[round.results.length - 1];
    var dots = mobRow(round.items, round.results, round.idx);
    var opts = q.options.map(function (o, i) {
      var cls = 'opt';
      if (fb) {
        if (i === q.answer) cls += ' correct';
        else if (i === last.selected) cls += ' incorrect';
      } else if (round.selected === i) cls += ' selected';
      return '<button type="button" class="' + cls + '" data-action="opt" data-idx="' + i + '"' + (fb ? ' disabled' : '') + '>' +
             '<span class="key">' + 'ABCD'[i] + '</span><span>' + esc(o) + '</span></button>';
    }).join('');
    // 三种输出题都只是换呈现，答案仍映射回原来的选项索引。
    var kind = it.outKind || (it.asFill ? 'fill' : '');
    var useFill = !!(kind === 'fill' && q.fill && round.fillMode !== 'choice' && !fb);
    var useSpot = !!(kind === 'spot' && q.spot && !fb);
    var useOrder = !!(kind === 'order' && q.order && !fb);
    var answerHtml = opts;
    if (useFill) {
      answerHtml = [
        '<div class="fill-box">',
          '<label class="tiny" for="fill-input">空里该写什么？写一个字就行</label>',
          '<input id="fill-input" class="fill-input" type="text" maxlength="6" autocomplete="off"',
            ' value="', esc(round.fillInput || ''), '" placeholder="在这里写" />',
          '<div class="btn-row" style="margin-top:10px">',
            '<button type="button" class="btn primary" data-action="fill-submit">写好啦，提交</button>',
            '<button type="button" class="btn ghost" data-action="fill-choice">打不出来，看选项</button>',
          '</div>',
        '</div>',
      ].join('');
    } else if (useSpot) {
      var spotOpts = q.options.map(function (o, i) {
        return '<button type="button" class="spot-char' + (round.selected === i ? ' on' : '') +
               '" data-action="spot" data-idx="' + i + '">' + esc(o) + '</button>';
      }).join('');
      answerHtml = [
        '<div class="spot-box">',
          '<p class="tiny">这句话里有一个字写错了，点出来</p>',
          '<div class="spot-sentence">', esc(q.spot.text), '</div>',
          '<div class="spot-chars">', spotOpts, '</div>',
          '<p class="tiny">不用打字，点一下那个写错的字。</p>',
        '</div>',
      ].join('');
    } else if (useOrder) {
      var lines = q.order.lines.slice();
      var orderOpts = lines.map(function (line, i) {
        var pickedIdx = (round.orderPicks || []).indexOf(i);
        return '<button type="button" class="opt order-line' + (pickedIdx >= 0 ? ' picked' : '') +
               '" data-action="order-pick" data-idx="' + i + '">' +
               '<span class="key">' + (pickedIdx >= 0 ? pickedIdx + 1 : '·') + '</span>' +
               '<span>' + esc(line) + '</span></button>';
      }).join('');
      answerHtml = [
        '<div class="order-box">',
          '<p class="tiny">给诗句排顺序：先点上一句，再点它的下一句</p>',
          '<div class="order-first">', esc(q.order.first), '</div>',
          '<div class="options">', orderOpts, '</div>',
          '<div class="btn-row" style="margin-top:10px">',
            '<button type="button" class="btn primary" data-action="order-submit"' +
              ((round.orderPicks || []).length === 2 ? '' : ' disabled') + '>就这个顺序</button>',
            '<button type="button" class="btn ghost" data-action="order-reset">重新排</button>',
          '</div>',
        '</div>',
      ].join('');
    }
    // 刚被打掉的心：只在这一次渲染里标一下，播完碎裂动画就清掉
    var brokeMe = round.brokeMe; round.brokeMe = null;
    var brokeBoss = round.brokeBoss; round.brokeBoss = null;
    var bossHtml = round.battle === 'boss' ? [
      '<div class="arena" id="arena">',
        '<div class="arena-top">',
          '<div class="hp-side"><span class="hp-who">我</span>',
            heartsRow(round.myHp || 0, round.myHpMax || 1, 'me', brokeMe), '</div>',
          '<div class="hp-side boss-side">',
            heartsRow(round.bossHp || 0, round.bossHpMax || 1, 'boss', brokeBoss),
            '<span class="boss-tag">', esc(BOSS_NAMES[round.bossKey] || 'BOSS'), '</span></div>',
        '</div>',
        '<div class="arena-floor">',
          '<div class="fighter hero" id="f-hero">',
            '<svg class="fighter-sprite" viewBox="0 0 32 32" shape-rendering="crispEdges" aria-hidden="true">',
              '<use href="#hero-moss"></use></svg>',
          '</div>',
          '<div class="fighter enemy" id="f-enemy">',
            '<svg class="fighter-sprite" viewBox="0 0 32 32" shape-rendering="crispEdges" aria-hidden="true">',
              '<use href="#', BOSS_ART[round.bossKey] || 'boss-u1', '"></use></svg>',
          '</div>',
          '<div class="fx" id="fx"></div>',
          '<div class="slash" id="slash"></div>',
          '<div class="dmg" id="dmg"></div>',
        '</div>',
        '<div class="arena-tip">',
          '<span>', esc(attackHint(round.bossKey)), '</span>',
          '<button type="button" class="arena-quit" data-action="boss-quit">退出战斗</button>',
        '</div>',
      '</div>',
    ].join('') : '';
    var challengeHtml = round.challenge ? [
      '<div class="challenge-bar">',
        '<span>今日挑战 · <b id="chal-time">', challengeLeft, '</b> 秒</span>',
        '<div class="challenge-track"><i id="chal-fill" style="width:', (challengeLeft / 30 * 100), '%"></i></div>',
        '<span class="tiny">时间到也能做完</span>',
      '</div>',
    ].join('') : '';
    var src = sourceOf(q);
    var feedback = '';
    if (fb) {
      feedback = [
        '<div class="feedback', last.correct ? '' : ' bad', '">',
          '<strong>', last.correct ? '答对了，来了一位新伙伴' : '再看一眼，这块先记下来', '</strong>',
          '<p>', esc(q.tip), '</p>',
          last.type ? '<span class="err-tag">错因归类：' + typeName(last.type) +
            (St.isGuest() ? '（游客模式不入错题集）' : ' · 已自动进错题集') + '</span>' : '',
        '</div>',
      ].join('');
    }
    view.innerHTML = [
      '<div class="section-title"><h2>', esc(round.label), '</h2><span class="tiny">', round.idx + 1, ' / ', round.items.length, ' 题</span></div>',
      bossHtml,
      challengeHtml,
      '<div class="round-head"><div class="round-dots">', dots, '</div><span class="tiny">',
        round.challenge ? '挑战进行中' : '不用赶时间', '</span></div>',
      feedback,
      '<div class="card">',
        '<div class="q-source"><b>', esc(src.book), '</b><span>', esc(src.unit), '</span></div>',
        '<span class="q-meta">', esc(dimName(q.dim)), ' · ', esc(kpName(q.kp)), '</span>',
        '<div class="q-stem">', esc(q.stem), '</div>',
        answerHtml,
        useFill ? '' : '<div class="action-bar">' +
          '<button class="btn primary wide" data-action="submit"' + (round.selected === null ? ' disabled' : '') + '>确认提交并继续</button>' +
        '</div>',
      '</div>',
      '<p class="tiny" style="text-align:center">', esc(round.note), '</p>',
    ].join('');
  }

  /* 分层解析块：错因 → 逐项排除 → 正解回扣 → 方法口诀 → 遮住重做 */
  function exBlock(no, title, text, cls) {
    return '<div class="ex-block ' + cls + '"><h4><i>' + no + '</i>' + title +
           '</h4><p>' + esc(text) + '</p></div>';
  }
  function explainBlocks(q, sel) {
    var ex = window.YWExplain.of(q);
    return [
      exBlock('①', sel >= 0 ? '你选的这项，错在哪' : '容易选错的项，错在哪',
              sel >= 0 ? window.YWExplain.whyWrong(q, sel)
                       : '把四个选项都读完，先把明显不对的划掉，再挑剩下的。', 'ex-wrong'),
      exBlock('②', '正确答案为什么对', ex.right, 'ex-right'),
      exBlock('③', '这题考的是什么', ex.point, 'ex-point'),
      exBlock('④', '下次怎么想', ex.method, 'ex-method'),
      '<div class="ex-check">', esc(ex.check), '</div>',
    ].join('');
  }
  function diagnose(type) {
    return '<div class="ex-diagnose"><span class="badge">' + esc(typeName(type)) +
           '</span><p>' + esc(window.YWExplain.coach(type)) + '</p></div>';
  }

  function openMirror(last, q) {
    var sel = last.selected, ans = q.answer, src = sourceOf(q);
    var focusTip = (q.focus || []).filter(Boolean).slice(0, 3);
    overlay([
      '<h2>巡查镜 · 这块没挖对</h2>',
      '<div class="q-source"><b>', esc(src.book), '</b><span>', esc(src.unit), '</span></div>',
      diagnose(last.type),
      '<div class="mirror-stem">', highlight(q.stem, q.focus), '</div>',
      '<div class="mirror-pick">你选了 <b>', 'ABCD'[sel], '. ', esc(q.options[sel]),
        '</b>　正确的是 <b>', 'ABCD'[ans], '. ', esc(q.options[ans]), '</b></div>',
      explainBlocks(q, sel),
      focusTip.length ? '<div class="ex-focus">这题要盯住：' + focusTip.map(function (x) { return esc(x); }).join(' · ') + '</div>' : '',
      '<button class="btn primary wide" data-action="mirror-back">我看明白了，继续</button>',
    ].join(''));
  }

  // 错题集里回看：沿用同一套分层解析，复习时不只是「看一眼答案」
  function openExplain(q, sel, type) {
    var src = sourceOf(q);
    overlay([
      '<h2>这道错题，再看一遍</h2>',
      '<div class="q-source"><b>', esc(src.book), '</b><span>', esc(src.unit), '</span></div>',
      diagnose(type),
      '<div class="mirror-stem">', highlight(q.stem, q.focus), '</div>',
      '<div class="mirror-pick">正确的是 <b>', 'ABCD'[q.answer], '. ', esc(q.options[q.answer]), '</b>' +
        (sel >= 0 ? '　上次选了 <b>' + 'ABCD'[sel] + '. ' + esc(q.options[sel]) + '</b>' : '') + '</div>',
      explainBlocks(q, sel),
      '<div class="btn-row" style="margin-top:10px">',
        '<button class="btn ghost" data-action="mirror-back">看完了</button>',
        '<button class="btn primary" data-action="redo" data-qid="', esc(q.id), '">遮住答案，重做这道</button>',
      '</div>',
    ].join(''));
  }

  function submitAnswer() {
    var it = round.items[round.idx], q = it.q, sel = round.selected;
    if (sel === null) return;
    var correct = sel === q.answer;
    var type = correct ? '' : St.classify(q, sel);
    var lvBefore = S().level;
    var payload = St.recordAnswer(q, sel, correct, it.isReview);
    var gained = St.lastGaveBlock();
    var leveled = S().level > lvBefore;
    var last = { qid: q.id, correct: correct, type: type, selected: sel };
    round.results.push(last);
    round.phase = 'ask';
    // 确定性成长：答对多涨、答错也涨一点——哪怕输了也在往前走（暗黑 3 巅峰等级思路）
    St.gainXp(correct ? 2 * (St.leagueInfo(round.league || 'normal').xpMul) : 1);
    // BOSS 战：答对砍 boss 一格血，答错按难度扣 1 或 2 颗心。只影响血条，不改砖数口径。
    if (round.battle === 'boss') {
      if (correct) round.bossHp = Math.max(0, (round.bossHp || 0) - 1);
      else round.myHp = Math.max(0, (round.myHp || 0) - (round.wrongDmg || 1));
      // 记下刚碎掉的是哪一颗心，下一次渲染播一次碎裂动画
      if (correct) round.brokeBoss = round.bossHp; else round.brokeMe = round.myHp;
      arenaHit(correct, round.wrongDmg || 1);
      round.phase = 'anim';               // 动画期间锁住输入，防止连点跳过战斗
      var over = round.bossHp <= 0 ? 'win'
        : (round.myHp <= 0 || round.idx + 1 >= round.items.length) ? 'lose' : null;
      toast(correct ? '命中！' : '被反击了，注意看解析');
      syncDate(payload);
      setTimeout(function () {
        if (!round || round.battle !== 'boss') return;
        round.phase = 'ask';
        if (over) { finishBoss(over); return; }
        advance();
        if (!correct) openMirror(last, q);
      }, 700);
      return;
    }
    // 连对只给反馈，不加砖、不改计分口径；每三题庆祝一次
    var chain = 0;
    for (var ci = round.results.length - 1; ci >= 0 && round.results[ci].correct; ci--) chain++;
    var comboHit = chain >= 3 && chain % 3 === 0;
    if (comboHit) comboBurst(chain);
    // 一次点击即推进：不再停在「下一块」中转页
    advance();
    // 只有答错才用快照复盘刚才那题；下一块已经在下面等着了
    var msg;
    if (!correct) msg = null;
    else if (St.isGuest()) msg = '答对了';
    else if (leveled) msg = '第 ' + (S().level - 1) + ' 座塔住满了！升到 Lv.' + S().level + '，新塔开工';
    else if (gained) msg = '答对了，来了一位新伙伴';
    else msg = '答对了，这道题今天已经算过砖了';
    if (comboHit) msg = '连对 ' + chain + ' 题！伙伴们排成队了';
    if (!correct) {
      openMirror(last, q);
      if (endToast) { toast(endToast); endToast = null; }
    } else if (endToast) { toast(endToast); endToast = null; }
    else if (msg) toast(msg);
    syncDate(payload);
  }

  // 「补一个字」的输入判定：把输入的字映射回原来的选项索引，
  // 这样计分、错因归类、错题集、掌握度全部沿用原逻辑，不另起一套。
  function submitFill() {
    if (!round || (round.items[round.idx].outKind || (round.items[round.idx].asFill ? 'fill' : '')) !== 'fill') return;
    var q = round.items[round.idx].q;
    var el = document.getElementById('fill-input');
    var raw = el ? el.value.trim() : '';
    if (!raw) { toast('先写一个字试试'); if (el) el.focus(); return; }
    var norm = raw.replace(/[\s，。！？、：；"'·]/g, '');
    var hit = (q.fill.accepts || []).some(function (a) {
      return String(a).replace(/\s/g, '') === norm;
    });
    round.selected = hit ? q.answer
      : (q.trap && q.trap.length ? q.trap[0] : (q.answer + 1) % q.options.length);
    round.fillInput = raw;
    St.saveRound(round);
    submitAnswer();
  }
  function fillToChoice() {
    if (!round) return;
    round.fillMode = 'choice';
    round.selected = null;
    round.fillInput = '';
    St.saveRound(round);
    render();
  }

  // 挑错字：点中句子里写错的那个字 = 认出了正确写法，映射回原题的正确项。
  // 点中别的字则映射到一个干扰项，错因归类照旧。
  function submitSpot(idx) {
    if (!round || round.phase !== 'ask') return;
    var it = round.items[round.idx], q = it.q;
    if (!q.spot) return;
    idx = Number(idx);
    round.selected = (idx === q.spot.wrongIndex) ? q.answer
      : (q.trap && q.trap.length ? q.trap[0] : (q.answer + 1) % q.options.length);
    St.saveRound(round);
    submitAnswer();
  }

  // 排顺序：正确顺序是「上一句 → 下一句」，孩子只要点中那句下一句即可。
  // 映射回原题的正确选项索引，计分/错题/掌握度都不变。
  function orderPicked(idx) {
    if (!round || round.phase !== 'ask') return;
    idx = Number(idx);
    round.orderPicks = round.orderPicks || [];
    var at = round.orderPicks.indexOf(idx);
    if (at >= 0) round.orderPicks.splice(at, 1);
    else if (round.orderPicks.length < 2) round.orderPicks.push(idx);
    else round.orderPicks = [idx];
    St.saveRound(round);
    render();
  }
  function orderReset() {
    if (!round) return;
    round.orderPicks = []; round.selected = null;
    St.saveRound(round); render();
  }
  function submitOrder() {
    if (!round || round.phase !== 'ask') return;
    var it = round.items[round.idx], q = it.q;
    if (!q.order || (round.orderPicks || []).length !== 2) return;
    // 第二句点中正确下一句即算对；错则映射到某个干扰项，保留错因归类
    var second = round.orderPicks[1];
    round.selected = (second === q.answer) ? q.answer
      : (q.trap && q.trap.length ? q.trap[0] : (q.answer + 1) % q.options.length);
    St.saveRound(round);
    submitAnswer();
  }

  function advance() {
    // BOSS 战：血量先分胜负，题目只是攻击机会；血尽即结算，不写平常的结果条。
    if (round.battle === 'boss') {
      var outcome = null;
      if (round.bossHp <= 0) outcome = 'win';
      else if (round.myHp <= 0) outcome = 'lose';
      else if (round.idx + 1 >= round.items.length) outcome = 'lose'; // 题用完还没打死
      if (outcome) { finishBoss(outcome); return; }
    }
    if (round.idx + 1 >= round.items.length) {
      // 训练场不判输赢，做完直接给准备度报告
      if (round.training) { finishTraining(); return; }
      // 订正完回错题集，且不覆盖当天真实成绩的那条结果
      if (round.isRedo) tab = 'wrong';
      else {
        // 结算完不留「完成页」：把结果记一条，直接回首页重新选
        St.setLastRun({
          label: round.label, mode: round.mode, spec: round.spec || {}, note: round.note || '',
          results: round.results.slice(), at: St.todayKey(),
        });
      }
      if (round.challenge) {
        stopChallengeTimer();
        var firstBadge = St.markChallenge();
        endToast = firstBadge ? '今日挑战完成，拿到一枚徽章！' : '今日挑战完成！';
      }
      round = null;
      St.clearRound();
    } else {
      round.idx += 1; round.selected = null; round.phase = 'ask';
      round.fillInput = ''; round.orderPicks = [];
      St.saveRound(round);
    }
    render();
    window.scrollTo(0, 0);
  }

  // 「这次的分析」：专项/整卷才看得到逐项报告，日常 5 题不必打扰
  function openRunReport(run) {
    var rs = run.results;
    var ok = rs.filter(function (r) { return r.correct; }).length;
    var cnt = { careless: 0, confused: 0, unknown: 0 };
    var byKp = {};
    rs.forEach(function (r) {
      if (r.correct) return;
      if (r.type && cnt[r.type] !== undefined) cnt[r.type] += 1;
      var q = window.YW_Q_BY_ID[r.qid];
      if (q) byKp[q.kp] = (byKp[q.kp] || 0) + 1;
    });
    var weak = Object.keys(byKp).sort(function (a, b) { return byKp[b] - byKp[a]; }).slice(0, 3);
    overlay([
      '<h2>', esc(run.label), ' · 这次的分析</h2>',
      '<p class="muted">', esc(run.at), ' · 共 ', rs.length, ' 题</p>',
      '<div class="report-line"><span>正确率</span><b>', Math.round(ok / rs.length * 100), '%（', ok, '/', rs.length, '）</b></div>',
      '<div class="report-line"><span>看错了</span><b>', cnt.careless, ' 题</b></div>',
      '<div class="report-line"><span>记混了</span><b>', cnt.confused, ' 题</b></div>',
      '<div class="report-line"><span>还没学会</span><b>', cnt.unknown, ' 题</b></div>',
      '<p class="muted" style="margin-top:10px">建议专项：',
        weak.length ? weak.map(kpName).join('、') : '没有明显薄弱点，保持就好', '</p>',
      '<div class="btn-row" style="margin-top:12px">',
        weak.length ? '<button class="btn primary" data-action="start-mode" data-mode="topic" data-kp="' + esc(weak[0]) + '">练一下' + esc(kpName(weak[0])) + '</button>' : '',
        '<button class="btn ghost" data-action="mirror-back">知道了</button>',
      '</div>',
    ].join(''));
  }

  /* ---------------- 回忆录 · 复习中心 ---------------- */
  function renderPast() {
    var s = S();
    var pastAll = window.YW_pastQuestions(s.grade, s.term);
    var pastWrong = Object.keys(s.wrong).filter(function (id) {
      var q = window.YW_Q_BY_ID[id], w = s.wrong[id];
      return q && q.grade < s.grade && !w.graduated;
    }).length;
    var grades = [];
    for (var g = 1; g < s.grade; g++) grades.push(g);
    var gradeButtons = grades.map(function (g) {
      return '<button data-action="past-grade" data-grade="' + g + '"' + (ui.pastGrade === g ? ' class="on"' : '') + '>' + g + ' 年级</button>';
    }).join('');
    var gradeSel = '';
    for (var i = 1; i <= 6; i++) gradeSel += '<option value="' + i + '"' + (s.grade === i ? ' selected' : '') + '>' + i + ' 年级</option>';
    var dimButtons = Object.keys(window.YW_DIMS).map(function (k) {
      return '<button data-action="topic-kp" data-kp="dim:' + k + '"' + (ui.topicKp === 'dim:' + k ? ' class="on"' : '') + '>' + esc(window.YW_DIMS[k].label) + '</button>';
    }).join('');
    var kpButtons = Object.keys(window.YW_KP).map(function (k) {
      return '<button data-action="topic-kp" data-kp="' + k + '"' + (ui.topicKp === k ? ' class="on"' : '') + '>' + esc(window.YW_KP[k].label) + '</button>';
    }).join('');
    var ex = window.YW_EXAM[ui.scopeKey];
    var scope = s.examScope[ui.scopeKey] || ex.units;
    var scopeButtons = window.YW_UNITS.map(function (u) {
      return '<button data-action="scope-toggle" data-unit="' + u.id + '"' + (scope.indexOf(u.id) >= 0 ? ' class="on"' : '') + '>第 ' + u.id + ' 单元</button>';
    }).join('');

    view.innerHTML = [
      '<div class="review-hero">',
        '<h2>回忆录</h2>',
        '<p class="muted">把学过的都捞回来。当前 <span class="grade-big">', s.grade, ' 年级', s.term, '册</span>；之前的册次和更早年级的题目、旧错题都会自动进这里，切换到新册不用搬家、不用导数据。</p>',
        '<div class="grade-row"><button data-action="past-grade" data-grade="0"' + (ui.pastGrade === 0 ? ' class="on"' : '') + '>全部过往</button>', gradeButtons, '</div>',
        '<p class="tiny">过往题库 ', pastAll.length, ' 道 · 其中历史错题 ', pastWrong, ' 道', grades.length ? '' : '（当前已是 1 年级，暂无更低年级题目）', '</p>',
        '<button class="btn primary wide" style="margin-top:10px" data-action="start-past" data-grade="' + ui.pastGrade + '">开始复习过往</button>',
      '</div>',

      '<div class="card"><h3>现在读几年级</h3>',
        '<p class="muted">换年级或换册后，之前学过的题目和错题自动进「回忆录」，进度会从新册第一单元开始。</p>',
        '<div class="btn-row" style="margin-top:10px">',
          '<select id="grade-select" aria-label="当前年级">', gradeSel, '</select>',
          '<select id="term-select" aria-label="上册或下册"><option value="上"' + (s.term === '上' ? ' selected' : '') + '>上册</option><option value="下"' + (s.term === '下' ? ' selected' : '') + '>下册</option></select>',
        '</div>',
      '</div>',

      '<div class="section-title"><h2>怎么复习</h2></div>',
      '<div class="mode-grid">',
        '<button class="mode-card" data-action="start-mode" data-mode="focus"><strong>重点复习</strong><span>错题优先 + 掌握度低于 60 的知识点</span></button>',
        '<button class="mode-card" data-action="start-mode" data-mode="full"><strong>全面复习</strong><span>本学期按单元均衡铺开，不落下任何一块</span></button>',
        '<button class="mode-card" data-action="start-mode" data-mode="full" data-scope="past"><strong>全面复习（过往）</strong><span>把回忆录按年级轮着过一遍</span></button>',
        '<button class="mode-card" data-action="start-topic"><strong>专项复习</strong><span>只练选中的维度或知识点', ui.topicKp ? '：' + esc(topicLabel(ui.topicKp)) : '（先在下面选）', '</span></button>',
      '</div>',
      '<div class="card" style="margin-top:12px"><h3>按维度整组练</h3><div class="kp-grid">', dimButtons, '</div>',
        '<h3 style="margin-top:12px">或按细知识点练</h3><div class="kp-grid">', kpButtons, '</div>',
        '<div class="grade-row">',
          '<button data-action="topic-scope" data-scope="all"' + (ui.topicScope === 'all' ? ' class="on"' : '') + '>全部年级</button>',
          '<button data-action="topic-scope" data-scope="current"' + (ui.topicScope === 'current' ? ' class="on"' : '') + '>只练本学期</button>',
          '<button data-action="topic-scope" data-scope="past"' + (ui.topicScope === 'past' ? ' class="on"' : '') + '>只练回忆录</button>',
        '</div>',
        '<button class="btn wide" data-action="start-topic">开始这个专项</button>',
      '</div>',

      '<div class="section-title" style="margin-top:16px"><h2>期中 / 期末冲刺</h2></div>',
      '<div class="exam-grid">',
        '<button class="exam-card" data-action="start-exam" data-key="midterm"><strong>期中冲刺</strong><span>', esc(window.YW_EXAM.midterm.desc), ' · 10 题</span></button>',
        '<button class="exam-card" data-action="start-exam" data-key="final"><strong>期末冲刺</strong><span>', esc(window.YW_EXAM.final.desc), ' · 14 题</span></button>',
      '</div>',
      '<div class="card" style="margin-top:12px"><h3>考试范围（按学校实际调整）</h3>',
        '<div class="grade-row">',
          '<button data-action="scope-key" data-key="midterm"' + (ui.scopeKey === 'midterm' ? ' class="on"' : '') + '>期中</button>',
          '<button data-action="scope-key" data-key="final"' + (ui.scopeKey === 'final' ? ' class="on"' : '') + '>期末</button>',
        '</div>',
        '<div class="scope-grid">', scopeButtons, '</div>',
        '<p class="tiny">点单元可增删；期末默认全册 8 单元，做完会出正确率、错因分布和建议专项。</p>',
      '</div>',
    ].join('');
  }

  /* ---------------- 地图 ---------------- */
  function renderMap() {
    var s = S();
    var cards = window.YW_UNITS.map(function (u) {
      var m = St.unitMastery(u.id);
      return '<div class="unit-card' + (s.progress.unit === u.id ? ' current' : '') + '">' +
        '<div class="u-no">第 ' + u.id + ' 单元' + (s.progress.unit === u.id ? ' · 当前' : '') + '</div>' +
        '<h3>' + esc(u.name) + '</h3>' +
        '<div class="mastery-track"><i class="mastery-fill" style="width:' + m + '%"></i></div>' +
        '<div class="u-foot"><span>掌握度 ' + m + '%</span><span>' + window.YW_QUESTIONS.filter(function (q) { return q.unit === u.id; }).length + ' 题</span></div>' +
        '<button class="btn sm wide" style="margin-top:8px" data-action="start-mode" data-mode="topic" data-units="' + u.id + '">练这个单元</button>' +
      '</div>';
    }).join('');
    var unitSel = window.YW_UNITS.map(function (u) {
      return '<option value="' + u.id + '"' + (s.progress.unit === u.id ? ' selected' : '') + '>第 ' + u.id + ' 单元 · ' + esc(u.name) + '</option>';
    }).join('');
    var cur = window.YW_UNITS.filter(function (u) { return u.id === s.progress.unit; })[0] || window.YW_UNITS[0];
    var lessons = cur.lessons.map(function (l) {
      return '<div class="lesson-line' + (s.progress.lesson === l.n ? ' now' : '') + '"><span class="n">第 ' + l.n + ' 课</span><span>' + esc(l.t) + '</span></div>';
    }).join('');
    var lessonSel = cur.lessons.map(function (l) {
      return '<option value="' + l.n + '"' + (s.progress.lesson === l.n ? ' selected' : '') +
             '>第 ' + l.n + ' 课 · ' + esc(l.t) + '</option>';
    }).join('');
    view.innerHTML = [
      '<div class="section-title"><h2>字块大陆地图</h2><span class="tiny">', esc(window.YW_EDITION), '</span></div>',
      '<div class="card"><h3>当前学到哪一课</h3>',
        '<label class="field"><span>单元</span><select id="progress-unit">', unitSel, '</select></label>',
        '<label class="field"><span>课文</span><select id="progress-lesson">', lessonSel, '</select></label>',
        '<p class="tiny">日常练习只出当前进度及之前的题目；到「回忆录」可以练更早的年级。</p>',
      '</div>',
      '<div class="card"><h3>第 ', s.progress.unit, ' 单元课文</h3>', lessons, '</div>',
      '<div class="unit-grid">', cards, '</div>',
    ].join('');
  }

  /* ---------------- 错题集 ---------------- */
  function renderWrong() {
    var s = S();
    var all = Object.keys(s.wrong).map(function (id) { return { q: window.YW_Q_BY_ID[id], w: s.wrong[id] }; })
      .filter(function (x) { return !!x.q; });
    var filters = [
      ['all', '全部'], ['careless', '看错了'], ['confused', '记混了'], ['unknown', '还没学会'], ['graduated', '已掌握'],
    ].map(function (f) {
      return '<button data-action="wrong-filter" data-filter="' + f[0] + '"' + (ui.wrongFilter === f[0] ? ' class="on"' : '') + '>' + f[1] + '</button>';
    }).join('');
    var list = all.filter(function (x) {
      if (ui.wrongFilter === 'graduated') return !!x.w.graduated;
      if (ui.wrongFilter === 'all') return !x.w.graduated;
      return !x.w.graduated && x.w.type === ui.wrongFilter;
    }).sort(function (a, b) { return (a.w.due || '').localeCompare(b.w.due || ''); });
    var atts = s.attempts || [];
    var rows = list.map(function (x) {
      var q = x.q, w = x.w;
      var badgeCls = w.type === 'careless' ? '' : w.type === 'confused' ? ' c' : ' u';
      // 从最近作答里找出上次错选的哪一项，分析才讲得具体
      var sel = -1;
      for (var i = atts.length - 1; i >= 0; i--) {
        if (atts[i].q === q.id && !atts[i].ok && atts[i].s >= 0) { sel = atts[i].s; break; }
      }
      var ex = window.YWExplain.brief(q);
      return '<div class="wrong-item">' +
        '<div class="w-head"><span class="badge' + badgeCls + '">' + typeName(w.type) + '</span>' +
        '<span>' + (w.graduated ? '已掌握' : '下次复习 ' + dLabel(w.due)) + ' · 连对 ' + (w.okCount || 0) + '/2</span></div>' +
        '<div class="w-stem">' + esc(q.stem) + '</div>' +
        '<div class="w-tip"><b>考点：</b>' + esc(ex.point) + '<br><b>下次：</b>' + esc(ex.method) + '</div>' +
        '<div class="btn-row" style="margin-top:8px">' +
          '<button class="btn sm ghost" data-action="wrong-explain" data-qid="' + q.id + '" data-sel="' + sel + '">看完整分析</button>' +
          '<button class="btn sm" data-action="redo" data-qid="' + q.id + '">重做这道</button>' +
        '</div>' +
      '</div>';
    }).join('');
    view.innerHTML = [
      '<div class="section-title"><h2>错题集</h2><span class="tiny">', all.filter(function (x) { return !x.w.graduated; }).length, ' 道待复习</span></div>',
      '<div class="card"><p class="muted">答错自动收进来，不用抄。分为「看错了 / 记混了 / 还没学会」，按 1、3、7 天回流，连对 2 次才毕业。点「看完整分析」会按错因逐项拆解这一题。</p></div>',
      '<div class="filters">', filters, '</div>',
      rows || '<div class="empty"><strong>这里是空的</strong><p>这一类暂时没有错题，去练一趟吧。</p></div>',
      '<div style="margin-top:12px"><button class="btn wide" data-action="start-mode" data-mode="focus">把错题集中练一遍</button></div>',
    ].join('');
  }

  /* ---------------- 事件 ---------------- */
  async function handle(a, b) {
    var d = b.dataset;
    switch (a) {
      case 'open-me': renderMe(); break;
      case 'open-identity': renderIdentity(false); break;
      case 'id-pick': await St.switchProfile(d.id); await afterIdentity(); break;
      case 'id-create': {
        var nv = (document.getElementById('id-name') || {}).value || '';
        if (!nv.trim()) { toast('先取一个昵称'); break; }
        var had = !!St.findByName(nv);
        await St.createProfile(nv);
        await afterIdentity(had ? '这个昵称用过，已经接上原来的进度' : '新昵称建好了，进度会跟着它走');
        break;
      }
      case 'id-guest': await St.enterGuest(); await afterIdentity(); break;
      case 'profile-switch': await St.switchProfile(d.id); await afterIdentity(); break;
      case 'profile-add': {
        var newName = (document.getElementById('new-profile-name') || {}).value;
        if (!newName || !String(newName).trim()) { toast('先取一个昵称'); break; }
        var had2 = !!St.findByName(newName);
        await St.createProfile(newName);
        await afterIdentity(had2 ? '这个昵称用过，已经切过去' : '已新增「' + St.profileName() + '」');
        break;
      }
      case 'profile-rename': renameSheet(d.id); break;
      case 'rename-save': {
        var rv = (document.getElementById('rename-input') || {}).value || '';
        if (!rv.trim()) { toast('名字不能为空，请重新输入'); break; }
        await St.renameProfile(rv, renameTargetId);
        renderMe(); render(); toast('昵称已更新');
        break;
      }
      case 'confirm-cancel':
        pendingConfirm = null; pendingStart = null; closeOverlay();
        break;
      case 'confirm-ok': {
        var run = pendingConfirm;
        pendingConfirm = null;
        closeOverlay();
        if (run) await run();
        break;
      }
      case 'profile-delete':
        confirmSheet('删除这个昵称', '会删除这个昵称在本机的全部记录，不可撤销；云端存档和其他昵称不受影响。', '删除', async function () {
          await St.deleteProfile(d.id);
          if (St.needIdentity()) { round = null; render(); renderIdentity(true); }
          else await afterIdentity('已删除该昵称');
        });
        break;
      case 'continent': openContinent(); break;
      case 'league-tab': ui.league = d.league; openContinent(); break;
      case 'boss-board': openContinent(); break;
      case 'boss-fight': startBoss(d.key, d.league || ui.league); break;
      case 'boss-quit': quitBoss(); break;
      case 'training-board': openTrainingBoard(); break;
      case 'training-start': startTraining(d.key, d.league || ui.league, 5); break;
      case 'training-quick': startTraining(d.key, d.league || ui.league, 3); break;
      case 'shard-shop': openShardShop(); break;
      case 'loot-sell':
        confirmSheet('分解这件礼物？', '分解后它会消失，换成字块碎片，碎片可以去商店换别的礼物。',
          '分解换碎片', function () {
            var r = St.sellLoot(d.uid);
            toast(r.ok ? '分解成 ' + r.gain + ' 块碎片，现有 ' + r.total + ' 块' : (r.reason || '没分成'));
            openContinent();
          });
        break;
      case 'shard-buy':
        confirmSheet('用碎片兑换？', '兑换成功后碎片会扣掉，礼物放进战利品。',
          '确认兑换', function () {
            var r = St.buyGift(d.id);
            if (r.ok) toast('换到了「' + r.gift.name + '」，还剩 ' + r.left + ' 块碎片');
            else toast(r.reason || '没换成');
            openShardShop();
          });
        break;
      case 'gift-pool':
        openGiftPool();
        refreshGiftPool().then(function (changed) { if (changed) openGiftPool(); });
        break;
      case 'gift-refresh':
        toast('正在刷新…');
        refreshGiftPool().then(function (changed) {
          openGiftPool(changed ? '' : '已是最新');
        });
        break;
      case 'gift-add': {
        var gn = document.getElementById('gift-name');
        var gt = document.getElementById('gift-tier');
        var gname = gn ? gn.value.replace(/\s+/g, ' ').trim().slice(0, 16) : '';
        if (!gname) { toast('先写个礼物名字'); break; }
        if (!window.YWCloud || !window.YWCloud.isReady()) { openGiftPool('云端没连上，礼物库暂时改不了'); break; }
        window.YWCloud.addGift({ name: gname, tier: gt ? gt.value : 'white', createdBy: St.giftOwner() })
          .then(function () { return refreshGiftPool(); })
          .then(function () { toast('已放进礼物库'); openGiftPool(); })
          .catch(function (e) { openGiftPool(e.message || '没放进去，待会儿再试'); });
        break;
      }
      case 'gift-del': {
        if (!St.canManageGifts()) { toast('只有礼物管理员能删'); break; }
        if (!window.YWCloud || !window.YWCloud.isReady()) { openGiftPool('云端没连上，暂时删不了'); break; }
        var gid = d.id;
        window.YWCloud.removeGift(gid)
          .then(function () { return refreshGiftPool(); })
          .then(function () { toast('已删除'); openGiftPool(); })
          .catch(function (e) { openGiftPool(e.message || '没删掉，待会儿再试'); });
        break;
      }
      case 'prize-pool': openGiftPool(); break;
      case 'resume-round': {
        var pr = St.loadRound();
        if (!pr) { toast('这一趟已经不在了'); render(); break; }
        round = pr; closeOverlay(); render();
        if (round.challenge) startChallengeTimer();
        window.scrollTo(0, 0);
        break;
      }
      case 'drop-round': stopChallengeTimer(); round = null; St.clearRound(); render(); toast('已放弃这一趟'); break;
      case 'start-past': startRound({ mode: 'past', count: 6, grade: Number(d.grade) || 0 }); break;
      case 'start-mode':
        startRound({ mode: d.mode, count: d.mode === 'full' ? 10 : 8,
                     scope: d.scope, kp: d.kp || '',
                     units: d.units ? [Number(d.units)] : undefined });
        break;
      case 'start-topic': {
        if (!ui.topicKp) { toast('先在下面选一个维度或知识点'); break; }
        var ts = { mode: 'topic', count: 8, scope: ui.topicScope };
        if (ui.topicKp.indexOf('dim:') === 0) ts.dim = ui.topicKp.slice(4);
        else ts.kp = ui.topicKp;
        startRound(ts);
        break;
      }
      case 'start-exam': startRound({ mode: 'exam', examKey: d.key }); break;
      case 'opt':
        if (!round || round.phase !== 'ask') break;
        round.selected = Number(d.idx); St.saveRound(round); render();
        break;
      case 'mirror-back': closeOverlay(); break;
      case 'wrong-explain': {
        var eq = window.YW_Q_BY_ID[d.qid];
        if (eq) openExplain(eq, Number(d.sel), (S().wrong[eq.id] || {}).type || 'unknown');
        break;
      }
      case 'submit': submitAnswer(); break;
      case 'fill-submit': submitFill(); break;
      case 'fill-choice': fillToChoice(); break;
      case 'spot': submitSpot(d.idx); break;
      case 'order-pick': orderPicked(d.idx); break;
      case 'order-reset': orderReset(); break;
      case 'order-submit': submitOrder(); break;
      case 'next': advance(); if (endToast) { toast(endToast); endToast = null; } break;
      case 'again': {
        var lr = S().lastRun;
        if (!lr || !lr.spec) { toast('先在上面选个范围'); break; }
        startRound(Object.assign({}, lr.spec));
        break;
      }
      case 'run-report': if (S().lastRun) openRunReport(S().lastRun); break;
      case 'run-dismiss': await St.setLastRun(null); render(); break;
      case 'go-wrong': round = null; tab = 'wrong'; render(); break;
      case 'redo':
        startRound({ mode: 'topic', count: 1, kp: '' });
        if (round) {
          var q = window.YW_Q_BY_ID[d.qid];
          if (q) {
            round.items = [{ q: q, isReview: true }];
            round.label = '重做这道';
            round.isRedo = true;   // 订正不是一趟练习：不写结果条、不动当天成绩、做完回错题集
            round.idx = 0; round.results = []; round.selected = null; round.phase = 'ask';
            St.saveRound(round); render();
          }
        }
        break;
      case 'past-grade': ui.pastGrade = Number(d.grade); render(); break;
      case 'topic-kp': ui.topicKp = d.kp; render(); break;
      case 'topic-scope': ui.topicScope = d.scope; render(); break;
      case 'scope-key': ui.scopeKey = d.key; render(); break;
      case 'scope-toggle': {
        var scope = (S().examScope[ui.scopeKey] || window.YW_EXAM[ui.scopeKey].units).slice();
        var u = Number(d.unit), i = scope.indexOf(u);
        if (i >= 0) { if (scope.length <= 1) { toast('至少要留一个单元'); break; } scope.splice(i, 1); }
        else scope.push(u);
        scope.sort(function (x, y) { return x - y; });
        await St.setExamScope(ui.scopeKey, scope); render(); break;
      }
      case 'wrong-filter': ui.wrongFilter = d.filter; render(); break;
      case 'saves-copy':
        try { await navigator.clipboard.writeText(S().spaceId); toast('存档码已复制'); }
        catch (e) { toast('复制失败，请长按手动复制'); }
        break;
      case 'saves-code-restore': {
        if (St.isGuest()) { toast('先用一个昵称登录，再恢复旧存档'); break; }
        var code = (document.getElementById('space-input') || {}).value;
        if (!code || !code.trim()) { toast('先填存档码'); break; }
        var target = code.trim(), rows;
        try { rows = await Cl.listSaves(target); ui.cloudOk = true; ui.cloudMsg = ''; }
        catch (e) { ui.cloudOk = false; ui.cloudMsg = e.message; toast('读取云端失败：' + e.message); break; }
        if (!rows || !rows.length) { await St.setSpaceId(target); renderMe(); toast('这个存档码下还没有云端记录'); break; }
        var doRestore = async function () {
          await St.setSpaceId(target);
          St.applySnapshot(rows[0].payload);
          ui.cloudSaves = rows;
          ui.lastSyncAt = '已从云端恢复 ' + dateOf(rows[0]);
          await refreshCloudList(false);
          updateSyncBar(); render(); renderMe();
          toast('已恢复 ' + dateOf(rows[0]) + ' 的进度');
        };
        if (!isFreshProfile(S())) {
          confirmSheet('覆盖本机记录？', '这个昵称在本机已有练习记录，恢复旧存档码会覆盖它们。确定继续吗？', '覆盖并恢复', doRestore);
        } else await doRestore();
        break;
      }
      case 'saves-refresh': await refreshCloudList(false); updateSyncBar(); renderMe(); toast('云端已重新检查'); break;
      case 'sync-now': {
        var nowPayload = St.finalizeDay(St.todayKey());
        await syncDate(nowPayload);
        render(); renderMe(); toast(ui.lastError ? '同步失败：' + ui.lastError : '今天的存档已上传');
        break;
      }
      case 'cloud-pull': {
        var pulled;
        try { pulled = await Cl.listSaves(S().spaceId); }
        catch (e) { toast('拉取失败：' + e.message); break; }
        if (!pulled || !pulled.length) { toast('云端还没有这个昵称的存档'); break; }
        var runPull = async function () {
          St.applySnapshot(pulled[0].payload);
          ui.lastSyncAt = '已从云端恢复 ' + dateOf(pulled[0]);
          await refreshCloudList(false); render(); renderMe(); toast('进度已从云端刷新');
        };
        if (!isFreshProfile(S())) {
          confirmSheet('用云端进度覆盖本机？', '本机当前记录会被云端最新一份替换。', '覆盖并刷新', runPull);
        } else await runPull();
        break;
      }
      case 'close-overlay': closeOverlay(); break;
      case 'toggle-anim': await St.setNoAnim(!S().noAnim); render(); renderMe(); break;
      case 'export-all': download('方块语文-全部数据-' + St.todayKey() + '.json', St.exportAll()); toast('已导出'); break;
      case 'import-all': document.getElementById('import-file').click(); break;
      case 'reset-local':
        confirmSheet('清空本地记录', '确定清空「' + St.profileName() + '」的全部本地记录？此操作不可撤销，云端存档和其他昵称不受影响。', '清空', async function () {
          await St.resetLocal(); round = null; render(); toast('这个昵称的本地记录已清空');
        });
        break;
    }
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-action]');
    if (!b || b.disabled) return;
    Promise.resolve(handle(b.dataset.action, b)).catch(function (err) {
      toast(err && err.message ? err.message : '出了点问题');
    });
  });

  document.addEventListener('change', async function (e) {
    var t = e.target;
    if (t.id === 'grade-select' || t.id === 'term-select') {
      var g = document.getElementById('grade-select').value;
      var term = document.getElementById('term-select').value;
      var oldBook = (window.YW_BOOK_OF || function () { return null; })(S().grade, S().term);
      await St.setGrade(g, term);
      var newBook = (window.YW_BOOK_OF || function () { return null; })(Number(g), term);
      // 换册后把进度重置到新册第一单元，避免沿用旧册的课号
      if (newBook && (!oldBook || newBook.id !== oldBook.id)) {
        await St.setProgress(1, (newBook.units[0].lessons[0] || {}).n || 0);
      }
      render();
      toast(newBook ? ('已切到 ' + newBook.edition + '，旧内容自动进回忆录')
                    : ('已切到 ' + g + ' 年级' + term + '册，这一册题库还在准备中'));
    } else if (t.id === 'progress-unit') {
      var pu = Number(t.value);
      var puObj = window.YW_UNITS.filter(function (x) { return x.id === pu; })[0];
      await St.setProgress(pu, puObj ? puObj.lessons[0].n : 0);
      render(); toast('已选到第 ' + pu + ' 单元');
    } else if (t.id === 'progress-lesson') {
      await St.setProgress(S().progress.unit, Number(t.value));
      render();
    } else if (t.id === 'dig-unit') {
      var du = Number(t.value);
      var duObj = window.YW_UNITS.filter(function (x) { return x.id === du; })[0] || window.YW_UNITS[0];
      await St.setDigScope(du, duObj.lessons[0].n);
      render(); toast('已选到第 ' + du + ' 单元');
    } else if (t.id === 'dig-lesson') {
      await St.setDigScope(S().digUnit, Number(t.value));
      render();
    } else if (t.id === 'import-file' && t.files && t.files[0]) {
      try {
        var text = await t.files[0].text();
        await St.importAll(JSON.parse(text));
        await refreshCloudList(false); render(); toast('备份已导入');
      } catch (err) { toast('导入失败：' + err.message); }
      t.value = '';
    }
  });

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
    b.addEventListener('click', function () {
      if (St.isGuest()) { tab = 'practice'; return; }
      tab = b.dataset.tab; closeOverlay(); render(); window.scrollTo(0, 0);
    });
  });

  boot();
})();
