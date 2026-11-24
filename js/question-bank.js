/* 按「课文 × 维度」生成三上原创题库。
 * 六个维度：拼音字音 / 生字生词 / 句子运用 / 阅读理解 / 背诵积累 / 文体方法。
 * 所有题干、例句、解析均为原创；仅公有领域古诗用于积累题。见 NOTICE.md。
 *
 * 质量约定：
 *  - 每道题自带课文出处（题干前缀《课题》· 与 lessonTitle 字段），界面显示「第 N 课《课题》」
 *  - 生字题一律用形近字选字填空，干扰项必须是同音/形近的单字，不能靠「找含目标字的词」秒选
 *  - 阅读与方法题的干扰项必须是「看似合理但理解错」，不用一眼假的凑数项
 *  - 每课一道独立句子题，不复用题干
 */
(function () {
  'use strict';

  window.YW_DIMS = {
    pinyin:  { label: '拼音与字音', kp: ['pinyin', 'duoyinzi', 'yicuoyin'] },
    zici:    { label: '生字生词',   kp: ['zici', 'xingjinzi', 'ciyu', 'liangci', 'bihua'] },
    juzi:    { label: '句子运用',   kp: ['juzi', 'deDiDe', 'bingju', 'biaodian', 'xiuci'] },
    yuedu:   { label: '阅读理解',   kp: ['yuedu', 'lijie', 'guancha'] },
    beisong: { label: '背诵积累',   kp: ['beisong', 'gushi'] },
    changshi:{ label: '文体与方法', kp: ['changshi', 'wenyan'] },
  };

  Object.assign(window.YW_KP, {
    pinyin:   { label: '拼音与字音', hint: '声母、韵母、声调都要看准' },
    zici:     { label: '生字字形',   hint: '先看偏旁，再想能组什么词' },
    juzi:     { label: '句子运用',   hint: '逐字读，找重复和搭配不当' },
    yuedu:    { label: '阅读理解',   hint: '回到题目问的那一点' },
    beisong:  { label: '背诵积累',   hint: '别把同一首诗的句子顺序背串' },
    changshi: { label: '文体与方法', hint: '先看清这一单元练的是什么本领' },
  });

  var DATA = window.YW_LESSON_DATA;
  var out = [];
  var LESSON_TITLE = {};
  DATA.forEach(function (d) { LESSON_TITLE[d[1]] = d[2]; });

  // 正确项固定在 options[0]，按 seed 轮转到不同位置，避免答案永远是 A
  function rotate(options, seed) {
    var shift = ((seed % 4) + 4) % 4;
    var correct = options[0], others = options.slice(1);
    var arr = [], oi = 0;
    for (var i = 0; i < 4; i++) arr.push(i === shift ? correct : others[oi++]);
    var trap = [];
    for (var j = 0; j < 4 && trap.length < 2; j++) if (j !== shift) trap.push(j);
    return { options: arr, answer: shift, trap: trap };
  }

  function add(id, u, n, dim, kp, stem, opts, seed, tip, focus) {
    var r = rotate(opts, seed);
    var title = LESSON_TITLE[n] || '';
    // 题干显式标出课文；已含书名号的题干（如《山行》）不重复加前缀
    var prefix = title && stem.indexOf('《') < 0 ? '《' + title + '》· ' : '';
    out.push({
      id: id, unit: u, lesson: n, grade: 3, term: '上', dim: dim, kp: kp,
      lessonTitle: title,
      stem: prefix + stem, options: r.options, answer: r.answer, trap: r.trap,
      focus: focus || [], tip: tip, rotated: true,
    });
  }

  // 与旧题重复的古诗「下一句」改成理解题，避免同一句诗考两遍
  var POEM_ALT = {
    '4-1': ['「停车坐爱枫林晚」写的是哪个季节？', '深秋', '初春', '盛夏', '寒冬',
            '「枫林」「霜叶」都写的是深秋时节。', '深秋'],
    '4-2': ['「湖光秋月两相和」写的是哪里的景色？', '洞庭湖', '西湖', '长江', '黄河',
            '这句出自《望洞庭》，写的是秋夜的洞庭湖。', '洞庭湖'],
    '20-2': ['「空山不见人，但闻人语响」写出了山林的什么？', '幽静', '热闹', '寒冷', '明亮',
             '看不见人、只听见说话声，反而更显出山林安静。', '幽静'],
  };

  DATA.forEach(function (d) {
    var u = d[0], n = d[1], title = d[2], py = d[3], ci = d[4], rd = d[5], rec = d[6], xj = d[7], jz = d[8];

    // 1-2 拼音字音
    add('b' + n + 'p1', u, n, 'pinyin', 'pinyin',
      '「' + py[0][0] + '」在「' + py[0][1] + '」里读：', py[0][2], n,
      '「' + py[0][0] + '」读 ' + py[0][2][0] + '，别读成 ' + py[0][2][1] + '。', [py[0][0]]);
    add('b' + n + 'p2', u, n, 'pinyin', 'yicuoyin',
      '下面哪一个是「' + py[1][0] + '」（' + py[1][1] + '）的正确读音？', py[1][2], n + 1,
      '「' + py[1][0] + '」读 ' + py[1][2][0] + '；' + py[1][2][1] + ' 是常见误读。', [py[1][0]]);

    // 3 生字：形近字选字填空（干扰项全部是同音/形近单字，必须辨字形字义）
    add('b' + n + 'z1', u, n, 'zici', 'xingjinzi', xj[0],
      [xj[1], xj[2], xj[3], xj[4]], n + 2, xj[5], [xj[1]]);

    // 4 生字生词：近义辨析
    add('b' + n + 'c1', u, n, 'zici', 'ciyu',
      '下面哪个词和「' + ci[0] + '」意思最接近？', ci[1], n + 3,
      '「' + ci[0] + '」的近义词是「' + ci[1][0] + '」。', [ci[0], ci[1][0]]);

    // 5 句子运用：每课一道独立题，不再循环复用 6 个通用句型
    add('b' + n + 'j1', u, n, 'juzi', jz[6], jz[0],
      [jz[1], jz[2], jz[3], jz[4]], n + 4, jz[5], [jz[1]]);

    // 6 阅读理解（自编概述题，不引用课文原文）
    add('b' + n + 'y1', u, n, 'yuedu', 'yuedu', rd[0],
      [rd[1], rd[2], rd[3], rd[4]], n + 5,
      '《' + title + '》讲的是：' + rd[1] + '。做题时回到课文主要写的那件事。', [title]);

    // 7 背诵积累（仅古诗课；公有领域作品，与旧题重复的改考理解）
    if (rec) rec.forEach(function (g, idx) {
      var key = n + '-' + (idx + 1), alt = POEM_ALT[key];
      if (alt) {
        add('b' + n + 'b' + (idx + 1), u, n, 'beisong', 'beisong', alt[0],
          [alt[1], alt[2], alt[3], alt[4]], n + idx + 6, alt[5], [alt[6]]);
      } else {
        add('b' + n + 'b' + (idx + 1), u, n, 'beisong', 'beisong',
          '「' + g[0] + '」的下一句是：', [g[1], g[2], g[3], g[4]], n + idx + 6,
          '下一句是「' + g[1] + '」。同一首诗的其他句子别背串了顺序。', [g[0], g[1]]);
      }
    });
  });

  // 8 每单元一道文体与方法题（干扰项改成 plausible 的替代做法）
  var METHODS = [
    [1, 1, '读完一段话，能概括这段主要意思的句子叫：', '中心句', ['过渡句', '比喻句', '反问句'], '能概括整段意思的是中心句，常在段首。'],
    [2, 4, '遇到不理解的词语，下面哪种做法最合适？', '联系上下文猜一猜再验证', ['只查字典的第一个义项', '把每个字拆开逐字解释', '把整段话抄一遍再读'], '联系上下文猜、再回头验证，比只看字典第一个义项更准。'],
    [3, 8, '边读边猜后面会发生什么、读下去再验证，这叫：', '预测', ['背诵', '摘抄', '默写'], '预测不是瞎猜，要边读边找依据。'],
    [4, 11, '童话故事最突出的特点是：', '大胆的想象', ['按时间顺序记真人真事', '用数据说明一个道理', '把景物写成说明文'], '童话靠想象把不可能的事写得像真的。'],
    [5, 15, '要发现事物随时间的变化，最该怎么做？', '连续几天在同一时间观察', ['挑最特别的一天仔细看', '问问别人那天是什么样', '把书上的插图看仔细'], '只挑一天看不出变化规律，要连续、定时地看。'],
    [6, 18, '按春、夏、秋、冬来写，用的是什么顺序？', '时间顺序', ['方位顺序', '由远及近', '事情发展顺序'], '四季属于时间推移。'],
    [7, 21, '「滴滴答答」这类模拟声音的词叫：', '拟声词', ['量词', '关联词', '反义词'], '拟声词就是照着声音写出来的词。'],
    [8, 23, '《司马光》这样的短文用的是：', '文言文', ['现代白话', '日记', '书信'], '文言文字少、意思密，字义和今天常有不同。'],
  ];
  METHODS.forEach(function (m, idx) {
    add('m' + m[0], m[0], m[1], 'changshi', 'changshi', m[2],
      [m[3]].concat(m[4]), idx + 7, m[5], [m[3]]);
  });

  // 旧题（原有 73 道）答案位置也做确定性轮转，避免近半数答案集中在 A；
  // 同时按位置映射保留 trap（粗心陷阱项）的语义，错因分类不会失效。
  window.YW_QUESTIONS.forEach(function (q, idx) {
    if (q.rotated) return;
    var old = q.options.slice();
    var correctAt = q.answer;
    var shift = (idx * 3 + 1) % 4;
    var others = old.map(function (o, i) { return { o: o, i: i }; })
      .filter(function (x) { return x.i !== correctAt; });
    var arr = [], posMap = {}, oi = 0;
    for (var i = 0; i < 4; i++) {
      if (i === shift) { arr.push(old[correctAt]); posMap[correctAt] = shift; }
      else { arr.push(others[oi].o); posMap[others[oi].i] = i; oi++; }
    }
    q.trap = (q.trap || []).map(function (i) { return posMap[i]; })
      .filter(function (i) { return i !== undefined; });
    q.options = arr; q.answer = shift; q.rotated = true;
  });

  // 给原有题目补上维度与课文字段，保证旧数据与 UI 一致
  function dimOf(kp) {
    var keys = Object.keys(window.YW_DIMS);
    for (var i = 0; i < keys.length; i++) {
      if (window.YW_DIMS[keys[i]].kp.indexOf(kp) >= 0) return keys[i];
    }
    return 'changshi';
  }
  window.YW_QUESTIONS.forEach(function (q) {
    if (!q.dim) q.dim = dimOf(q.kp);
    if (!q.lessonTitle) q.lessonTitle = q.grade === 3 ? (LESSON_TITLE[q.lesson] || '') : '';
  });
  out.forEach(function (q) { window.YW_Q_BY_ID[q.id] = q; });

  window.YW_BANK_QUESTIONS = out;
  window.YW_QUESTIONS = window.YW_QUESTIONS.concat(out);

  // 轻量输出题「补一个字」：只挑题干自带括号、且正确答案正好是 1–3 个汉字的题。
  // 不新增题目、不改题干和选项；判卷时把输入的字映射回原来的选项索引，
  // 所以计分、错题集、掌握度、错因归类全部沿用原口径，不另起一套规则。
  window.YW_QUESTIONS.forEach(function (q) {
    if (q.fill) return;
    var a = String(q.options && q.options[q.answer] != null ? q.options[q.answer] : '');
    if (!/^[\u4e00-\u9fa5]{1,3}$/.test(a)) return;   // 排除带省略号、标点或过长的答案
    if (!/（\s*）|\(\s*_+\s*\)/.test(q.stem)) return; // 题干必须本来就有空位
    q.fill = { accepts: [a] };
  });
})();
