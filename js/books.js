/* 册次注册表：一个册次 = 一份课程目录 + 一套题库。
 * 「陪着娃长大」的地基：以后加一册，只要在这里登记，再放一份素材文件即可，
 * 组卷、回忆录、BOSS、训练场都不用改。
 *
 * 目录（单元、课号、课题）为公开教材的事实性引用；
 * 全部题目、例句、解析由本项目自行编写，不含教材原文或教辅内容。
 */
(function () {
  'use strict';

  // 题目录入时统一打 book 标签，回忆录按「册次顺序」而不是单纯年级比较
  var BOOKS = {
    g3s1: {
      id: 'g3s1', grade: 3, term: '上', edition: '三年级上 · 人教版 2026 秋版', order: 1,
      units: [
        { id:1, name:'学校生活', lessons:[{n:1,t:'大青树下的小学'},{n:2,t:'花的学校'},{n:3,t:'不懂就要问'}] },
        { id:2, name:'金秋时节', lessons:[{n:4,t:'古诗三首'},{n:5,t:'铺满金色巴掌的水泥道'},{n:6,t:'秋天的雨'},{n:7,t:'听听，秋的声音'}] },
        { id:3, name:'预测与童话', lessons:[{n:8,t:'总也倒不了的老屋'},{n:9,t:'犟龟'},{n:10,t:'小狗学叫'}] },
        { id:4, name:'童话世界', lessons:[{n:11,t:'宝葫芦的秘密'},{n:12,t:'在牛肚子里旅行'},{n:13,t:'一块奶酪'}] },
        { id:5, name:'留心观察', lessons:[{n:14,t:'搭船的鸟'},{n:15,t:'金色的草地'}] },
        { id:6, name:'祖国河山', lessons:[{n:16,t:'富饶的西沙群岛'},{n:17,t:'海滨小城'},{n:18,t:'美丽的小兴安岭'},{n:19,t:'香港，璀璨的明珠'}] },
        { id:7, name:'我与自然', lessons:[{n:20,t:'古诗三首'},{n:21,t:'大自然的声音'},{n:22,t:'读不完的大书'}] },
        { id:8, name:'美好品质', lessons:[{n:23,t:'司马光'},{n:24,t:'一定要争气'},{n:25,t:'手术台就是阵地'},{n:26,t:'一个粗瓷大碗'}] },
      ],
    },
    g3s2: {
      id: 'g3s2', grade: 3, term: '下', edition: '三年级下 · 人教统编版 2026 春版', order: 2,
      units: [
        { id:1, name:'可爱的生灵', lessons:[{n:1,t:'古诗三首'},{n:2,t:'燕子'},{n:3,t:'荷花'},{n:4,t:'昆虫备忘录'}] },
        { id:2, name:'寓言故事', lessons:[{n:5,t:'守株待兔'},{n:6,t:'陶罐和铁罐'},{n:7,t:'鹿角和鹿腿'},{n:8,t:'池子与河流'}] },
        { id:3, name:'观察与发现', lessons:[{n:9,t:'海底世界'},{n:10,t:'石蜂'},{n:11,t:'小虾'}] },
        { id:4, name:'传统文化', lessons:[{n:12,t:'古诗三首'},{n:13,t:'纸的发明'},{n:14,t:'赵州桥'},{n:15,t:'一幅名扬中外的画'}] },
        { id:5, name:'奇妙想象', lessons:[{n:16,t:'胡萝卜先生的长胡子'},{n:17,t:'我变成了一棵树'}] },
        { id:6, name:'多彩童年', lessons:[{n:18,t:'童年的水墨画'},{n:19,t:'肥皂泡'},{n:20,t:'灰雀'},{n:21,t:'我不能失信'}] },
        { id:7, name:'奇妙世界', lessons:[{n:22,t:'火烧云'},{n:23,t:'我们奇妙的世界'},{n:24,t:'暴风雨来临之前'}] },
        { id:8, name:'有趣故事', lessons:[{n:25,t:'慢性子裁缝和急性子顾客'},{n:26,t:'漏'},{n:27,t:'枣核'}] },
      ],
    },
  };

  function bookOf(grade, term) {
    var keys = Object.keys(BOOKS);
    for (var i = 0; i < keys.length; i++) {
      if (BOOKS[keys[i]].grade === Number(grade) && BOOKS[keys[i]].term === term) return BOOKS[keys[i]];
    }
    return null;
  }
  function unitsOf(grade, term) {
    var b = bookOf(grade, term);
    return b ? b.units : (BOOKS.g3s1.units);
  }
  function lessonTitle(bookId, n) {
    var b = BOOKS[bookId];
    if (!b) return '';
    for (var i = 0; i < b.units.length; i++) {
      for (var j = 0; j < b.units[i].lessons.length; j++) {
        if (b.units[i].lessons[j].n === Number(n)) return b.units[i].lessons[j].t;
      }
    }
    return '';
  }
  // 给现存题目补 book 标签：三上原有题全是 g3s1，只有 grade<3 的回忆录题按年级估一个顺序
  (window.YW_QUESTIONS || []).forEach(function (q) {
    if (q.book) return;
    q.book = q.grade >= 3 ? 'g3s1' : ('g' + q.grade);
  });
  // 三上题库引用（生成阶段已完成，这里只登记，便于统一统计）
  if (!window.YW_BOOK_BANKS) window.YW_BOOK_BANKS = {};
  if (!window.YW_BOOK_BANKS.g3s1) {
    window.YW_BOOK_BANKS.g3s1 = window.YW_QUESTIONS.filter(function (q) { return q.book === 'g3s1'; });
  }
  function isPast(q, grade, term) {
    var cur = bookOf(grade, term);
    var qb = BOOKS[q.book];
    if (!cur) return false;
    if (!qb) return q.grade < Number(grade);  // 低年级回忆录题
    return qb.order < cur.order;
  }
  function isCurrent(q, grade, term) {
    var cur = bookOf(grade, term);
    return !!cur && q.book === cur.id;
  }

  // YW_UNITS 改为按当前册次动态返回，旧代码（单元名、专项复习、BOSS 卡）无需改动
  var _units = window.YW_UNITS;
  Object.defineProperty(window, 'YW_UNITS', {
    configurable: true,
    get: function () {
      if (window.__YW_CURRENT_BOOK__) {
        var b = BOOKS[window.__YW_CURRENT_BOOK__];
        if (b) return b.units;
      }
      return _units;
    },
  });

  window.YW_BOOKS = BOOKS;
  window.YW_BOOKS_LIST = Object.keys(BOOKS).map(function (k) { return BOOKS[k]; });
  window.YW_BOOK_OF = bookOf;
  window.YW_UNITS_OF = unitsOf;
  window.YW_LESSON_TITLE = lessonTitle;
  window.YW_IS_PAST = isPast;
  window.YW_IS_CURRENT = isCurrent;

  // 覆盖旧的两个判定：原来只比 grade，同级上下册会串题；现在按册次顺序精确分流
  window.YW_pastQuestions = function (grade, term) {
    return window.YW_QUESTIONS.filter(function (q) { return isPast(q, grade, term); });
  };
  window.YW_currentQuestions = function (grade, term, units) {
    return window.YW_QUESTIONS.filter(function (q) {
      return isCurrent(q, grade, term) && (!units || units.indexOf(q.unit) >= 0);
    });
  };
})();
