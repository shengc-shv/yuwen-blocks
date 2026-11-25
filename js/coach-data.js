/* 专项训练数据：从各册素材抽出生字词与阅读六层题
 * 全部源自本项目已有的原创素材，不引入教材原文或教辅题目。
 * 生词条目 = { ch 生字, word 词语, py 正确读音, wrong 三个误读, unit, lesson, book }
 * 阅读分层 = 六层能力，每层带一句原创方法提示。
 */
(function () {
  'use strict';
  var WORDS = [];
  function collect(bookId, grade, term, data) {
    (data || []).forEach(function (d) {
      var u = d[0], n = d[1], title = d[2], py = d[3] || [];
      py.forEach(function (p) {
        WORDS.push({
          id: bookId + '-w-' + n + '-' + p[0], ch: p[0], word: p[1],
          py: p[2][0], wrong: (p[2] || []).slice(1, 4),
          unit: u, lesson: n, title: title, book: bookId, grade: grade, term: term,
        });
      });
    });
  }
  collect('g3s1', 3, '上', window.YW_LESSON_DATA || []);
  collect('g3s2', 3, '下', (window.YW_G3S2_DATA || []).map(function (d) {
    // 三下素材的拼音项格式：[字, 组词, [读音×4]]，与三上一致
    return d;
  }));

  // 阅读六层：由浅入深，每层给方法，不只是「做对/做错」
  var READ_LAYERS = [
    { key:'info',    label:'找信息',   hint:'先看题目问什么，再回到文章里圈出那句话', kps:['xinxi','lijie'] },
    { key:'gist',    label:'概括内容', hint:'谁做了什么，结果怎样；别把细节当段意',      kps:['gaini'] },
    { key:'word',    label:'理解词句', hint:'把词放回句子里，联系上下文猜再验证',        kps:['ciyu','yuedu'] },
    { key:'feel',    label:'体会情感', hint:'从「高兴、担心、想念」这类词找心情',        kps:['qinggan'] },
    { key:'craft',   label:'赏析方法', hint:'先认出比喻拟人，再说它把什么写活了',        kps:['xiuci'] },
    { key:'lesson',  label:'感悟启示', hint:'故事讲完，想想这件事对自己有什么用',      kps:['qishi','renwu'] },
  ];
  READ_LAYERS[5].hint = '故事讲完，想想这件事对自己有什么用';

  function readingQuestions(layerKey, bookId, grade, term) {
    var layer = READ_LAYERS.filter(function (l) { return l.key === layerKey; })[0];
    if (!layer) return [];
    return window.YW_QUESTIONS.filter(function (q) {
      if (q.book !== bookId) return false;
      if (layer.kps.indexOf(q.kp) < 0) return false;
      return true;
    });
  }

  window.YW_COACH_WORDS = WORDS;
  window.YW_COACH_LAYERS = READ_LAYERS;
  window.YW_COACH_READING = readingQuestions;
})();
