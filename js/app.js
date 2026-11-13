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
  var ui = {
    pastGrade: 0, topicKp: '', topicScope: 'all', scopeKey: 'midterm',
    wrongFilter: 'all', cloudSaves: [], cloudOk: false, cloudMsg: '',
    cloudOffers: [], lastSyncAt: '', lastError: '',
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
  function mobTower(shown) {
    var out = '';
    for (var i = 0; i < 20; i++) {
      var kind = MOB_KINDS[i % 3];
      out += '<span class="mob-blk' + (i < shown ? '' : ' dim') + '" title="' + MOB_NAMES[kind] + '">' +
             mobSvg(kind) + '</span>';
    }
    return out;
  }
  function mobLegend() {
    return '<p class="mob-legend">' + MOB_KINDS.map(function (k) {
      return '<span>' + mobSvg(k) + MOB_NAMES[k] + '</span>';
    }).join('') + '</p>';
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
      '<h2>给使用者改名</h2>',
      '<p class="muted">名字只存在本机，不会上传到云端。</p>',
      '<label class="field"><span>名字（最多 12 个字）</span>',
        '<input id="rename-input" maxlength="12" value="', esc(p ? p.name : ''), '" /></label>',
      '<div class="btn-row">',
        '<button class="btn ghost" data-action="open-profiles">取消</button>',
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
  function renderCloudOffer(offers) {
    ui.cloudOffers = offers;
    var rows = offers.map(function (o, i) {
      return '<button class="profile-card" data-action="cloud-offer-pick" data-i="' + i + '">' +
        '<div class="p-ico">云</div>' +
        '<div class="p-body"><strong>存档 · ' + esc(o.date) + '</strong>' +
        '<span>' + o.attempts + ' 题 · ' + o.blocks + ' 方块 · 点一下接着用</span></div></button>';
    }).join('');
    overlay([
      '<h2>发现云端有存档</h2>',
      '<p class="muted">这台设备是第一次打开。选一份接着用，方块、错题、掌握度和「今天挖第几课」会一起回来。</p>',
      '<div style="margin:12px 0">', rows, '</div>',
      '<button class="btn ghost wide" data-action="close-overlay">先不用，从新开始</button>',
    ].join(''));
  }
  // 本地为空时自动接上云端，不再让用户自己去找「存档 → 恢复」
  async function autoRestore(allowOffer) {
    if (!Cl.isReady()) return;
    try {
      var mine = await Cl.listSaves(S().spaceId);
      if (mine && mine.length) {
        if (isFreshProfile(S()) && applyLatest(mine)) toast('已从云端恢复这个使用者的进度');
        return;
      }
    } catch (e) { ui.lastError = e.message; return; }
    if (!allowOffer || !isFreshProfile(S())) return;
    try {
      var all = await Cl.listAllSaves();
      if (!all || !all.length) return;
      var seen = {}, offers = [];
      all.forEach(function (r) {
        if (seen[r.space_id] || r.space_id === S().spaceId) return;
        seen[r.space_id] = 1;
        var p = r.payload || {};
        offers.push({ code: r.space_id, date: dateOf(r),
                      attempts: (p.today || {}).attempts || 0, blocks: p.blocks || 0, payload: p });
      });
      if (offers.length) renderCloudOffer(offers);
    } catch (e) { ui.lastError = e.message; }
  }

  async function syncPending() {
    if (!Cl.isReady()) return;
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
    if (!Cl.isReady()) { setSync(Cl.reason() + ' · 本地已保存', 'warn'); return; }
    if (s.pendingSync.length) { setSync(s.pendingSync.length + ' 份待同步 · 本地已保存，稍后自动重试', 'warn'); return; }
    setSync('云端已同步 · 每天一个存档（北京时间）', 'ok');
  }
  async function syncDate(payload) {
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
      document.getElementById('edition-label').textContent = '三年级上 · 人教版 2026 秋版';
      await syncPending();
      await refreshCloudList(false);
      await autoRestore(true);
      updateSyncBar();
      if (St.isFallback()) toast('浏览器存储受限，建议换个浏览器打开');
      render();
    } catch (e) {
      view.innerHTML = '<div class="error">启动失败：' + esc(e.message) + '</div>';
    }
  }

  /* ---------------- 通用渲染 ---------------- */
  function updateChips() {
    var s = S();
    document.getElementById('who-name').textContent = St.profileName();
    document.getElementById('chip-level').textContent = s.level;
    document.getElementById('chip-blocks').textContent = s.blocks;
    document.getElementById('chip-streak').textContent = s.streak;
    document.getElementById('xp-fill').style.width = ((s.blocks % 20) / 20 * 100) + '%';
  }
  function render() {
    updateChips();
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    if (tab === 'practice') renderPractice();
    else if (tab === 'past') renderPast();
    else if (tab === 'map') renderMap();
    else if (tab === 'wrong') renderWrong();
    else renderSaves();
  }

  /* ---------------- 使用者档案 ---------------- */
  function renderProfileSheet() {
    var list = St.profileList().map(function (p) {
      return '<div class="profile-card' + (p.active ? ' on' : '') + '">' +
        '<div class="p-ico">' + esc(p.name.slice(0, 1)) + '</div>' +
        '<div class="p-body"><strong>' + esc(p.name) + (p.active ? ' · 当前' : '') + '</strong>' +
        '<span>Lv.' + p.level + ' · ' + p.blocks + ' 方块 · ' + p.wrong + ' 道错题 · 第 ' +
        (p.progress ? p.progress.unit : 1) + ' 单元</span></div>' +
        (p.active ? '' : '<button class="p-mini" data-action="profile-switch" data-id="' + p.id + '">切换</button>') +
        '<button class="p-mini" data-action="profile-rename" data-id="' + p.id + '">改名</button>' +
        '<button class="p-mini" data-action="profile-delete" data-id="' + p.id + '">删除</button>' +
      '</div>';
    }).join('');
    overlay([
      '<h2>今天谁在练？</h2>',
      '<p class="muted">每个使用者都有自己独立的错题集、掌握度、进度、方块和每日存档，互不干扰。不用登录，点一下就切换。</p>',
      '<div style="margin:12px 0">', list, '</div>',
      '<label class="field"><span>新增使用者（起个名字就行）</span><input id="new-profile-name" placeholder="例如：小宇" maxlength="12" /></label>',
      '<button class="btn primary wide" data-action="profile-add">新增并切换过去</button>',
      '<button class="btn ghost wide" style="margin-top:8px" data-action="close-overlay">先不切换</button>',
      '<p class="tiny" style="margin-top:10px">换设备时，在「存档」页复制这个使用者的存档码，粘贴回去即可读回云端记录。</p>',
    ].join(''));
  }

  async function afterProfileChange() {
    round = null;
    ui.cloudSaves = [];
    St.setNoAnim(S().noAnim);
    await refreshCloudList(false);
    await autoRestore(false);
    await syncPending();
    updateSyncBar();
    closeOverlay();
    render();
    toast('已切到 ' + St.profileName());
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
    St.clearRound();
    var r = St.buildRound(spec);
    if (!r.items.length) { toast('这个范围里还没有题目，换个范围试试'); return; }
    round = {
      spec: spec, label: r.label, note: r.note, mode: r.mode, items: r.items,
      idx: 0, selected: null, phase: 'ask', results: [],
    };
    tab = 'practice';
    St.saveRound(round);
    closeOverlay();
    render();
    window.scrollTo(0, 0);
  }

  function renderPractice() {
    if (!round) return renderPracticeHome();
    if (round.phase === 'done') return renderResult();
    return renderQuestion();
  }

  function renderPracticeHome() {
    var s = S(), d = St.todayKey(), today = s.daily[d] || { attempts: 0, correct: 0, careless: 0 };
    var tower = mobTower(Math.min(s.blocks, 20));

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

    var unitSel = window.YW_UNITS.map(function (u) {
      return '<option value="' + u.id + '"' + (s.digUnit === u.id ? ' selected' : '') +
             '>第 ' + u.id + ' 单元 · ' + esc(u.name) + '</option>';
    }).join('');
    var curUnit = window.YW_UNITS.filter(function (u) { return u.id === s.digUnit; })[0] || window.YW_UNITS[0];
    var lessonSel = '<option value="0"' + (!s.digLesson ? ' selected' : '') + '>整个单元（不指定课）</option>' +
      curUnit.lessons.map(function (l) {
        return '<option value="' + l.n + '"' + (s.digLesson === l.n ? ' selected' : '') +
               '>第 ' + l.n + ' 课 · ' + esc(l.t) + '</option>';
      }).join('');

    view.innerHTML = [
      '<div class="section-title"><h2>今天的挖掘</h2><span class="tiny">', esc(window.YW_EDITION), '</span></div>',
      todo,
      '<div class="card">',
        '<h2>今天挖哪一块</h2>',
        '<p class="muted">选好单元和具体第几课，这一趟就优先出这部分的题目。</p>',
        '<label class="field" style="margin-top:10px"><span>单元</span><select id="dig-unit">', unitSel, '</select></label>',
        '<label class="field"><span>具体第几课</span><select id="dig-lesson">', lessonSel, '</select></label>',
        '<div class="stat-row">',
          '<div class="stat-box"><b>', today.attempts, '</b><span>今日作答</span></div>',
          '<div class="stat-box"><b>', today.correct, '</b><span>答对</span></div>',
          '<div class="stat-box"><b>', today.careless, '</b><span>看错了</span></div>',
        '</div>',
        '<button class="btn primary wide" data-action="start-daily">开始这一趟（5 题）</button>',
        '<p class="tiny" style="margin-top:8px">没有倒计时；答错才会用巡查镜复盘。做到一半会自动存成待办。</p>',
      '</div>',
      '<div class="card"><h3>伙伴塔</h3><div class="tower">', tower, '</div>', mobLegend(),
        '<p class="tiny">每答对一题，就有一位新伙伴住进塔里；攒够 20 位升一级。中断了也不会清零。</p></div>',
      '<p class="tiny" style="text-align:center">到期的错题会自己冒出来，混进这一趟里。</p>',
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
    var src = sourceOf(q);
    var feedback = '';
    if (fb) {
      feedback = [
        '<div class="feedback', last.correct ? '' : ' bad', '">',
          '<strong>', last.correct ? '答对了，来了一位新伙伴' : '再看一眼，这块先记下来', '</strong>',
          '<p>', esc(q.tip), '</p>',
          last.type ? '<span class="err-tag">错因归类：' + typeName(last.type) + ' · 已自动进错题集</span>' : '',
        '</div>',
      ].join('');
    }
    view.innerHTML = [
      '<div class="section-title"><h2>', esc(round.label), '</h2><span class="tiny">', round.idx + 1, ' / ', round.items.length, ' 题</span></div>',
      '<div class="round-head"><div class="round-dots">', dots, '</div><span class="tiny">不用赶时间</span></div>',
      feedback,
      '<div class="card">',
        '<div class="q-source"><b>', esc(src.book), '</b><span>', esc(src.unit), '</span></div>',
        '<span class="q-meta">', esc(dimName(q.dim)), ' · ', esc(kpName(q.kp)), '</span>',
        '<div class="q-stem">', esc(q.stem), '</div>',
        '<div class="options">', opts, '</div>',
        '<div class="action-bar">',
          '<button class="btn primary wide" data-action="submit"' + (round.selected === null ? ' disabled' : '') + '>确认提交并继续</button>',
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
    var payload = St.recordAnswer(q, sel, correct, it.isReview);
    var last = { qid: q.id, correct: correct, type: type, selected: sel };
    round.results.push(last);
    round.phase = 'ask';
    // 一次点击即推进：不再停在「下一块」中转页
    advance();
    // 只有答错才用快照复盘刚才那题；下一块已经在下面等着了
    if (!correct) openMirror(last, q);
    else toast('答对了，来了一位新伙伴');
    syncDate(payload);
  }

  function advance() {
    if (round.idx + 1 >= round.items.length) { round.phase = 'done'; St.clearRound(); }
    else { round.idx += 1; round.selected = null; round.phase = 'ask'; St.saveRound(round); }
    render();
    window.scrollTo(0, 0);
  }

  function renderResult() {
    var rs = round.results;
    var ok = rs.filter(function (r) { return r.correct; }).length;
    var careless = rs.filter(function (r) { return r.type === 'careless'; }).length;
    var confused = rs.filter(function (r) { return r.type === 'confused'; }).length;
    var unknown = rs.filter(function (r) { return r.type === 'unknown'; }).length;
    var tower = mobTower(S().blocks % 20 || (ok ? 20 : 0));
    var report = '';
    if (round.mode === 'exam') {
      var byKp = {};
      rs.forEach(function (r) {
        if (r.correct) return;
        var q = window.YW_Q_BY_ID[r.qid];
        if (q) byKp[q.kp] = (byKp[q.kp] || 0) + 1;
      });
      var weak = Object.keys(byKp).sort(function (a, b) { return byKp[b] - byKp[a]; }).slice(0, 3);
      report = [
        '<div class="card"><h3>本次专项报告</h3>',
        '<div class="report-line"><span>正确率</span><b>', Math.round(ok / rs.length * 100), '%（', ok, '/', rs.length, '）</b></div>',
        '<div class="report-line"><span>看错了</span><b>', careless, ' 题</b></div>',
        '<div class="report-line"><span>记混了</span><b>', confused, ' 题</b></div>',
        '<div class="report-line"><span>还没学会</span><b>', unknown, ' 题</b></div>',
        '<p class="muted" style="margin-top:10px">建议专项：',
        weak.length ? weak.map(kpName).join('、') : '没有明显薄弱点，保持就好', '</p>',
        weak.length ? '<button class="btn sm" data-action="start-mode" data-mode="topic" data-kp="' + esc(weak[0]) + '">练一下' + esc(kpName(weak[0])) + '</button>' : '',
        '</div>',
      ].join('');
    }
    view.innerHTML = [
      '<div class="section-title"><h2>', esc(round.label), ' · 完成</h2><span class="tiny">', esc(St.todayKey()), '</span></div>',
      '<div class="card" style="text-align:center">',
        '<h2>这一趟挖完了</h2>',
        '<div class="tower">', tower, '</div>', mobLegend(),
        '<div class="stat-row">',
          '<div class="stat-box"><b>', rs.length, '</b><span>共做</span></div>',
          '<div class="stat-box"><b>', ok, '</b><span>答对</span></div>',
          '<div class="stat-box"><b>', careless, '</b><span>看错了</span></div>',
        '</div>',
        '<div class="btn-row" style="margin-top:12px">',
          '<button class="btn primary" data-action="again">再来一趟</button>',
          '<button class="btn ghost" data-action="go-wrong">看看错题</button>',
        '</div>',
      '</div>',
      report,
      '<p class="tiny" style="text-align:center">答错的题已自动收进错题集，1 / 3 / 7 天后会再冒出来。</p>',
    ].join('');
  }

  /* ---------------- 回忆录 · 复习中心 ---------------- */
  function renderPast() {
    var s = S();
    var pastAll = window.YW_pastQuestions(s.grade);
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
        '<p class="muted">把学过的都捞回来。当前 <span class="grade-big">', s.grade, ' 年级', s.term, '册</span>；低于当前年级的题目和旧错题会自动进这里，升到 4、5、6 年级不用搬家、不用导数据。</p>',
        '<div class="grade-row"><button data-action="past-grade" data-grade="0"' + (ui.pastGrade === 0 ? ' class="on"' : '') + '>全部过往</button>', gradeButtons, '</div>',
        '<p class="tiny">过往题库 ', pastAll.length, ' 道 · 其中历史错题 ', pastWrong, ' 道', grades.length ? '' : '（当前已是 1 年级，暂无更低年级题目）', '</p>',
        '<button class="btn primary wide" style="margin-top:10px" data-action="start-past" data-grade="' + ui.pastGrade + '">开始复习过往</button>',
      '</div>',

      '<div class="card"><h3>现在读几年级</h3>',
        '<p class="muted">改了之后，原来年级的题目和错题立刻变成「回忆录」，机制不用改。</p>',
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

  /* ---------------- 存档 ---------------- */
  function renderSaves() {
    var s = S();
    var map = {};
    Object.keys(s.saves).forEach(function (d) { map[d] = { date: d, payload: s.saves[d], src: '本地' }; });
    ui.cloudSaves.forEach(function (r) {
      if (!map[r.save_date]) map[r.save_date] = { date: r.save_date, payload: r.payload, src: '云端' };
    });
    var rows = Object.keys(map).sort().reverse().map(function (d) {
      var x = map[d], p = x.payload || {}, t = p.today || {};
      return '<div class="save-row">' +
        '<span class="s-date">' + dLabel(d) + '</span>' +
        '<span class="s-info">' + (t.attempts || 0) + ' 题 · 对 ' + (t.correct || 0) + ' · 看错 ' + (t.careless || 0) + ' · ' + x.src + '</span>' +
        '<button class="btn sm" data-action="saves-view" data-date="' + d + '">看</button>' +
        '<button class="btn sm ghost" data-action="saves-download" data-date="' + d + '">存</button>' +
        '<button class="btn sm ghost" data-action="saves-restore" data-date="' + d + '">恢复</button>' +
      '</div>';
    }).join('');
    view.innerHTML = [
      '<div class="section-title"><h2>每日存档</h2><span class="tiny">北京时间 · 一天一份</span></div>',
      '<div class="card"><h3>', esc(St.profileName()), ' 的存档码</h3>',
        '<p class="muted"><b>同步认码不认名</b>：名字一样不等于同一个使用者，每台设备第一次打开会生成新码。换设备时把这里的码复制过去，粘贴到下面就会自动恢复进度；首次打开新设备也会自动提示你选云端存档。别公开分享。</p>',
        '<div class="code-box" style="margin-top:10px"><code id="space-code">' + esc(s.spaceId) + '</code>',
          '<button class="btn sm" data-action="saves-copy">复制</button></div>',
        '<label class="field" style="margin-top:12px"><span>粘贴另一台设备的存档码</span><input id="space-input" placeholder="把存档码粘在这里" /></label>',
        '<button class="btn wide" data-action="saves-code-restore">粘贴并恢复进度</button>',
      '</div>',
      '<div class="card"><h3>云端状态</h3>',
        '<div class="report-line"><span>连接</span><b>', (ui.cloudOk ? '已连接 · ' + ui.cloudSaves.length + ' 份存档' : esc(ui.cloudMsg || Cl.reason())), '</b></div>',
        '<div class="report-line"><span>最近同步</span><b>', esc(ui.lastSyncAt || '还没有'), '</b></div>',
        '<div class="report-line"><span>待同步</span><b>', s.pendingSync.length, ' 份</b></div>',
        ui.lastError ? '<p class="tiny" style="color:var(--red)">最近错误：' + esc(ui.lastError) + '</p>' : '',
        '<div class="btn-row" style="margin-top:12px">',
          '<button class="btn primary" data-action="sync-now">立即上传今天</button>',
          '<button class="btn" data-action="cloud-pull">从云端刷新进度</button>',
        '</div>',
        '<button class="btn sm ghost" style="margin-top:8px" data-action="saves-refresh">重新检查云端目录</button>',
        '<p class="tiny" style="margin-top:8px">本地始终先存一份；同步失败会标「待同步」，下次打开自动重试，不会静默丢数据。</p>',
      '</div>',
      '<div class="card"><h3>存档目录</h3>',
        rows || '<div class="empty"><strong>还没有存档</strong><p>做完第一趟练习，今天这份就会自动出现。</p></div>',
      '</div>',
      '<div class="card"><h3>设置</h3>',
        '<div class="switch-row"><span>关闭界面动效</span><button class="btn sm" data-action="toggle-anim">' + (s.noAnim ? '已关闭' : '开启中') + '</button></div>',
        '<div class="btn-row" style="margin-top:12px">',
          '<button class="btn" data-action="export-all">导出全部数据</button>',
          '<button class="btn" data-action="import-all">导入备份</button>',
        '</div>',
        '<button class="btn danger wide" style="margin-top:10px" data-action="reset-local">清空这个使用者的本地记录</button>',
        '<p class="tiny" style="margin-top:8px">只影响当前使用者在本设备的记录，其他人不受影响；云端存档仍在，需要二次确认。</p>',
      '</div>',
      '<input type="file" id="import-file" accept=".json,application/json" class="hidden" />',
    ].join('');
  }

  /* ---------------- 事件 ---------------- */
  function findPayload(date) {
    if (S().saves[date]) return S().saves[date];
    var r = ui.cloudSaves.filter(function (x) { return x.save_date === date; })[0];
    return r ? r.payload : null;
  }

  async function handle(a, b) {
    var d = b.dataset;
    switch (a) {
      case 'open-profiles': renderProfileSheet(); break;
      case 'profile-switch': await St.switchProfile(d.id); await afterProfileChange(); break;
      case 'profile-add': {
        var newName = (document.getElementById('new-profile-name') || {}).value;
        await St.createProfile(newName);
        await afterProfileChange();
        break;
      }
      case 'profile-rename': renameSheet(d.id); break;
      case 'rename-save': {
        var rv = (document.getElementById('rename-input') || {}).value || '';
        if (!rv.trim()) { toast('名字不能为空，请重新输入'); break; }
        await St.renameProfile(rv, renameTargetId);
        renderProfileSheet(); render(); toast('名字已更新');
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
        confirmSheet('删除使用者', '会删除这个使用者的全部本地记录，此操作不可撤销；云端存档和其他使用者不受影响。', '删除', async function () {
          await St.deleteProfile(d.id);
          await afterProfileChange();
          toast('已删除该使用者');
        });
        break;
      case 'start-daily': startRound({ mode: 'daily', count: 5, unit: S().digUnit, lesson: S().digLesson }); break;
      case 'resume-round': {
        var pr = St.loadRound();
        if (!pr) { toast('这一趟已经不在了'); render(); break; }
        round = pr; closeOverlay(); render(); window.scrollTo(0, 0);
        break;
      }
      case 'drop-round': St.clearRound(); render(); toast('已放弃这一趟'); break;
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
      case 'next': advance(); break;
      case 'again': startRound(round.spec); break;
      case 'go-wrong': round = null; tab = 'wrong'; render(); break;
      case 'redo':
        startRound({ mode: 'topic', count: 1, kp: '' });
        if (round) {
          var q = window.YW_Q_BY_ID[d.qid];
          if (q) {
            round.items = [{ q: q, isReview: true }];
            round.label = '重做这道';
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
        var code = (document.getElementById('space-input') || {}).value;
        if (!code || !code.trim()) { toast('先填存档码'); break; }
        var target = code.trim(), rows;
        try { rows = await Cl.listSaves(target); ui.cloudOk = true; ui.cloudMsg = ''; }
        catch (e) { ui.cloudOk = false; ui.cloudMsg = e.message; toast('读取云端失败：' + e.message); break; }
        if (!rows || !rows.length) { await St.setSpaceId(target); render(); toast('这个存档码下还没有云端记录'); break; }
        var doRestore = async function () {
          await St.setSpaceId(target);
          St.applySnapshot(rows[0].payload);
          ui.cloudSaves = rows;
          ui.lastSyncAt = '已从云端恢复 ' + dateOf(rows[0]);
          await refreshCloudList(false);
          updateSyncBar(); render();
          toast('已恢复 ' + dateOf(rows[0]) + ' 的进度');
        };
        if (!isFreshProfile(S())) {
          confirmSheet('覆盖本机记录？', '这个设备当前已有练习记录，恢复云端存档会覆盖它们。确定继续吗？', '覆盖并恢复', doRestore);
        } else await doRestore();
        break;
      }
      case 'saves-refresh': await refreshCloudList(true); updateSyncBar(); toast('云端已重新检查'); break;
      case 'cloud-offer-pick': {
        var offer = (ui.cloudOffers || [])[Number(d.i)];
        if (!offer) break;
        await St.setSpaceId(offer.code);
        St.applySnapshot(offer.payload);
        ui.lastSyncAt = '已从云端恢复 ' + offer.date;
        await refreshCloudList(false);
        updateSyncBar(); closeOverlay(); render();
        toast('已接着云端存档继续');
        break;
      }
      case 'sync-now': {
        var nowPayload = St.finalizeDay(St.todayKey());
        await syncDate(nowPayload);
        render(); toast(ui.lastError ? '同步失败：' + ui.lastError : '今天的存档已上传');
        break;
      }
      case 'cloud-pull': {
        var pulled;
        try { pulled = await Cl.listSaves(S().spaceId); }
        catch (e) { toast('拉取失败：' + e.message); break; }
        if (!pulled || !pulled.length) { toast('云端还没有这个使用者的存档'); break; }
        var runPull = async function () {
          St.applySnapshot(pulled[0].payload);
          ui.lastSyncAt = '已从云端恢复 ' + dateOf(pulled[0]);
          await refreshCloudList(false); render(); toast('进度已从云端刷新');
        };
        if (!isFreshProfile(S())) {
          confirmSheet('用云端进度覆盖本机？', '本机当前记录会被云端最新一份替换。', '覆盖并刷新', runPull);
        } else await runPull();
        break;
      }
      case 'saves-view': {
        var p = findPayload(d.date);
        overlay('<h2>' + d.date + ' 的存档</h2>' +
          '<p class="muted">只有题号、对错、错因和掌握度，不含姓名或课文内容。</p>' +
          '<pre style="white-space:pre-wrap;font-size:12px;background:var(--paper-2);padding:10px;border:2px solid var(--line)">' +
          esc(JSON.stringify(p, null, 2)) + '</pre>' +
          '<div class="btn-row"><button class="btn ghost" data-action="close-overlay">关掉</button>' +
          '<button class="btn primary" data-action="saves-download" data-date="' + d.date + '">下载这份</button></div>');
        break;
      }
      case 'saves-download': {
        var pd = findPayload(d.date);
        if (pd) download('方块语文-存档-' + d.date + '.json', pd);
        break;
      }
      case 'saves-restore': {
        var pr = findPayload(d.date);
        if (!pr) { toast('找不到这份存档'); break; }
        St.applySnapshot(pr); render(); toast('已恢复到 ' + d.date + ' 的记录'); break;
      }
      case 'close-overlay': closeOverlay(); break;
      case 'toggle-anim': await St.setNoAnim(!S().noAnim); render(); break;
      case 'export-all': download('方块语文-全部数据-' + St.todayKey() + '.json', St.exportAll()); toast('已导出'); break;
      case 'import-all': document.getElementById('import-file').click(); break;
      case 'reset-local':
        confirmSheet('清空本地记录', '确定清空「' + St.profileName() + '」的全部本地记录？此操作不可撤销，云端存档和其他使用者不受影响。', '清空', async function () {
          await St.resetLocal(); round = null; render(); toast('该使用者的本地记录已清空');
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
      await St.setGrade(g, term); render();
      toast('已切到 ' + g + ' 年级' + term + '册，旧年级内容自动进入回忆录');
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
      tab = b.dataset.tab; closeOverlay(); render(); window.scrollTo(0, 0);
    });
  });

  boot();
})();
