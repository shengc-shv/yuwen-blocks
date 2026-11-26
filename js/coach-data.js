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

  // 默写要写整个词，就得给出整个词的拼音；原来只显示生字拼音，孩子无从推出另一个字。
  // 这里按「词语」补上整词读音（含轻声），只用于默写提示，不改原有单字拼音与判定。
  var WORD_PY = {
    '大坝':'dà bà', '早晨':'zǎo chén', '笛子':'dí zi', '荒野':'huāng yě',
    '背诵':'bèi sòng', '戒尺':'jiè chǐ', '石径':'shí jìng', '霜叶':'shuāng yè',
    '水洼':'shuǐ wā', '雨靴':'yǔ xuē', '钥匙':'yào shi', '缤纷':'bīn fēn',
    '抖动':'dǒu dòng', '歌韵':'gē yùn', '暴风雨':'bào fēng yǔ', '偶尔':'ǒu ěr',
    '犟脾气':'jiàng pí qi', '邀请':'yāo qǐng', '模仿':'mó fǎng', '陌生':'mò shēng',
    '葫芦':'hú lu', '秘密':'mì mì', '旅行':'lǚ xíng', '细嚼慢咽':'xì jiáo màn yàn',
    '奶酪':'nǎi lào', '诱人':'yòu rén', '翠鸟':'cuì niǎo', '衔着':'xián zhe',
    '蒲公英':'pú gōng yīng', '合拢':'hé lǒng', '富饶':'fù ráo', '海参':'hǎi shēn',
    '海滨':'hǎi bīn', '栽树':'zāi shù', '沉浸':'chén jìn', '献出':'xiàn chū',
    '璀璨':'cuǐ càn', '贸易':'mào yì', '鹿柴':'lù zhài', '潋滟':'liàn yàn',
    '演奏':'yǎn zòu', '呢喃':'ní nán', '蚂蚱':'mà zha', '凉爽':'liáng shuǎng',
    '水瓮':'shuǐ wèng', '皆是':'jiē shì', '成绩':'chéng jì', '瞧见':'qiáo jiàn',
    '镇定':'zhèn dìng', '争夺':'zhēng duó', '粗瓷':'cū cí', '水缸':'shuǐ gāng',
  };
  // 每课补的写字表词语：并进来一起练，id 与课内原有词不冲突（冲突的会被过滤掉）
  (window.YW_EXTRA_WORDS || []).forEach(function (w) {
    var dup = WORDS.some(function (x) { return x.id === w.id; });
    if (dup) return;
    WORDS.push({
      id: w.id, ch: w.ch, word: w.word, py: w.py, wrong: w.wrong,
      unit: w.unit, lesson: w.lesson, title: w.title,
      book: w.book, grade: w.grade, term: w.term,
      pyw: w.pyw || '',
    });
  });

  WORDS.forEach(function (w) {
    // 整词拼音优先用词表；表里没有就退回单字拼音——
    // 但补充词自带 pyw，不会再出现「一个词只显示一个音」的情况
    w.wordPy = w.pyw || WORD_PY[w.word] || w.py;   // 绝不编造
  });

  window.YW_COACH_WORDS = WORDS;
  window.YW_COACH_LAYERS = READ_LAYERS;
  window.YW_COACH_READING = readingQuestions;
})();
