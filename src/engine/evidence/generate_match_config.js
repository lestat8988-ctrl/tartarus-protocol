/**
 * generate_match_config.js - Seed-based deterministic match evidence config
 * Incident Pack 스키마: commands=time/sync/nav, hint_command, primary.command, evidence.sync|nav|time
 */
const {
  getPackById, CREW, TIME_POOL,
  INTERROGATE_CREW_BLOCKS, SYNC_CHANNEL_LINES, CCTV_CHANNEL_LINES,
  NAV_CHANNEL_LINES, ENGINE_CHANNEL_LINES, TIME_CHANNEL_LINES
} = require('./incident_packs');

// Interrogate/CCTV/Engine → sync/nav/time // PATCH
const CMD_TO_TERMINAL = { Interrogate: 'sync', CCTV: 'nav', Engine: 'time' };

function seedToState(seed) {
  let h = 0;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function mulberry32Next(state) {
  let t = (state + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = (t ^ (t >>> 14)) >>> 0;
  const newState = (state + 0x6d2b79f5) >>> 0;
  return { value, state: newState };
}

function pickIndex(length, rng) {
  const { value, state } = mulberry32Next(rng);
  return { idx: value % length, state };
}

const UPPER_TO_PASCAL = { NAVIGATOR: 'Navigator', ENGINEER: 'Engineer', DOCTOR: 'Doctor', PILOT: 'Pilot' };
function toPascalRole(r) {
  const u = String(r || '').trim().toUpperCase().replace(/\s+/g, '').replace(/_/g, '');
  return UPPER_TO_PASCAL[u] || CREW.find((c) => c.toUpperCase() === u) || 'Engineer';
}

function generateMatchConfig({ seed, packId, impostorRole }) {
  const pack = getPackById(packId);
  const impostorPascal = toPascalRole(impostorRole);
  let rng = seedToState(seed + ':' + packId + ':' + impostorRole);

  const nonImpostors = CREW.filter((r) => r !== impostorPascal);

  const { idx: primaryCmdIdx, state: r0 } = pickIndex(pack.commands.length, rng);
  rng = r0;
  const primaryCommandLegacy = pack.commands[primaryCmdIdx];
  const primaryCommand = CMD_TO_TERMINAL[primaryCommandLegacy] || primaryCommandLegacy; // PATCH: sync|time|nav
  const rawPrimary = pack.primaryByRole[impostorPascal];
  const subCmd = (s) => String(s || '').replace(/%CMD%/g, primaryCommand);
  const defaultTime = '02:00';
  const fallbackLines = [
    `[SYSTEM] Access log: ${impostorPascal} — unauthorized ${primaryCommand} query at ${defaultTime}`,
    `[SYSTEM] Checksum mismatch on ${primaryCommand} channel — source: ${impostorPascal}`
  ];
  let lines, keyEvidence, truePool, redPool;
  if (rawPrimary && Array.isArray(rawPrimary.trueEvidence) && Array.isArray(rawPrimary.redHerringEvidence)) {
    const times = TIME_POOL || ['02:47'];
    const { idx: redRoleIdx, state: rRR } = pickIndex(nonImpostors.length, rng);
    rng = rRR;
    const redRole = nonImpostors[redRoleIdx];
    truePool = rawPrimary.trueEvidence.map((tpl, i) => {
      const t = times[i % times.length];
      return String(tpl).replace(/%CMD%/g, primaryCommand).replace(/%TIME%/g, t).replace(/%ROLE%/g, impostorPascal);
    });
    redPool = rawPrimary.redHerringEvidence.map((tpl, i) => {
      const t = times[(i + 2) % times.length];
      return String(tpl).replace(/%CMD%/g, primaryCommand).replace(/%TIME%/g, t).replace(/%ROLE%/g, redRole);
    });
    const { idx: trueIdx, state: rT } = pickIndex(truePool.length, rng);
    rng = rT;
    const { idx: redIdx, state: rR } = pickIndex(redPool.length, rng);
    rng = rR;
    const { idx: orderIdx, state: rOrd } = pickIndex(2, rng);
    rng = rOrd;
    const trueLine = truePool[trueIdx];
    const redLine = redPool[redIdx];
    lines = orderIdx === 0 ? [trueLine, redLine] : [redLine, trueLine];
    keyEvidence = [trueLine];
  } else if (rawPrimary && typeof rawPrimary === 'object' && Array.isArray(rawPrimary.lines) && rawPrimary.lines.length >= 2) {
    lines = rawPrimary.lines.map(subCmd);
    keyEvidence = Array.isArray(rawPrimary.keyEvidence) && rawPrimary.keyEvidence.length >= 2 ? rawPrimary.keyEvidence.map(subCmd) : lines;
    truePool = [lines[0]];
    redPool = lines.length > 1 ? [lines[1]] : [lines[0]];
  } else {
    lines = fallbackLines;
    keyEvidence = fallbackLines;
    truePool = [fallbackLines[0]];
    redPool = [fallbackLines[1]];
  }
  const primary = {
    command: primaryCommand,
    lines,
    keyEvidence,
    text: lines.join('\n'),
    truePool: truePool || [lines[0]],
    redPool: redPool || [lines[1] || lines[0]]
  };

  const times = TIME_POOL || ['02:47'];

  // 채널별 lines 배열 생성 (8~10개, 템플릿+시간 다양화)
  function buildChannelLines(templates, baseRng, timeOffset) {
    const arr = templates || [];
    if (arr.length === 0) return { lines: ['[SYSTEM] No data.'], state: baseRng };
    const count = Math.min(10, Math.max(8, arr.length));
    const out = [];
    let s = baseRng;
    const seen = new Set();
    for (let i = 0; i < count; i++) {
      const { idx: tIdx, state: st } = pickIndex(arr.length, s);
      s = st;
      const { idx: timeIdx, state: st2 } = pickIndex(times.length, s);
      s = st2;
      const t = times[(timeIdx + timeOffset) % times.length];
      const line = String(arr[tIdx]).replace(/%TIME%/g, t);
      if (!seen.has(line)) { seen.add(line); out.push(line); }
      else if (out.length < count) {
        const altIdx = (tIdx + i + 1) % arr.length;
        const altTime = times[(timeIdx + i + timeOffset) % times.length];
        const alt = String(arr[altIdx]).replace(/%TIME%/g, altTime);
        if (!seen.has(alt)) { seen.add(alt); out.push(alt); }
        else out.push(line);
      }
    }
    const lines = out.length > 0 ? out : [String(arr[0]).replace(/%TIME%/g, times[0])];
    return { lines, state: s };
  }

  const { idx: interrogateIdx, state: rI } = pickIndex((INTERROGATE_CREW_BLOCKS || []).length || 1, rng);
  rng = rI;
  const interrogateLine = (INTERROGATE_CREW_BLOCKS && INTERROGATE_CREW_BLOCKS[interrogateIdx % INTERROGATE_CREW_BLOCKS.length]) || '';

  let res = buildChannelLines(SYNC_CHANNEL_LINES, rng, 0);
  const syncLines = res.lines;
  rng = res.state;

  res = buildChannelLines(CCTV_CHANNEL_LINES, rng, 3);
  const cctvLines = res.lines;
  rng = res.state;

  res = buildChannelLines(NAV_CHANNEL_LINES, rng, 5);
  const navLines = res.lines;
  rng = res.state;

  res = buildChannelLines(ENGINE_CHANNEL_LINES, rng, 7);
  const engineLines = res.lines;
  rng = res.state;

  res = buildChannelLines(TIME_CHANNEL_LINES, rng, 11);
  const timeLines = res.lines;
  rng = res.state;

  const { idx: hintIdx, state: r6 } = pickIndex(pack.commands.length, rng);
  const hint_command = CMD_TO_TERMINAL[pack.commands[hintIdx]] || pack.commands[hintIdx];

  const evidenceInterrogate = { type: 'interrogate', text: interrogateLine };
  const evidenceSync = { type: 'sync', lines: syncLines, text: syncLines[0] };
  const evidenceCctv = { type: 'cctv', lines: cctvLines, text: cctvLines[0] };
  const evidenceNav = { type: 'nav', lines: navLines, text: navLines[0] };
  const evidenceEngine = { type: 'engine', lines: engineLines, text: engineLines[0] };
  const evidenceTime = { type: 'time', lines: timeLines, text: timeLines[0] };
  const extrasByTerminal = {};
  for (const [k, v] of Object.entries(pack.extrasByCommand || {})) {
    const t = CMD_TO_TERMINAL[k] || k;
    extrasByTerminal[t] = v;
  }

  return {
    seed,
    packId,
    impostorRole: String(impostorRole || '').toUpperCase().replace(/\s+/g, '_') || 'ENGINEER',
    commands: ['sync', 'time', 'nav'], // PATCH
    primary,
    evidence: {
      interrogate: evidenceInterrogate,
      sync: evidenceSync,
      cctv: evidenceCctv,
      nav: evidenceNav,
      engine: evidenceEngine,
      time: evidenceTime
    },
    hint_command,
    extrasByCommand: extrasByTerminal
  };
}

module.exports = { generateMatchConfig };
