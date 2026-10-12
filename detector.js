/* 去 AI 味检测引擎（网页版）—— 逐行对齐 src/detector.py
 *
 * 与 CLI 的差异仅限实现语言，判据完全一致：
 *   - 分句/对话区间/词库/金句/抽象主语/排比/指标/评分 全部照搬
 *   - 舍入用 pyRound()（等价 Python round 的十进制正确舍入，非银行家舍入的常见误用）
 *   - 标准差用精确整数式 (n*Σx² - (Σx)²)/n²，避免逐项浮点累加漂移
 * 任何改动都必须让 web/parity_test.js 继续全绿。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DEAI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SENT_END = '。！？!?…；;';
  var CLAUSE_SEP = '，,；;、';
  var ABSTRACT_VERBS = ['要求', '呼唤', '推动', '改变', '证明', '教会', '见证', '给出',
    '做出', '赋予', '抛弃', '带走', '改变', '洗牌', '选择', '需要',
    '会', '能', '将', '正在', '从不', '不会', '注定'];
  var DIALOG_QUOTES = [['“', '”'], ['「', '」'], ['『', '』'], ['"', '"']];
  var STRIP_PRONOUNS = ['我们', '他们', '她们', '大家', '它们', '他', '她', '我', '你', '它'];

  /** 按码点切前 n 个字符（等价 Python 的 s[:n]）。 */
  function cpSlice(s, n) {
    var arr = Array.from(s);
    return arr.slice(0, n).join('');
  }

  /** 去空白后的字符数（等价 Python len(re.sub(r"\s", "", s))）。 */
  function charCount(s) {
    return s.replace(/\s/g, '').length;
  }

  /** 等价 Python round(x, nd) 的十进制正确舍入。
   *  nd 位上的精确平局需要 x 的分母含因子 5，二进制 double 无法表示，故不存在平局，
   *  toFixed 的「远离零」规则与 Python 结果一致。 */
  function pyRound(x, nd) {
    if (!isFinite(x)) return x;
    return Number(x.toFixed(nd));
  }

  /** 等价 statistics.pstdev：用精确整数式避免浮点累加误差。 */
  function pstdev(nums) {
    var n = nums.length;
    if (n < 2) return 0;
    var sum = 0, sumSq = 0;
    for (var i = 0; i < n; i++) { sum += nums[i]; sumSq += nums[i] * nums[i]; }
    var num = n * sumSq - sum * sum;
    if (num < 0) num = 0;
    return Math.sqrt(num / (n * n));
  }

  /** 等价 statistics.mean。 */
  function mean(nums) {
    if (!nums.length) return 0;
    var s = 0;
    for (var i = 0; i < nums.length; i++) s += nums[i];
    return s / nums.length;
  }

  /** 对话（引号内）区间 [(start, end)]。 */
  function extractDialogueSpans(text) {
    var spans = [];
    for (var q = 0; q < DIALOG_QUOTES.length; q++) {
      var oq = DIALOG_QUOTES[q][0], cq = DIALOG_QUOTES[q][1];
      var i = 0;
      for (;;) {
        var oi = text.indexOf(oq, i);
        if (oi < 0) break;
        var ci = text.indexOf(cq, oi + 1);
        if (ci < 0) break;
        spans.push([oi, ci]);
        i = ci + 1;
      }
    }
    return spans;
  }

  function inSpans(pos, spans) {
    for (var i = 0; i < spans.length; i++) {
      if (spans[i][0] <= pos && pos <= spans[i][1]) return true;
    }
    return false;
  }

  /** 按终结符分句（保留原句，去首尾空白）。 */
  function splitSentences(text) {
    var out = [], buf = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      buf += ch;
      if (SENT_END.indexOf(ch) >= 0) {
        var s = buf.trim();
        if (s) out.push(s);
        buf = '';
      }
    }
    if (buf) {
      var tail = buf.trim();
      if (tail) out.push(tail);
    }
    return out;
  }

  /** 按空行分段落。 */
  function splitParagraphs(text) {
    return text.split(/\n\s*\n/).filter(function (p) { return p.trim(); });
  }

  function Finding(category, severity, text, position, suggestion) {
    this.category = category;
    this.severity = severity;
    this.text = text;
    this.position = position;
    this.suggestion = suggestion || '';
  }

  /** 词库匹配。P2 级口语化词与连接词在对话内豁免。 */
  function detectWords(text, rules, order, dialogueSpans) {
    var findings = [];
    for (var k = 0; k < order.length; k++) {
      var label = order[k];
      var d = rules[label];
      if (!d) continue;
      var severity = d.severity;
      for (var e = 0; e < d.entries.length; e++) {
        var word = d.entries[e][0], sugg = d.entries[e][1];
        var start = 0;
        for (;;) {
          var idx = text.indexOf(word, start);
          if (idx < 0) break;
          if (dialogueSpans && inSpans(idx, dialogueSpans) &&
              (severity === 'P2' || label === '连接词')) {
            start = idx + word.length;
            continue;
          }
          findings.push(new Finding(label, severity, word, idx, sugg));
          start = idx + word.length;
        }
      }
    }
    return findings;
  }

  /** 金句模板，按句匹配。 */
  function detectGolden(text, patterns) {
    var findings = [];
    var sentences = splitSentences(text);
    var offset = 0;
    for (var i = 0; i < sentences.length; i++) {
      var s = sentences[i];
      var localIdx = text.indexOf(s, offset);
      var absIdx = localIdx >= 0 ? localIdx : offset;
      for (var p = 0; p < patterns.length; p++) {
        try {
          if (new RegExp(patterns[p]).test(s)) {
            findings.push(new Finding('金句模板', 'P1', s.trim(), absIdx,
              '删或落回具体事件/动作'));
            break;
          }
        } catch (err) { /* 单条正则非法时跳过，与 Python re.error 分支一致 */ }
      }
      offset = absIdx + s.length;
    }
    return findings;
  }

  /** 抽象主语：句首出现主语词 + 紧跟动词。 */
  function detectAbstractSubject(text, subjects) {
    var findings = [];
    var sentences = splitSentences(text);
    var offset = 0;
    for (var i = 0; i < sentences.length; i++) {
      var s = sentences[i];
      var localIdx = text.indexOf(s, offset);
      var absIdx = localIdx >= 0 ? localIdx : offset;
      var stripped = s.trim();
      for (var j = 0; j < subjects.length; j++) {
        var subj = subjects[j];
        if (stripped.indexOf(subj) === 0) {
          var rest = stripped.slice(subj.length);
          var head = /^(是|正在|将|会|能|从不|不会|注定|要|在)/.test(rest);
          var startsVerb = ABSTRACT_VERBS.some(function (v) { return rest.indexOf(v) === 0; });
          if (head || startsVerb) {
            findings.push(new Finding('抽象主语', 'P1', stripped, absIdx,
              '换成具体的人/数字/场景'));
            break;
          }
        }
      }
      offset = absIdx + s.length;
    }
    return findings;
  }

  /** 分句指纹集合：前 2 字 + 去人称主语后的前 2 字。 */
  function fingerprints(clause) {
    var fps = [cpSlice(clause, 2)];
    for (var i = 0; i < STRIP_PRONOUNS.length; i++) {
      var pron = STRIP_PRONOUNS[i];
      if (clause.indexOf(pron) === 0) {
        var rest = clause.slice(pron.length);
        if (rest) fps.push(cpSlice(rest, 2));
        break;
      }
    }
    return fps;
  }

  function intersect(a, b) {
    return a.filter(function (x) { return b.indexOf(x) >= 0; });
  }

  /** 排比结构：连续 >=3 个分句共享前缀 + 长度相近。 */
  function detectParallel(text) {
    var findings = [];
    var sentences = splitSentences(text);
    var offset = 0;
    for (var i = 0; i < sentences.length; i++) {
      var s = sentences[i];
      var localIdx = text.indexOf(s, offset);
      var absIdx = localIdx >= 0 ? localIdx : offset;
      var clauses = s.split(new RegExp('[' + CLAUSE_SEP + ']'))
        .map(function (c) { return c.trim(); })
        .filter(function (c) { return c; });

      if (clauses.length >= 3) {
        var run = [clauses[0]];
        var runFps = fingerprints(clauses[0]);
        for (var c = 1; c < clauses.length; c++) {
          var cl = clauses[c];
          if (intersect(fingerprints(cl), runFps).length > 0) {
            run.push(cl);
            runFps = intersect(runFps, fingerprints(cl));
          } else {
            if (run.length >= 3) {
              var lengths = run.map(charCount);
              if (Math.max.apply(null, lengths) - Math.min.apply(null, lengths) <= 6) {
                findings.push(new Finding('排比结构', 'P1', run.join(' / '), absIdx,
                  '三选一：砍到最强一句/破句式/最后一项展开成场景'));
              }
            }
            run = [cl];
            runFps = fingerprints(cl);
          }
        }
        if (run.length >= 3) {
          var lens2 = run.map(charCount);
          if (Math.max.apply(null, lens2) - Math.min.apply(null, lens2) <= 6) {
            findings.push(new Finding('排比结构', 'P1', run.join(' / '), absIdx,
              '三选一：砍/破/拉'));
          }
        }
      }
      offset = absIdx + s.length;
    }
    return findings;
  }

  /** 统计指标。 */
  function computeMetrics(text) {
    var sentences = splitSentences(text);
    var lens = sentences.map(charCount);
    var paras = splitParagraphs(text);
    var plens = paras.map(charCount);
    var total = charCount(text) || 1;
    var m = {};

    m.sentence_count = lens.length;
    m.paragraph_count = plens.length;
    m.sentence_cv = lens.length >= 2
      ? pyRound(pstdev(lens) / (mean(lens) || 1), 3) : 0;
    m.para_cv = plens.length >= 2
      ? pyRound(pstdev(plens) / (mean(plens) || 1), 3) : 0;
    m.avg_sentence_len = lens.length ? pyRound(mean(lens), 1) : 0;

    m.dash_per_1k = pyRound(countOccur(text, '——') * 1000 / total, 1);
    m.ellipsis_per_1k = pyRound(countOccur(text, '……') * 1000 / total, 1);
    m.exclaim_per_1k = pyRound(countOccur(text, '！') * 1000 / total, 1);
    m.question_per_1k = pyRound(countOccur(text, '？') * 1000 / total, 1);

    var runs = text.match(/[\u4e00-\u9fa5]{8,}/g) || [];
    var maxRun = 0;
    for (var i = 0; i < runs.length; i++) {
      var len = Array.from(runs[i]).length;
      if (len > maxRun) maxRun = len;
    }
    m.max_hanzi_run = maxRun;
    m.overlong_run_20plus = runs.filter(function (r) {
      return Array.from(r).length >= 20;
    }).length;

    m.period_per_100 = pyRound(countOccur(text, '。') * 100 / total, 1);
    return m;
  }

  /** 非重叠出现次数（等价 Python str.count）。 */
  function countOccur(text, sub) {
    if (!sub) return 0;
    var n = 0, i = 0;
    for (;;) {
      var idx = text.indexOf(sub, i);
      if (idx < 0) break;
      n++;
      i = idx + sub.length;
    }
    return n;
  }

  /** 加权评分 0-100，越高 AI 味越重。 */
  function computeScore(findings, metrics) {
    var score = 0;
    var bySev = { P0: 0, P1: 0, P2: 0 };
    for (var i = 0; i < findings.length; i++) {
      var s = findings[i].severity;
      bySev[s] = (bySev[s] || 0) + 1;
    }
    score += (bySev.P0 || 0) * 3.0;
    score += (bySev.P1 || 0) * 1.5;
    score += (bySev.P2 || 0) * 0.8;

    if (metrics.sentence_cv < 0.35 && metrics.sentence_count >= 5) score += 8;
    if (metrics.para_cv < 0.4 && metrics.paragraph_count >= 3) score += 6;
    if (metrics.dash_per_1k > 2) score += 5;
    if (metrics.dash_per_1k > 5) score += 5;
    if (metrics.ellipsis_per_1k > 5) score += 4;
    if (metrics.overlong_run_20plus > 8) score += 3;

    return pyRound(Math.min(100, score), 1);
  }

  function verdictOf(score) {
    if (score < 20) return '人味较足';
    if (score < 40) return '轻度 AI 味';
    if (score < 60) return '明显 AI 味';
    return '重度 AI 味';
  }

  /** 主入口：返回 {findings, metrics, score, verdict}。 */
  function scan(text, data) {
    var dialogueSpans = extractDialogueSpans(text);
    var findings = [];
    findings = findings.concat(
      detectWords(text, data.wordRules, data.categoryOrder, dialogueSpans));
    findings = findings.concat(detectGolden(text, data.goldenPatterns));
    findings = findings.concat(detectAbstractSubject(text, data.abstractSubjects));
    findings = findings.concat(detectParallel(text));

    findings.sort(function (a, b) { return a.position - b.position; });

    var metrics = computeMetrics(text);
    var score = computeScore(findings, metrics);
    return { findings: findings, metrics: metrics, score: score, verdict: verdictOf(score) };
  }

  return {
    scan: scan,
    splitSentences: splitSentences,
    extractDialogueSpans: extractDialogueSpans,
    computeMetrics: computeMetrics,
    computeScore: computeScore,
    pyRound: pyRound,
    pstdev: pstdev
  };
});
