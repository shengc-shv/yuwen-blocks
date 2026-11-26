/* 分层错题解析生成器
 *
 * 方法框架参考公开教研中较为一致的做法：先定位错因、再做逐项排除、
 * 回扣考点、提炼可迁移的判断方法，最后遮住答案重做检验真会。
 * 本文件所有文案均为本项目原创编写，不引用任何外部文章或教辅原文。
 *
 * 关键原则：解析必须贴着「这一题」讲。因此按知识点细分模板族，
 * 逐项排除还要点名孩子实际选中的那个选项；古诗另按题干区分
 * 「上下句顺序」与「诗句理解」，避免把理解题讲成背诵题。
 *
 * explain = { point, wrongWhy{选项文本: 排除理由}, right, method, check }
 * 仅作为运行时字段挂在题目上，不写进每日存档，云端数据结构不变。
 */
(function () {
  'use strict';

  var CHECK = '把上面的答案遮住，自己再选一次；能说出「刚才那个为什么不对」，才算真会。';

  var KITS = {
    /* ---- 字音 ---- */
    font: {
      point: '这题考字音：声母、韵母、声调一个都不能看错，也别按半个字猜读音。',
      wrong: function (o, q) {
        return '「' + o + '」不是这个字的读音。和「' + q.options[q.answer] +
               '」比一比，声母、韵母或声调总有一处对不上。';
      },
      method: '先拼准声母韵母，再看第几声；拿不准就把字放回词语里读一遍。',
    },
    duoyinzi: {
      point: '这题考多音字：同一个字，意思变了，读音也跟着变。',
      wrong: function (o, q) {
        return '「' + o + '」是这个字在别的地方才用的读音；题目里这个词读「' +
               q.options[q.answer] + '」，意思对不上就得换音。';
      },
      method: '把字放回词语里 → 先弄懂词语说什么 → 再选和这个意思配的那个音。',
    },

    /* ---- 字形 ---- */
    zi: {
      point: '这题考字形：看偏旁、想字义，别让长得像的字混过去。',
      wrong: function (o, q) {
        return '「' + o + '」和「' + q.options[q.answer] +
               '」只差一点，但放进这句话里读不成我们学过的词；先想想它的偏旁管什么意思。';
      },
      method: '先看偏旁猜意思 → 把词读一遍 → 读得通、意思对才选。',
    },
    bihua: {
      point: '这题考笔画笔顺：数清每一笔，记住先横后竖、先撇后捺。',
      wrong: function (o) {
        return '「' + o + '」不是这个字该有的笔数或笔顺；在心里把这个字写一遍，边写边数就能排掉。';
      },
      method: '边写边数，别把两点算成一笔；顺序记住「先横后竖、先撇后捺」。',
    },

    /* ---- 词语 ---- */
    ci: {
      point: '这题考词语：先看清问的是意思、搭配，还是词形（ABB / AABB）。',
      wrong: function (o) {
        return '「' + o + '」和题目要的对不上：可能意思不最接近，可能搭配不对，' +
               '也可能不是题目问的那种词形；逐个代进去比一比。';
      },
      method: '先划掉明显不对的（反义的、词形不符的），再把剩下的代回原句读一遍。',
    },
    liangci: {
      point: '这题考量词：不同的事物，要配不同的量词。',
      wrong: function (o) {
        return '「' + o + '」平时配的是别的事物，和这句话里的名词搭不上；把它代进去读一遍就能听出来。';
      },
      method: '先看空格后面是什么事物，再想它平时和哪个量词一起出现。',
    },

    /* ---- 句子 ---- */
    deDiDe: {
      point: '这题考「的 / 地 / 得」：看空格后面跟的是名词、动作，还是补充说明。',
      wrong: function (o) {
        return '「' + o + '」该用在别的位置。先看空格后面是名词、动作还是补说明，' +
               '再决定用哪一个，用错了读起来就不顺。';
      },
      method: '名词前用「的」，动作前用「地」，动词后面补说明才用「得」。',
    },
    biaodian: {
      point: '这题考标点：先判断这句话在提问、陈述、感叹，还是在并列列举。',
      wrong: function (o) {
        return '「' + o + '」表示的语气或停顿和这句话对不上；先把句子读一遍，' +
               '看它是在问、在说，还是在一样一样地列举。';
      },
      method: '问句用「？」，句中停顿用「，」，并列词语用「、」，一句说完用「。」。',
    },
    bingju: {
      point: '这题考句子：先看清前后半句是什么关系，再挑关联词 / 找语病。',
      wrong: function (o) {
        return '「' + o + '」表示的关系和这句话不一样（或用在这里句子不通），套进去意思就拧了。';
      },
      method: '因果、假设、转折、并列先分清；病句「三查」：主谓宾齐吗、搭配得当吗、意思重复吗。',
    },
    xiuci: {
      point: '这题考修辞：看句子把什么比作什么，有没有把事物当人写。',
      wrong: function (o) {
        return '「' + o + '」不是这句用的手法，句里找不到它的标志。' +
               '看到「像」先想比喻，出现人的动作表情才想拟人。';
      },
      method: '找标志词：「像 / 好像 / 仿佛」多是比喻；「唱歌 / 点头 / 悄悄说」把事物当人写才是拟人。',
    },

    /* ---- 阅读与方法 ---- */
    yuedu: {
      point: '这题考阅读：先圈出题目问的是原因、特点还是做法，再回课文找依据。',
      wrong: function (o, q) {
        var kind = /因为|为什么|原因/.test(q.stem) ? '把原因猜错了'
                 : /比作|比喻/.test(q.stem) ? '把打比方的事物弄错了'
                 : /顺序|怎样写|按什么/.test(q.stem) ? '把课文写的顺序记错了'
                 : '不是课文主要写的那件事';
        return '「' + o + '」' + kind + '。别凭常识猜，题目问什么就回课文找什么；' +
               '这一题对应的是「' + q.options[q.answer] + '」。';
      },
      method: '圈关键词 → 回课文找那一句 → 把选项和课文逐字对一遍；脱离原文、以偏概全的先排掉。',
    },
    method: {
      point: '这题考方法：先说清这个读书本领是什么，再看题目要的是不是它。',
      wrong: function (o) {
        return '「' + o + '」不是这个本领的用法，或者只做了一半；题目要的是能真正把问题弄清楚的那一种。';
      },
      method: '把四个选项都当成「做法」读一遍，问自己：照它做，能不能真的把问题弄清楚？',
    },
    wenyan: {
      point: '这题考文言字词：文言里的字义，常和今天说的意思不一样。',
      wrong: function (o) {
        return '「' + o + '」是按今天的意思去套的；放回原句读一读，句子就说不通了。';
      },
      method: '按课文注释记字义，别用现在常用的意思去猜；放回句子里检验通不通。',
    },

    /* ---- 古诗：按题干区分「背顺序」与「读懂诗句」---- */
    poemOrder: {
      point: '这题考积累：古诗要按句子顺序记，别把相邻两句背串。',
      wrong: function (o) {
        return '「' + o + '」是同一首诗（或另一首）里的句子，但位置不对；题目问的是紧接着的那一句。';
      },
      method: '在心里把整首诗从头背一遍，数到那一句再选，别只挑眼熟的。',
    },
    poemSense: {
      point: '这题考诗句理解：抓住句子里的关键词，想它写的是什么季节、什么景物。',
      wrong: function (o) {
        return '「' + o + '」和这句诗里的关键词对不上；先找出写季节、地点或动作的词，再判断。';
      },
      method: '先圈出诗句里表示季节、地点、动作的词，再对照选项，别凭眼熟就选。',
    },

    general: {
      point: '先把题目问的是什么读清楚，再把四个选项逐个对一遍。',
      wrong: function (o) {
        return '「' + o + '」和题目要的对不上；把它代回题目读一遍，就能发现哪里不搭。';
      },
      method: '四个选项都读完，先划掉明显不对的，再在剩下的里面比一比。',
    },
  };

  var ALIAS = {
    pinyin: 'font', yicuoyin: 'font', duoyinzi: 'duoyinzi',
    xingjinzi: 'zi', zici: 'zi', bihua: 'bihua',
    ciyu: 'ci', liangci: 'liangci',
    deDiDe: 'deDiDe', biaodian: 'biaodian', xiuci: 'xiuci',
    bingju: 'bingju', juzi: 'bingju',
    yuedu: 'yuedu',
    lijie: 'method', guancha: 'method', changshi: 'method',
    wenyan: 'wenyan',
    beisong: 'poem', gushi: 'poem',
  };

  function kitFor(q) {
    var k = ALIAS[q.kp];
    if (k === 'poem') {
      return /下一句|上一句|紧接着|顺序/.test(q.stem) ? KITS.poemOrder : KITS.poemSense;
    }
    return KITS[k] || KITS.general;
  }

  // 错因对症引导：教研强调「别笼统说粗心」，三类错因各给一条不同对策
  var COACH = {
    careless: '这次像是看漏了一个字，不是不会。下次先圈出题目问的那个词，四个选项都读完再点。',
    confused: '这两个长得太像，放一起比一比最管用。到「错题」里再看一遍，1、3、7 天它还会回来找你。',
    unknown: '这个知识点还不熟，不急。做完去「专项复习」按这个知识点再练几道，连对 2 次就能毕业。',
  };

  // 精写解析优先：按题目 id 逐题写的错项理由；没写到的题仍走模板，绝不空着
  function detailed(q) {
    var D = window.YW_EXPLAIN_DETAIL;
    if (!D || !D[q.id]) return null;
    var d = D[q.id], wrongWhy = {};
    q.options.forEach(function (o, i) {
      if (i !== q.answer) wrongWhy[o] = (d.wrong && d.wrong[o]) || d.right;
    });
    return {
      point: d.point || (KITS[kitFor(q).point] || {}).point || '',
      right: d.right || q.tip || '',
      method: d.method || '',
      check: CHECK,
      wrongWhy: wrongWhy,
      detailed: true,
    };
  }

  function build(q) {
    var kit = kitFor(q);
    var ex = {
      point: kit.point,
      right: q.tip || ('正确答案是「' + q.options[q.answer] + '」。'),
      method: kit.method,
      check: CHECK,
      wrongWhy: {},
    };
    q.options.forEach(function (o, i) {
      if (i !== q.answer) ex.wrongWhy[o] = kit.wrong(o, q);
    });
    return ex;
  }

  function of(q) {
    if (!q.explain) q.explain = detailed(q) || build(q);
    return q.explain;
  }

  function brief(q) {
    var e = of(q);
    return { point: e.point, method: e.method, right: e.right };
  }

  // 背诵题（按课文内容填空）不逐题写精写库，直接用题目自带的 tip——
  // 它在编写时就写清了「为什么是这个词、容易和什么记混」，比通用模板有信息量。
  // 补进精写库，保证每道题都有精写解析，不会掉到兜底话术上去。
  (function patchReciteExplain() {
    var D = window.YW_EXPLAIN_DETAIL;
    if (!D) return;
    (window.YW_QUESTIONS || []).forEach(function (q) {
      if (!q.recite || D[q.id] || !q.tip) return;
      D[q.id] = {
        right: q.tip,
        wrong: {},
        point: '按课文内容填空',
        method: q.fill
          ? '先在心里把整句默一遍，再写那个词；写完读一遍，通不通。'
          : '回想这句话在课文里的上下文，别只凭意思猜。',
      };
    });
  })();

  window.YW_QUESTIONS.forEach(function (q) { of(q); });
  window.YWExplain = {
    of: of, brief: brief,
    coach: function (type) { return COACH[type] || COACH.unknown; },
    // 逐项排除：优先讲孩子真正选的那一选项
    whyWrong: function (q, selected) {
      var e = of(q), o = q.options[selected];
      return (o !== undefined && e.wrongWhy[o]) || KITS.general.wrong(o || '这一项', q);
    },
  };
})();
