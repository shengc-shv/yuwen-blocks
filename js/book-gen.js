/* 通用组卷器：把某册的「按课素材」转成题目并登记到全局题库。
 * 与三上原生成器同口径：正确项固定在素材第 0 位，按课号轮转到不同位置；
 * 输出题（填空/挑错字/排顺序）仍只换呈现，判定映射回原选项索引。
 */
(function () {
  'use strict';
  function genBook(opt) {
    var bookId = opt.bookId, grade = opt.grade, term = opt.term;
    var DATA = opt.data, titleOf = opt.titleOf || {};
    var out = [];
    function rotate(options, seed) {
      var shift = ((seed % 4) + 4) % 4;
      var correct = options[0], others = options.slice(1), arr = [], oi = 0;
      for (var i = 0; i < 4; i++) arr.push(i === shift ? correct : others[oi++]);
      var trap = [];
      for (var j = 0; j < 4 && trap.length < 2; j++) if (j !== shift) trap.push(j);
      return { options: arr, answer: shift, trap: trap };
    }
    function add(id, u, n, dim, kp, stem, opts, seed, tip, focus) {
      var r = rotate(opts, seed);
      var title = titleOf[n] || '';
      var prefix = title && stem.indexOf('《') < 0 ? '《' + title + '》· ' : '';
      out.push({
        id: id, unit: u, lesson: n, grade: grade, term: term, book: bookId,
        dim: dim, kp: kp, lessonTitle: title,
        stem: prefix + stem, options: r.options, answer: r.answer, trap: r.trap,
        focus: focus || [], tip: tip, rotated: true,
      });
    }
    DATA.forEach(function (d) {
      var u = d[0], n = d[1], title = d[2], py = d[3], ci = d[4], rd = d[5], rec = d[6], xj = d[7], jz = d[8];
      add(bookId + '-' + n + 'p1', u, n, 'pinyin', 'pinyin',
        '「' + py[0][0] + '」在「' + py[0][1] + '」里读：', py[0][2], n,
        '「' + py[0][0] + '」读 ' + py[0][2][0] + '，别读成 ' + py[0][2][1] + '。', [py[0][0]]);
      var pyReads = (py[1][2] || []).slice();
      while (pyReads.length < 4) pyReads.push(['bā', 'pā', 'mā', 'fā', 'dā', 'tā'][pyReads.length % 6]);
      add(bookId + '-' + n + 'p2', u, n, 'pinyin', 'yicuoyin',
        '下面哪个是「' + py[1][0] + '」（' + py[1][1] + '）的正确读音？', pyReads.slice(0, 4), n + 1,
        '「' + py[1][0] + '」读 ' + pyReads[0] + '，其余是常见误读。', [py[1][0]]);
      add(bookId + '-' + n + 'z1', u, n, 'zici', 'xingjinzi', xj[0],
        [xj[1], xj[2], xj[3], xj[4]], n + 2, xj[5], [xj[1]]);
      add(bookId + '-' + n + 'c1', u, n, 'zici', 'ciyu',
        '「' + ci[0] + '」的意思是：', ci[1], n + 3,
        '「' + ci[0] + '」就是「' + ci[1][0] + '」。', [ci[0], ci[1][0]]);
      add(bookId + '-' + n + 'j1', u, n, jz[6] === 'xiuci' ? 'juzi' : 'juzi',
        jz[6] || 'bingju', jz[0], [jz[1], jz[2], jz[3], jz[4]], n + 4, jz[5], [jz[1]]);
      add(bookId + '-' + n + 'y1', u, n, 'yuedu', 'yuedu', rd[0],
        [rd[1], rd[2], rd[3], rd[4]], n + 5,
        '《' + title + '》里：' + rd[1] + '。做题时回到课文主要写的那件事。', [title]);
      if (rec) rec.forEach(function (g, idx) {
        add(bookId + '-' + n + 'b' + (idx + 1), u, n, 'beisong', 'gushi',
          '「' + g[0] + '」的下一句是：', [g[1], g[2], g[3], g[4]], n + idx + 6,
          '下一句是「' + g[1] + '」。同一首诗的其他句子别背串了顺序。', [g[0], g[1]]);
      });
    });
    // 每单元一道方法题（框架来自课标通用能力，文案原创）
    var METHODS = {
      1: ['观察春天景物时，抓住最有特点的一两处写，这叫：', '抓住特点', ['顺序记录', '逐字翻译', '列数字'], '写景要抓特点，不能什么都写一点。'],
      2: ['读寓言最该明白的是：', '故事里的道理', ['人物穿什么衣服', '一共有几段', '作者是哪国人'], '寓言的重点在道理，不在情节细节。'],
      3: ['要写清一次小实验，最该按顺序写：', '做法和发现', ['心情和天气', '颜色和名字', '时间和地点'], '实验类习作重在过程和发现。'],
      4: ['《清明上河图》这类画属于：', '反映生活的风俗画', ['只有风景的画', '课本插图', '一张照片'], '风俗画记录的是当时人们的日常生活。'],
      5: ['童话里「我变成了一棵树」这样的情节属于：', '大胆的想象', ['真实的记录', '严格的说明', '现场采访'], '童话靠想象把不可能写得有趣。'],
      6: ['写「身边那些有特点的人」，最关键的是：', '用一件事写出特点', ['把名字写很多遍', '只写外貌', '抄课文'], '特点要靠具体事例来表现。'],
      7: ['「一会儿红彤彤，一会儿金灿灿」这类词主要写出：', '颜色和变化', ['声音大小', '人物性格', '心情好坏'], '叠词让画面的颜色和变化更鲜明。'],
      8: ['民间故事里相似情节反复出现，这种手法叫：', '反复', ['倒叙', '说明', '议论'], '反复能加深印象，也是故事好记的原因。'],
    };
    Object.keys(METHODS).forEach(function (u, idx) {
      var m = METHODS[u];
      add(bookId + '-m' + u, Number(u), 0, 'changshi', 'changshi', m[0],
        [m[1]].concat(m[2]), idx + 9, m[3], [m[1]]);
    });
    out.forEach(function (q) {
      window.YW_Q_BY_ID[q.id] = q;
    });
    window.YW_QUESTIONS = window.YW_QUESTIONS.concat(out);
    if (!window.YW_BOOK_BANKS) window.YW_BOOK_BANKS = {};
    window.YW_BOOK_BANKS[bookId] = out;
    return out;
  }
  window.YW_GEN_BOOK = genBook;
})();
