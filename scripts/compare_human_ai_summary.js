#!/usr/bin/env node
/**
 * compare_human_ai_summary.js - human vs AI 백업 파일 비교 요약 생성
 *
 * 입력: outputs/fun_scores_human.json, fun_scores_ai.json, top_matches_human.json, top_matches_ai.json
 * 출력: outputs/human_vs_ai_summary.json, human_vs_ai_summary.md
 *
 * Usage: node scripts/compare_human_ai_summary.js
 */
const fs = require('fs');
const path = require('path');

const CWD = process.cwd();
const OUTPUTS_DIR = path.join(CWD, 'outputs');
const SMALL_SAMPLE_THRESHOLD = 5;   // Human, AI total
const RUSH_CAUTIOUS_THRESHOLD = 3; // Rush, Cautious per-type

const INPUT_FILES = {
  funScoresHuman: path.join(OUTPUTS_DIR, 'fun_scores_human.json'),
  funScoresAi: path.join(OUTPUTS_DIR, 'fun_scores_ai.json'),
  topMatchesHuman: path.join(OUTPUTS_DIR, 'top_matches_human.json'),
  topMatchesAi: path.join(OUTPUTS_DIR, 'top_matches_ai.json')
};

const OUTPUT_JSON = path.join(OUTPUTS_DIR, 'human_vs_ai_summary.json');
const OUTPUT_MD = path.join(OUTPUTS_DIR, 'human_vs_ai_summary.md');

function round(n) {
  return n != null && !Number.isNaN(n) ? Math.round(n * 100) / 100 : null;
}

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function computeStats(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    return { count: 0, avgScore: null, avgTurns: null, avgImmersion: null, topMatchId: null, topMatchScore: null };
  }
  const scores = arr.map((x) => x?.score).filter((s) => s != null && !Number.isNaN(s));
  const turns = arr.map((x) => x?.turns).filter((t) => t != null && !Number.isNaN(t));
  const immersions = arr.map((x) => x?.immersion_score ?? x?.immersionScore).filter((i) => i != null && !Number.isNaN(i));
  const sorted = [...arr].sort((a, b) => (b?.score ?? -Infinity) - (a?.score ?? -Infinity));
  const top = sorted[0];
  const topMatchId = top?.match_id ?? top?.matchId ?? null;
  const topMatchScore = top?.score != null ? round(top.score) : null;
  return {
    count: arr.length,
    avgScore: scores.length > 0 ? round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    avgTurns: turns.length > 0 ? round(turns.reduce((a, b) => a + b, 0) / turns.length) : null,
    avgImmersion: immersions.length > 0 ? round(immersions.reduce((a, b) => a + b, 0) / immersions.length) : null,
    topMatchId,
    topMatchScore
  };
}

function getAgentType(item) {
  const entries = item?.entries;
  if (Array.isArray(entries) && entries[0]) {
    const t = entries[0].agentType ?? entries[0].agent_id ?? null;
    if (t) return String(t).replace(/^Agent_?/i, '').trim();
  }
  return null;
}

function computeAiByType(funScoresAi, topMatchesAi) {
  const byType = { Rush: [], Cautious: [] };
  const midToType = new Map();
  const midToEntry = new Map();
  if (Array.isArray(topMatchesAi)) {
    for (const m of topMatchesAi) {
      const mid = m?.match_id ?? m?.matchId;
      const t = getAgentType(m);
      const entry = Array.isArray(m?.entries) && m.entries[0] ? m.entries[0] : null;
      if (mid && t) {
        midToType.set(mid, String(t).toLowerCase());
        if (entry) midToEntry.set(mid, entry);
      }
    }
  }
  if (!Array.isArray(funScoresAi)) return { byType, midToEntry };
  const scoreById = new Map();
  for (const s of funScoresAi) {
    const mid = s?.match_id ?? s?.matchId;
    if (mid) scoreById.set(mid, s);
  }
  for (const [mid, type] of midToType) {
    const s = scoreById.get(mid);
    if (!s) continue;
    const enriched = { ...s, _entry: midToEntry.get(mid) };
    if (type === 'rush') byType.Rush.push(enriched);
    else if (type === 'cautious') byType.Cautious.push(enriched);
  }
  return { byType, midToEntry };
}

function winRate(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const wins = arr.filter((x) => String(x?.winner ?? x?.outcome ?? '').toLowerCase() === 'victory').length;
  return round((wins / arr.length) * 100);
}

function avgAccuseTurn(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const vals = arr.map((x) => x?._entry?.accuseTurn ?? x?.accuseTurn).filter((t) => t != null && !Number.isNaN(t));
  if (vals.length === 0) return null;
  return round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function generateKeyTakeaways(summary) {
  const h = summary.human;
  const a = summary.ai;
  const numeric = [];
  const interpretive = [];
  const hm = h?.total_matches ?? h?.totalMatches ?? 0;
  const am = a?.total_matches ?? a?.totalMatches ?? 0;
  const hasHuman = hm > 0;
  const hasAi = am > 0;

  if (hasHuman && hasAi) {
    const hS = h?.avg_score ?? h?.avgScore;
    const aS = a?.avg_score ?? a?.avgScore;
    const hT = h?.avg_turns ?? h?.avgTurns;
    const aT = a?.avg_turns ?? a?.avgTurns;
    const hImm = h?.avg_immersion ?? h?.avgImmersion;
    if (hS != null && aS != null && Math.abs(hS - aS) >= 0.5) {
      numeric.push(`${hS > aS ? 'Human' : 'AI'} avg ${round(Math.max(hS, aS))} vs ${round(Math.min(hS, aS))} score.`);
    }
    if (hT != null && aT != null && Math.abs(hT - aT) >= 1) {
      numeric.push(`${hT > aT ? 'Human' : 'AI'} games ran longer (${round(Math.max(hT, aT))} vs ${round(Math.min(hT, aT))} turns).`);
    }
    if (hImm != null && hImm > 0) {
      interpretive.push('Human logs preserve richer immersion (detailed format); AI uses arena-summary format with no immersion metric.');
    }
    if (hS != null && aS != null && Math.abs(hS - aS) >= 0.5 && !(hS > aS && hImm != null && hImm > 0)) {
      interpretive.push(hS > aS ? 'Human scored higher on average.' : 'AI scored higher on average.');
    } else if (hS != null && aS != null && hS > aS && hImm != null && hImm > 0) {
      interpretive.push('Higher human score partly reflects immersion-rich logs capturing more context.');
    }
  }

  const abt = summary.ai_by_agent_type;
  const rc = abt?.Rush?.matches ?? abt?.Rush?.count ?? 0;
  const cc = abt?.Cautious?.matches ?? abt?.Cautious?.count ?? 0;
  if (rc > 0 && cc > 0) {
    const rush = abt.Rush;
    const caut = abt.Cautious;
    const rT = rush?.avg_turns ?? rush?.avgTurns;
    const cT = caut?.avg_turns ?? caut?.avgTurns;
    if (rT != null && cT != null && rT < cT) {
      interpretive.push('Rush closes faster; Cautious tends to deliberate longer before accusing.');
    }
  }

  const combined = [...numeric.slice(0, 2), ...interpretive.slice(0, 2)];
  if (combined.length === 0) {
    return hasHuman || hasAi ? ['Run more matches for meaningful comparison.'] : ['Insufficient data.'];
  }
  return combined.slice(0, 4);
}

function generateCaveats(summary) {
  const caveats = [];
  const h = summary.human;
  const a = summary.ai;
  const hm = h?.total_matches ?? h?.totalMatches ?? 0;
  const am = a?.total_matches ?? a?.totalMatches ?? 0;
  const plural = (n) => (n === 1 ? 'match' : 'matches');
  if (hm > 0 && hm < SMALL_SAMPLE_THRESHOLD) {
    caveats.push(`Human: ${hm} ${plural(hm)} — sample size may be too small for reliable conclusions.`);
  }
  if (am > 0 && am < SMALL_SAMPLE_THRESHOLD) {
    caveats.push(`AI: ${am} ${plural(am)} — sample size may be too small for reliable conclusions.`);
  }
  const abt = summary.ai_by_agent_type;
  const rc = abt?.Rush?.matches ?? abt?.Rush?.count ?? 0;
  const cc = abt?.Cautious?.matches ?? abt?.Cautious?.count ?? 0;
  if (rc > 0 && rc < RUSH_CAUTIOUS_THRESHOLD) {
    caveats.push(`Rush: ${rc} ${plural(rc)} — very small sample.`);
  }
  if (cc > 0 && cc < RUSH_CAUTIOUS_THRESHOLD) {
    caveats.push(`Cautious: ${cc} ${plural(cc)} — very small sample.`);
  }
  if (summary.missing_files?.length > 0) {
    caveats.push(`Missing: ${summary.missing_files.join(', ')}.`);
  }
  return caveats;
}

function hasEarlyCaveats(caveats) {
  return caveats.some((c) =>
    /AI:.*\d+ match|Rush:.*\d+ match|Cautious:.*\d+ match/.test(c)
  );
}

function generateInterpretation(summary) {
  const paras = [];
  const h = summary.human;
  const a = summary.ai;
  const hm = h?.total_matches ?? h?.totalMatches ?? 0;
  const am = a?.total_matches ?? a?.totalMatches ?? 0;
  const hasHuman = hm > 0;
  const hasAi = am > 0;

  if (!hasHuman && !hasAi) return 'Insufficient data. Run pipeline with --tag human and --tag ai first.';

  const hS = h?.avg_score ?? h?.avgScore;
  const aS = a?.avg_score ?? a?.avgScore;
  const hT = h?.avg_turns ?? h?.avgTurns;
  const aT = a?.avg_turns ?? a?.avgTurns;
  const hImm = h?.avg_immersion ?? h?.avgImmersion;

  if (hasHuman && hasAi) {
    if (hS != null && aS != null && hS > aS && Math.abs(hS - aS) > 0.5) {
      if (hImm != null && hImm > 0) {
        paras.push('Human scored higher partly because detailed logs preserve richer immersion and context; AI arena summaries capture less texture.');
      } else {
        paras.push('Human scored higher on average; human logs use detailed format while AI uses arena-summary.');
      }
    } else if (hS != null && aS != null && aS > hS && Math.abs(hS - aS) > 0.5) {
      paras.push('AI scored higher in this sample; note that AI logs use summary format with fewer scoring dimensions.');
    }
    if (hT != null && aT != null && aT < hT && Math.abs(hT - aT) > 1) {
      paras.push('AI matches resolved faster (fewer turns), but arena summaries still capture less texture than detailed human logs.');
    } else if (hT != null && aT != null && hT < aT && Math.abs(hT - aT) > 1) {
      paras.push('Human matches finished in fewer turns on average.');
    }
  }

  const abt = summary.ai_by_agent_type;
  if (abt?.Rush && abt?.Cautious) {
    const rush = abt.Rush;
    const caut = abt.Cautious;
    const rT = rush?.avg_turns ?? rush?.avgTurns;
    const cT = caut?.avg_turns ?? caut?.avgTurns;
    if (rT != null && cT != null && rT < cT) {
      paras.push('Rush closes games sooner; Cautious tends to deliberate longer before accusing.');
    }
  }

  if (paras.length === 0) return 'Limited data; run more matches for clearer patterns.';
  return paras.join('\n\n');
}

function main() {
  const missing = [];
  console.log('[compare] reading human backup...');
  const funScoresHuman = loadJson(INPUT_FILES.funScoresHuman);
  if (!funScoresHuman) missing.push('fun_scores_human.json');

  console.log('[compare] reading ai backup...');
  const funScoresAi = loadJson(INPUT_FILES.funScoresAi);
  if (!funScoresAi) missing.push('fun_scores_ai.json');

  const topMatchesHuman = loadJson(INPUT_FILES.topMatchesHuman);
  if (!topMatchesHuman) missing.push('top_matches_human.json');

  const topMatchesAi = loadJson(INPUT_FILES.topMatchesAi);
  if (!topMatchesAi) missing.push('top_matches_ai.json');

  const humanArr = Array.isArray(funScoresHuman) ? funScoresHuman : [];
  const aiArr = Array.isArray(funScoresAi) ? funScoresAi : [];

  if (humanArr.length === 0 && aiArr.length === 0) {
    console.error('[compare] No data. Both human and AI backups are missing or empty.');
    console.error('[compare] Run pipeline with --tag human and --tag ai first.');
    process.exit(1);
  }

  if (missing.length > 0) {
    console.warn('[compare] Missing files:', missing.join(', '));
    console.warn('[compare] Output will be partial. Run pipeline with --tag human and --tag ai for full comparison.');
  }

  const humanStats = computeStats(humanArr);
  const aiStats = computeStats(aiArr);
  const { byType: aiByTypeRaw, midToEntry } = computeAiByType(funScoresAi, topMatchesAi);

  const rushStats = computeStats(aiByTypeRaw.Rush);
  const cautiousStats = computeStats(aiByTypeRaw.Cautious);
  const rushWinRate = winRate(aiByTypeRaw.Rush);
  const cautiousWinRate = winRate(aiByTypeRaw.Cautious);
  const rushAvgAccuseTurn = avgAccuseTurn(aiByTypeRaw.Rush);
  const cautiousAvgAccuseTurn = avgAccuseTurn(aiByTypeRaw.Cautious);

  const topHumanMatchId = humanStats.topMatchId ?? (Array.isArray(topMatchesHuman) && topMatchesHuman[0] ? topMatchesHuman[0].match_id ?? topMatchesHuman[0].matchId : null);
  const topAiMatchId = aiStats.topMatchId ?? (Array.isArray(topMatchesAi) && topMatchesAi[0] ? topMatchesAi[0].match_id ?? topMatchesAi[0].matchId : null);
  const topHumanMatchScore = humanStats.topMatchScore ?? (Array.isArray(topMatchesHuman) && topMatchesHuman[0] ? round(topMatchesHuman[0].score) : null);
  const topAiMatchScore = aiStats.topMatchScore ?? (Array.isArray(topMatchesAi) && topMatchesAi[0] ? round(topMatchesAi[0].score) : null);

  const overview = {
    generated_at: new Date().toISOString(),
    input_sources: {
      human: humanArr.length > 0 ? 'fun_scores_human.json, top_matches_human.json' : null,
      ai: aiArr.length > 0 ? 'fun_scores_ai.json, top_matches_ai.json' : null
    },
    missing_files: missing.length > 0 ? missing : undefined
  };

  const human = {
    total_matches: humanStats.count,
    avg_score: humanStats.avgScore,
    avg_turns: humanStats.avgTurns,
    avg_immersion: humanStats.avgImmersion,
    top_match_id: topHumanMatchId,
    top_match_score: topHumanMatchScore
  };

  const ai = {
    total_matches: aiStats.count,
    avg_score: aiStats.avgScore,
    avg_turns: aiStats.avgTurns,
    top_match_id: topAiMatchId,
    top_match_score: topAiMatchScore
  };

  const ai_by_agent_type = rushStats.count > 0 || cautiousStats.count > 0 ? {
    Rush: rushStats.count > 0 ? {
      matches: rushStats.count,
      avg_score: rushStats.avgScore,
      avg_turns: rushStats.avgTurns,
      win_rate: rushWinRate,
      avg_accuse_turn: rushAvgAccuseTurn
    } : null,
    Cautious: cautiousStats.count > 0 ? {
      matches: cautiousStats.count,
      avg_score: cautiousStats.avgScore,
      avg_turns: cautiousStats.avgTurns,
      win_rate: cautiousWinRate,
      avg_accuse_turn: cautiousAvgAccuseTurn
    } : null
  } : null;

  const summaryForTakeaways = {
    human: {
      total_matches: humanStats.count,
      avg_score: humanStats.avgScore,
      avg_turns: humanStats.avgTurns,
      avg_immersion: humanStats.avgImmersion
    },
    ai: {
      total_matches: aiStats.count,
      avg_score: aiStats.avgScore,
      avg_turns: aiStats.avgTurns
    },
    ai_by_agent_type: ai_by_agent_type ? {
      Rush: rushStats.count > 0 ? { matches: rushStats.count, avg_turns: rushStats.avgTurns, win_rate: rushWinRate } : null,
      Cautious: cautiousStats.count > 0 ? { matches: cautiousStats.count, avg_turns: cautiousStats.avgTurns, win_rate: cautiousWinRate } : null
    } : null
  };

  const keyTakeaways = generateKeyTakeaways(summaryForTakeaways);
  const caveats = generateCaveats({
    human,
    ai,
    ai_by_agent_type: ai_by_agent_type,
    missing_files: missing
  });
  const interpretation = generateInterpretation({
    human,
    ai,
    ai_by_agent_type: ai_by_agent_type
  });

  const output = {
    overview,
    human,
    ai,
    ai_by_agent_type: ai_by_agent_type ?? undefined,
    key_takeaways: keyTakeaways,
    caveats: caveats.length > 0 ? caveats : undefined,
    interpretation,
    top_matches: {
      human: topHumanMatchId ? { match_id: topHumanMatchId, score: topHumanMatchScore } : null,
      ai: topAiMatchId ? { match_id: topAiMatchId, score: topAiMatchScore } : null
    }
  };

  if (!fs.existsSync(OUTPUTS_DIR)) fs.mkdirSync(OUTPUTS_DIR, { recursive: true });

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 2), 'utf8');
  console.log('[compare] saved', OUTPUT_JSON);

  const ts = new Date().toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
  const showCaveatsEarly = caveats.length > 0 && hasEarlyCaveats(caveats);

  let md = '# Human vs AI Summary\n\n';
  md += `*Generated: ${ts}*`;
  if (overview.input_sources?.human || overview.input_sources?.ai) {
    md += ' · **Input:** ' + [overview.input_sources?.human, overview.input_sources?.ai].filter(Boolean).join(' | ');
  }
  if (overview.missing_files?.length > 0) {
    md += ` · *Missing: ${overview.missing_files.join(', ')}*`;
  }
  md += '\n\n';

  md += '## Key Takeaways\n\n';
  keyTakeaways.forEach((line) => { md += `- ${line}\n`; });
  md += '\n';

  if (showCaveatsEarly) {
    md += '> **⚠ Sample size warning** — ';
    md += caveats.filter((c) => /Human:|AI:|Rush:|Cautious:/.test(c)).join(' ');
    md += '\n\n';
  }

  md += '## Human vs AI\n\n';
  md += '| Metric | Human | AI |\n|--------|-------|-----|\n';
  md += `| Total matches | ${human.total_matches} | ${ai.total_matches} |\n`;
  md += `| Avg score | ${human.avg_score ?? '-'} | ${ai.avg_score ?? '-'} |\n`;
  md += `| Avg turns | ${human.avg_turns ?? '-'} | ${ai.avg_turns ?? '-'} |\n`;
  if (human.avg_immersion != null) {
    md += `| Avg immersion | ${human.avg_immersion} | - |\n`;
  }
  md += `| Top match | ${human.top_match_id ?? '-'} (score: ${human.top_match_score ?? '-'}) | ${ai.top_match_id ?? '-'} (score: ${ai.top_match_score ?? '-'}) |\n\n`;

  if (ai_by_agent_type) {
    md += '## Rush vs Cautious\n\n';
    md += '| Type | Matches | Avg Score | Avg Turns | Win Rate | Avg Accuse Turn |\n|------|---------|-----------|-----------|----------|------------------|\n';
    if (ai_by_agent_type.Rush) {
      const r = ai_by_agent_type.Rush;
      md += `| Rush | ${r.matches} | ${r.avg_score ?? '-'} | ${r.avg_turns ?? '-'} | ${r.win_rate != null ? r.win_rate + '%' : '-'} | ${r.avg_accuse_turn ?? '-'} |\n`;
    }
    if (ai_by_agent_type.Cautious) {
      const c = ai_by_agent_type.Cautious;
      md += `| Cautious | ${c.matches} | ${c.avg_score ?? '-'} | ${c.avg_turns ?? '-'} | ${c.win_rate != null ? c.win_rate + '%' : '-'} | ${c.avg_accuse_turn ?? '-'} |\n`;
    }
    md += '\n';
  }

  md += '## Top Matches\n\n';
  if (output.top_matches.human) {
    md += `- **Human:** \`${output.top_matches.human.match_id}\` (score: ${output.top_matches.human.score ?? '-'})\n`;
  }
  if (output.top_matches.ai) {
    md += `- **AI:** \`${output.top_matches.ai.match_id}\` (score: ${output.top_matches.ai.score ?? '-'})\n`;
  }
  if (!output.top_matches.human && !output.top_matches.ai) {
    md += '*No top match data.*\n';
  }
  md += '\n';

  md += '## Interpretation\n\n';
  md += interpretation + '\n\n';

  if (caveats.length > 0) {
    const sampleCaveats = caveats.filter((c) => /Human:|AI:|Rush:|Cautious:/.test(c));
    const otherCaveats = caveats.filter((c) => !/Human:|AI:|Rush:|Cautious:/.test(c));
    const isFullyDuplicated = showCaveatsEarly && sampleCaveats.length === caveats.length;
    md += '## Caveats\n\n';
    if (isFullyDuplicated) {
      md += '*See sample size warning above.*\n';
    } else if (showCaveatsEarly && otherCaveats.length > 0) {
      md += '*See sample size warning above.*\n';
      otherCaveats.forEach((c) => { md += `- ${c}\n`; });
    } else {
      caveats.forEach((c) => { md += `- ${c}\n`; });
    }
  }

  fs.writeFileSync(OUTPUT_MD, md, 'utf8');
  console.log('[compare] saved', OUTPUT_MD);
}

main();
