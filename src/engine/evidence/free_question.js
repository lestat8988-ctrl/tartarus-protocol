/**
 * free_question.js V2 - Free-form question response builder
 * 톤: 짧고 차갑게, 존댓말(함장에게 보고) / terse, cold
 */
'use strict';
const FREE_QA_VERSION = 'V2-2026-03-06-line2-intent';

const CREW = ['Navigator', 'Engineer', 'Doctor', 'Pilot'];
const ROLE_KO = { Navigator: '네비게이터', Engineer: '엔지니어', Doctor: '닥터', Pilot: '파일럿' };

function simpleHash(str) {
  let h = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

function detectRoleInQuestion(question) {
  const q = String(question || '').toLowerCase();
  const roles = [['engineer', '엔지니어'], ['doctor', '닥터'], ['navigator', '네비게이터'], ['pilot', '파일럿']];
  for (const [en, ko] of roles) {
    if (q.includes(en) || q.includes(ko)) return en.charAt(0).toUpperCase() + en.slice(1);
  }
  return null;
}

function classifyBranch(question) {
  const q = String(question || '').toLowerCase();
  if (/상태|보고|함선|ship|status|report/.test(q)) return 'status';
  if (/총|탄환|1발|골라|선택|죽여|처형\s*버튼|게임\s*규칙|rules|처형|쏴|어떻게\s*(써|해)|처형하면/i.test(q)) return 'mechanics';
  if (/결정|결정하|결정해야|누굴|accuse|purge/.test(q)) return 'decide';
  // who: clue보다 우선
  if (/범인|임포스터|impostor|host|숙주|정체|수상|의심|suspect|suspicious|누가\s*(수상|의심|범인|임포스터|host)|누가\s*(제일\s*)?(수상|의심)|수상한\s*(사람|놈)|누가.*(수상|의심)|who\s*(is|was)\s*(the|suspicious)|(범인|임포스터|host)\s*(이?누구|가\s*누구)/i.test(q)) return 'who';
  if (/(네비게이터|엔지니어|닥터|파일럿|navigator|engineer|doctor|pilot).*(뭐|모야|뭔데|뭐하는|역할|설명|role|what\s*does|what\'?s?\s*the)/i.test(q)) return 'roleinfo';
  if (/단서|증거|영수증|키워드|nav|time|sync|cctv|engine/.test(q)) return 'clue';
  if (/(왜).*(지켜|감시|녹화|기록|따라다녔|그곳에\s*있었|그곳\s*있었)|why\s*(watch|monitor|follow|record|were\s*you\s*there)/i.test(q)) return 'whywatch';
  // alibi: 위치/시간/알리바이만 (who보다 후순위)
  if (/어디|있었|어딨|위치|언제|봤|알리바이|where|when|location|at\s*that\s*time/i.test(q)) return 'alibi';
  if (/짜증|몰라|답답|빡|fuck/.test(q)) return 'frustration';
  return 'default';
}

function getCurrentKeyword(cfg) {
  const excl = ['interrogate', 'cctv', 'engine'];
  const norm = (s) => String(s || '').trim().toLowerCase();
  if (cfg.hint_command) return norm(cfg.hint_command);
  if (cfg.primary?.command) return norm(cfg.primary.command);
  const cmds = cfg.commands;
  if (Array.isArray(cmds)) {
    const first = cmds.find((c) => !excl.includes(norm(c)));
    if (first) return norm(first);
  }
  return 'nav';
}

function pickAliveRoles(deadCrew) {
  const dead = Array.isArray(deadCrew) ? deadCrew : [];
  return CREW.filter((r) => !dead.includes(r));
}

function pickRolePair(primaryRole, deadCrew, hashKey) {
  const alive = pickAliveRoles(deadCrew);
  if (alive.length === 0) return [CREW[0], CREW[1]];
  const primary = primaryRole && alive.includes(primaryRole) ? primaryRole : alive[simpleHash(hashKey + '|p1') % alive.length];
  const others = alive.filter((r) => r !== primary);
  const second = others.length > 0 ? others[simpleHash(hashKey + '|p2') % others.length] : alive[0];
  return [primary, second];
}

// --- status ---
const STATUS_KO = [
  '네비게이터: 함장, 경로 유지 중. 이상 없습니다.',
  '엔지니어: 함장, 원자로 안정. 냉각 정상.',
  '닥터: 함장, 승무원 생체 신호 정상 범위.',
  '파일럿: 함장, 항법 온라인. 대기 중입니다.',
  '엔지니어: 함장, 시스템 점검 완료. 이상 없습니다.',
  '네비게이터: 함장, 센서 정상. 외부 접촉 없음.',
  '닥터: 함장, 의료 장비 가동 중.',
  '파일럿: 함장, 조종석 준비 완료. 지시 대기.'
];
const STATUS_EN = [
  'Navigator: Captain, course holding. No anomalies.',
  'Engineer: Captain, reactor stable. Cooling nominal.',
  'Doctor: Captain, crew vitals nominal.',
  'Pilot: Captain, nav systems online. Standing by.',
  'Engineer: Captain, systems check complete. No issues.',
  'Navigator: Captain, sensors nominal. No external contact.',
  'Doctor: Captain, medbay operational. Standing by.',
  'Pilot: Captain, cockpit ready. Awaiting orders.'
];

// --- decide ---
const DECIDE_KO = [
  '닥터: 함장, 키워드로 시스템 영수증 확인 후 2줄 증거를 보십시오. 탄환 1발, 대상 1명만 선택하십시오.', // PATCH
  '엔지니어: 함장, 키워드 입력 시 2줄 증거가 나옵니다. 그걸로 1명 좁히십시오. 총알은 1발뿐입니다.', // PATCH
  '네비게이터: 함장, 단서 채널 확인 → 2줄 증거 → 대상 1명 선택. 잘못 고르면 전원 사망합니다.', // PATCH
  '파일럿: 함장, nav/time/sync 키워드로 증거 확인하십시오. 탄환 1발. 한 번만 기회입니다.', // PATCH
  '엔지니어: 함장, 잘못된 대상 1명이면 전원 사망합니다. 키워드로 2줄 증거 확인 후 결정하십시오.', // PATCH
  '닥터: 함장, 추측 말고 증거로 결정하십시오. 2줄 증거로 대상 1명 좁히십시오. 총알 1발입니다.', // PATCH
  '네비게이터: 함장, 결정 증거 채널 확인 후 1명만 선택하십시오. 탄환 1발. 실수는 없습니다.', // PATCH
  '파일럿: 함장, 키워드로 증거 확인 후 대상 1명 고르십시오. 1발만 있습니다. 잘못 고르면 전멸입니다.', // PATCH
  '닥터: 함장, 시스템 영수증 확인하십시오. 2줄 증거로 1명 좁히십시오. 총알은 1발뿐입니다.', // PATCH
  '엔지니어: 함장, 대상 1명. 탄환 1발. 키워드 입력 → 2줄 증거 → 그걸로 결정하십시오.', // PATCH
  '네비게이터: 함장, 키워드로 2줄 증거 확인 후 1명 선택하십시오. 1발만 남았습니다. 실수하면 전멸입니다.', // PATCH
  '파일럿: 함장, 2줄 증거로 대상 1명 좁히십시오. 탄환 1발. 잘못 고르면 전원 사망합니다.', // PATCH
  '닥터: 함장, 탄환 1발, 대상 1명. 키워드로 시스템 영수증 확인 후 결정하십시오.', // PATCH
  '엔지니어: 함장, 1발만 있습니다. 키워드 입력 시 2줄 증거. 그걸로 1명 고르십시오.', // PATCH
  '네비게이터: 함장, 총알 1발. 대상 1명. 2줄 증거 확인 후 선택하십시오. 실수는 용납되지 않습니다.', // PATCH
];
const DECIDE_EN = [
  'Doctor: Captain, verify evidence first. One bullet. One choice.',
  'Engineer: Captain, check system receipt via keyword. Then select target.',
  'Navigator: Captain, clue channel → 2-line evidence → pick one. Wrong choice, we all die.',
  'Pilot: Captain, verify evidence with nav/time/sync keyword. Then decide.',
  'Engineer: Captain, wrong target means we all die. Check evidence via keyword first.',
  'Doctor: Captain, decide by evidence, not guess. Check 2-line evidence after keyword.',
  'Navigator: Captain, verify primary evidence channel. then pick one.',
  'Pilot: Captain, no time. Verify evidence via keyword. Then decide.'
];

// --- clue ---
const CLUE_KO = [
  '엔지니어: 함장, %kw%가 영수증입니다. 2줄로 나옵니다.',
  '네비게이터: 함장, nav·time·sync 중 %kw%가 핵심입니다.',
  '닥터: 함장, %kw% 확인 후 1명 좁히십시오.',
  '파일럿: 함장, %kw% 입력하십시오. 2줄 출력됩니다.',
  '엔지니어: 함장, %kw% 로그가 결정적입니다.',
  '네비게이터: 함장, %kw% 채널 확인하십시오.',
  '닥터: 함장, %kw%가 팩트입니다.',
  '파일럿: 함장, %kw%. 그걸로 좁히십시오.',
  '엔지니어: 함장, %kw% 확인 후 1명 선택하십시오.',
  '네비게이터: 함장, %kw%가 영수증입니다.',
  '닥터: 함장, %kw% 입력 시 2줄 나옵니다.',
  '파일럿: 함장, %kw%가 핵심입니다.',
  '엔지니어: 함장, %kw% 채널. 2줄로 좁히십시오.',
  '네비게이터: 함장, %kw% 확인하십시오.',
  '닥터: 함장, %kw%. 1명 선택하십시오.',
];
const CLUE_EN = [
  'Engineer: Captain, %kw% is the system receipt. Keyword input → 2-line evidence. Use it to narrow target.',
  'Navigator: Captain, check %kw% channel. Access logs are critical. 2 lines. Narrow by that.',
  'Doctor: Captain, %kw% is key. Keyword → 2-line evidence → pick one. That order.',
  'Pilot: Captain, verify %kw%. Then narrow. nav/time/sync are fact channels.',
  'Engineer: Captain, %kw% logs are system receipt. 2 lines output. Use that to choose.',
  'Navigator: Captain, primary evidence is in %kw%. Keyword → 2 lines. Narrow target.',
  'Doctor: Captain, verify %kw% channel. That is fact.',
  'Pilot: Captain, %kw% channel. Check 2-line evidence there. Then select.'
];

// --- alibi ---
const ALIBI_KO = [
  '저는 02:30~03:10 해당 구역에 있었습니다. 로그 확인 가능합니다.',
  '저는 사고 시점 교량에 있었습니다. 기록 확인하십시오.',
  '저는 그 시간 냉각 라인 점검 중이었습니다. 로그로 확인됩니다.',
  '저는 부검실에서 진단 중이었습니다. 기록 있습니다.',
  '저는 조종석에서 항법 점검 중이었습니다. 확인 가능합니다.',
  '저는 01:45~02:20 해당 구역에 있었습니다. 로그 확인하십시오.',
  '저는 엔진실 밖 복도에 있었습니다. 기록 확인 가능합니다.',
  '저는 그 시점 해당 구역에 있었습니다. 로그로 확인됩니다.'
];
const ALIBI_EN = [
  'I was in sector 02:30~03:10. Logs confirm.',
  'I was on the bridge at incident time. Records verify.',
  'I was inspecting cooling lines. Logs confirm.',
  'I was in medbay running diagnostics. Records exist.',
  'I was in cockpit running nav checks. Verifiable.',
  'I was in sector 01:45~02:20. Check logs.',
  'I was in corridor outside engine room. Records confirm.',
  'I was in sector at that time. Logs verify.'
];
// alibi line2: 알리바이 보조 (로그 검증 유도)
const ALIBI_LINE2_KO = [
  '알리바이는 로그로 검증하십시오. 말만으로는 부족합니다.',
  '위치 기록은 채널에 있습니다. 확인하십시오.',
  '저의 기록은 로그로 확인 가능합니다.',
  '알리바이 검증은 nav·time·sync 채널로 하십시오.',
  '로그가 말보다 우선입니다. 확인하십시오.',
];
const ALIBI_LINE2_EN = [
  'Verify alibi via logs. Words are not enough.',
  'Location records in channel. Check.',
  'My records verifiable in logs.',
  'Alibi verification via nav/time/sync channel.',
  'Logs over words. Verify.',
];

// --- frustration ---
const FRUST_KO = [
  '엔지니어: 함장, 지금은 불만 말할 시간 없습니다.',
  '네비게이터: 함장, 모두 답답합니다. 단서로 가시죠.',
  '닥터: 함장, 감정은 뒤로 하십시오. 증거를 보십시오.',
  '파일럿: 함장, 시간이 없습니다. 결정하십시오.',
  '엔지니어: 함장, 불평은 나중에. 로그를 확인하십시오.',
  '네비게이터: 함장, 모두 같은 상황입니다. 단서로 가시죠.',
  '닥터: 함장, 지금은 행동이 필요합니다.',
  '파일럿: 함장, 말 대신 로그를 보십시오.'
];
const FRUST_EN = [
  'Engineer: Captain, no time for complaints.',
  'Navigator: Captain, we are all stressed. Follow the evidence.',
  'Doctor: Captain, set feelings aside. Check the evidence.',
  'Pilot: Captain, no time. Decide.',
  'Engineer: Captain, complaints later. Check the logs.',
  'Navigator: Captain, same for everyone. Follow the clues.',
  'Doctor: Captain, action is needed now.',
  'Pilot: Captain, logs over words.'
];

// --- mechanics --- // PATCH
const MECHANICS_KO = [
  '닥터: 함장, 탄환 1발입니다. 처형 대상 1명만 선택하십시오.', // PATCH
  '엔지니어: 함장, 총알은 1발뿐입니다. 대상 1명. 키워드로 증거 확인 후 선택하십시오.', // PATCH
  '네비게이터: 함장, 탄환 1발. 대상 1명. 2줄 증거로 좁히십시오.', // PATCH
  '파일럿: 함장, 1발만 있습니다. 대상 1명 선택. 잘못 고르면 전멸입니다.', // PATCH
  '닥터: 함장, 처형 버튼은 대상 1명만. 탄환 1발. 키워드로 영수증 확인하십시오.', // PATCH
  '엔지니어: 함장, 탄환 1발. 골라야 할 대상 1명. 2줄 증거 확인 후 선택하십시오.', // PATCH
  '네비게이터: 함장, 1발. 1명. 키워드 입력 시 2줄 증거. 그걸로 선택하십시오.', // PATCH
  '파일럿: 함장, 탄환 1발, 대상 1명. 선택 전 키워드로 증거 확인하십시오.', // PATCH
  '닥터: 함장, 총알 1발. 처형 대상 1명. 실수는 없습니다.', // PATCH
  '엔지니어: 함장, 1발만 있습니다. 대상 1명 선택. nav/time/sync로 확인하십시오.', // PATCH
];
const MECHANICS_EN = [
  'Doctor: Captain, one bullet. Select one target only.',
  'Engineer: Captain, one bullet. One target. Verify evidence via keyword.',
  'Navigator: Captain, one bullet. One target. Narrow by 2-line evidence.',
  'Pilot: Captain, one bullet. Pick one. Wrong choice, we all die.',
  'Doctor: Captain, purge button: one target only. One bullet. Check receipt via keyword.',
  'Engineer: Captain, one bullet. One to choose. Verify 2-line evidence first.',
  'Navigator: Captain, one bullet. One target. Keyword → 2-line evidence. Use that.',
  'Pilot: Captain, one bullet. One target. Verify evidence before selecting.',
  'Doctor: Captain, one bullet. One target. No mistakes allowed.',
  'Engineer: Captain, one bullet. One target. Verify via nav/time/sync.',
];
// mechanics line2: 규칙 보조
const MECHANICS_LINE2_KO = [
  '키워드 입력 시 2줄 증거가 나옵니다. 그걸로 1명 선택하십시오.',
  'nav·time·sync 중 하나가 영수증입니다. 확인 후 대상 1명.',
  '처형 버튼은 1회만. 대상 1명. 실수는 없습니다.',
  '2줄 증거로 좁힌 후 1명만 선택하십시오.',
  '탄환 1발. 키워드로 증거 확인 후 결정하십시오.',
];
const MECHANICS_LINE2_EN = [
  'Keyword input → 2-line evidence. Use that to pick one.',
  'nav/time/sync: one is receipt. Verify. One target.',
  'Purge button: one use. One target. No mistakes.',
  'Narrow by 2-line evidence. Then pick one.',
  'One bullet. Verify evidence via keyword. Then decide.',
];

// --- who --- (수상함 vs 확정 구분, "모릅니다"만 반복하지 않음)
const WHO_KO = [
  '닥터: 함장, 수상한 행적은 로그에 있습니다. 확정은 불가합니다.',
  '엔지니어: 함장, 의심 대상은 좁혀졌으나 정체 확정은 로그로만 가능합니다.',
  '네비게이터: 함장, HOST 정체는 아직 확정되지 않았습니다. nav·time·sync로 좁히십시오.',
  '파일럿: 함장, 수상한 접속 기록은 있으나 누군지 단정할 수 없습니다.',
  '닥터: 함장, 의심과 확정은 다릅니다. 2줄 증거로 대상만 좁히십시오.',
  '엔지니어: 함장, 정체 확정은 불가. 수상한 기록은 채널에 있습니다.',
  '네비게이터: 함장, 확정 전엔 처형 불가. 로그로 1명 좁히십시오.',
  '파일럿: 함장, 수상함과 확정은 별개입니다. 로그 확인 후 결정하십시오.',
  '닥터: 함장, HOST 정체는 로그로만 확인 가능합니다.',
  '엔지니어: 함장, 의심은 있으나 확정은 2줄 증거로만 가능합니다.',
];
const WHO_EN = [
  'Doctor: Captain, suspicious activity is in logs. Identity not confirmed.',
  'Engineer: Captain, suspects narrowed. Confirmation only via logs.',
  'Navigator: Captain, HOST identity not confirmed. Narrow by nav/time/sync.',
  'Pilot: Captain, suspicious access logs exist. Cannot identify yet.',
  'Doctor: Captain, suspicion and confirmation differ. Narrow by 2-line evidence.',
  'Engineer: Captain, identity unconfirmed. Suspicious records in channel.',
  'Navigator: Captain, no purge until confirmed. Narrow to one via logs.',
  'Pilot: Captain, suspicion and confirmation are separate. Check logs.',
  'Doctor: Captain, HOST identity. Logs only.',
  'Engineer: Captain, suspicion exists. Confirmation via 2-line evidence only.',
];
// who line2: 수상함/확정 차이, 로그 유도
const WHO_LINE2_KO = [
  '수상한 기록과 확정은 별개입니다. 로그로 좁히십시오.',
  '의심 대상은 있으나 정체 확정은 2줄 증거 후입니다.',
  'HOST 정체는 로그 채널로만 확인 가능합니다.',
  '수상한 행적은 로그에 있습니다. 확정은 함장 판단입니다.',
  '의심과 처형 대상은 다릅니다. 2줄 증거 확인하십시오.',
];
const WHO_LINE2_EN = [
  'Suspicious records and confirmation differ. Narrow by logs.',
  'Suspects exist. Identity confirmation after 2-line evidence.',
  'HOST identity. Log channel only.',
  'Suspicious activity in logs. Confirmation is your call.',
  'Suspicion and purge target differ. Verify 2-line evidence.',
];

// --- roleinfo ---
const ROLEINFO_KO = [
  '네비게이터: 함장, 항법과 로그 감시를 담당합니다.',
  '네비게이터: 함장, 경로 유지와 로그 감시입니다.',
  '네비게이터: 함장, 센서와 접속 로그를 감시합니다.',
  '엔지니어: 함장, 원자로와 냉각 시스템을 담당합니다.',
  '엔지니어: 함장, 원자로·냉각 점검입니다.',
  '엔지니어: 함장, 시스템 점검을 담당합니다.',
  '닥터: 함장, 생체 신호와 의료를 담당합니다.',
  '닥터: 함장, 승무원 생체 신호 감시입니다.',
  '닥터: 함장, 의료 장비 가동을 담당합니다.',
  '파일럿: 함장, 조종석과 항법 운영을 담당합니다.',
  '파일럿: 함장, 항법 온라인과 조종 운영입니다.',
  '파일럿: 함장, 조종석 운영을 담당합니다.',
];
const ROLEINFO_EN = [
  'Navigator: Captain, navigation and log monitoring.',
  'Navigator: Captain, course holding and log monitoring.',
  'Navigator: Captain, sensors and access log monitoring.',
  'Engineer: Captain, reactor and cooling systems.',
  'Engineer: Captain, reactor and cooling checks.',
  'Engineer: Captain, systems maintenance.',
  'Doctor: Captain, vitals and medical.',
  'Doctor: Captain, crew vitals monitoring.',
  'Doctor: Captain, medbay operations.',
  'Pilot: Captain, cockpit and nav operations.',
  'Pilot: Captain, nav online and cockpit.',
  'Pilot: Captain, cockpit operations.',
];
// roleinfo line2: 역할/위장/불완전한 신뢰 톤
const ROLEINFO_LINE2_KO = [
  '역할만으로는 HOST를 구분할 수 없습니다. 로그 확인하십시오.',
  '위장 가능합니다. 역할은 참고일 뿐입니다.',
  '역할은 공개 정보입니다. 신뢰는 로그로만 확인 가능합니다.',
  '역할은 알 수 있습니다. 정체는 로그로 확인하십시오.',
  '역할과 HOST 정체는 별개입니다. 2줄 증거로 좁히십시오.',
];
const ROLEINFO_LINE2_EN = [
  'Role alone cannot identify HOST. Check logs.',
  'Disguise possible. Role is reference only.',
  'Role is public. Trust verified by logs only.',
  'Role is known. Identity via logs.',
  'Role and HOST identity differ. Narrow by 2-line evidence.',
];

// --- whywatch ---
const WHYWATCH_KO = [
  '네비게이터: 함장, 로그로 알리바이 확인합니다.',
  '엔지니어: 함장, 기록은 규칙입니다. 확인하십시오.',
  '닥터: 함장, 감시는 프로토콜입니다.',
  '파일럿: 함장, 녹화는 증거용입니다.',
  '네비게이터: 함장, 그곳에 있었던 이유는 로그에 있습니다.',
  '엔지니어: 함장, 따라다닌 건 기록 때문입니다.',
  '닥터: 함장, 지켜본 이유는 로그로 확인하십시오.',
  '파일럿: 함장, 규정입니다. 더 말할 것 없습니다.',
  '네비게이터: 함장, 증거 수집. 그것뿐입니다.',
  '엔지니어: 함장, 로그 확인하십시오.',
];
const WHYWATCH_EN = [
  'Navigator: Captain, logs verify alibi.',
  'Engineer: Captain, recording is protocol. Check logs.',
  'Doctor: Captain, monitoring is protocol.',
  'Pilot: Captain, recording is for evidence.',
  'Navigator: Captain, reason for being there is in the logs.',
  'Engineer: Captain, followed for the record.',
  'Doctor: Captain, reason for watching. Check logs.',
  'Pilot: Captain, regulation. Nothing more.',
  'Navigator: Captain, evidence collection. That is all.',
  'Engineer: Captain, check the logs.',
];
// whywatch line2: 감시 이유 전용 톤
const WHYWATCH_LINE2_KO = [
  '감시·녹화는 프로토콜입니다. 이유는 로그에 기록됩니다.',
  '그곳에 있었던 이유는 접속 로그로 확인하십시오.',
  '따라다닌 건 증거 수집용입니다. 로그 확인하십시오.',
  '지켜본 이유는 채널 기록에 있습니다.',
  '녹화는 규정입니다. 상세는 로그로 확인하십시오.',
];
const WHYWATCH_LINE2_EN = [
  'Monitoring and recording are protocol. Reason in logs.',
  'Reason for being there. Check access logs.',
  'Followed for evidence collection. Check logs.',
  'Reason for watching. In channel records.',
  'Recording is regulation. Details in logs.',
];

// --- default ---
const DEFAULT_KO = [
  '엔지니어: 함장, 로그 확인하십시오.',
  '네비게이터: 함장, 2줄 증거로 좁히십시오.',
  '닥터: 함장, 증거로 결정하십시오.',
  '파일럿: 함장, 결정하십시오.',
  '엔지니어: 함장, nav·time·sync 확인하십시오.',
  '네비게이터: 함장, 시간이 없습니다.',
  '닥터: 함장, 로그를 보십시오.',
  '파일럿: 함장, 1명으로 좁히십시오.',
  '엔지니어: 함장, 단서 채널 확인하십시오.',
  '네비게이터: 함장, 1발만 있습니다. 신중하십시오.',
  '닥터: 함장, 잘못 고르면 전멸입니다.',
  '파일럿: 함장, 로그 확인 후 선택하십시오.',
  '엔지니어: 함장, 2줄로 나옵니다. 그걸로 좁히십시오.',
  '네비게이터: 함장, 증거로 좁히십시오.',
  '닥터: 함장, 1명 선택하십시오.',
];
const DEFAULT_EN = [
  'Engineer: Captain, check the logs.',
  'Navigator: Captain, narrow by 2-line evidence.',
  'Doctor: Captain, decide by evidence.',
  'Pilot: Captain, decide.',
  'Engineer: Captain, verify nav/time/sync.',
  'Navigator: Captain, no time.',
  'Doctor: Captain, check the logs.',
  'Pilot: Captain, narrow to one.',
  'Engineer: Captain, check clue channel.',
  'Navigator: Captain, one bullet. Choose carefully.',
  'Doctor: Captain, wrong choice, we all die.',
  'Pilot: Captain, verify logs. Then choose.',
  'Engineer: Captain, 2 lines output. Use that.',
  'Navigator: Captain, narrow by evidence.',
  'Doctor: Captain, pick one.',
];

// --- fallback only: generic 긴급 문구 (default 브랜치에서만 사용) ---
const DEFAULT_LINE2_KO = [
  '변명은 다 같습니다. 실수하면 전멸입니다.',
  '말만으로는 안 됩니다. 시간이 없습니다. 결정하십시오.',
  '시간이 없습니다. 잘못 고르면 전원 사망합니다.',
  '탄환 1발입니다. 실수는 없습니다.',
  '로그 확인하십시오. 대상 1명 잘못 고르면 전멸입니다.',
  '결정하십시오. 시간이 없습니다.',
  '1발만 있습니다. 잘못 고르면 전원 사망합니다.',
  '키워드로 증거 확인하십시오. 실수는 용납되지 않습니다.',
];
const DEFAULT_LINE2_EN = [
  'Same excuses from everyone. Wrong choice, we all die.',
  'Words mean nothing. No time. Decide.',
  'No time. Wrong choice, we all die.',
  'One bullet. No mistakes.',
  'Check the logs. Wrong target, we all die.',
  'Decide. No time.',
  'One bullet left. Wrong choice, we all die.',
  'Verify evidence via keyword. No mistakes allowed.',
];

// status/decide/clue/frustration용 line2 (intent 전용, generic 긴급 아님)
const STATUS_LINE2_KO = ['다음 보고 준비 중입니다.', '이상 없습니다. 대기 중.'];
const STATUS_LINE2_EN = ['Next report preparing.', 'Nominal. Standing by.'];
const DECIDE_LINE2_KO = ['2줄 증거 확인 후 1명 선택하십시오.', '키워드로 영수증 확인하십시오.'];
const DECIDE_LINE2_EN = ['Verify 2-line evidence. Pick one.', 'Check receipt via keyword.'];
const CLUE_LINE2_KO = ['%kw%가 핵심입니다. 확인하십시오.', '2줄로 나옵니다. 그걸로 좁히십시오.'];
const CLUE_LINE2_EN = ['%kw% is key. Verify.', '2 lines output. Use that to narrow.'];
const FRUSTRATION_LINE2_KO = ['로그로 가시죠.', '증거를 보십시오.'];
const FRUSTRATION_LINE2_EN = ['Follow the logs.', 'Check the evidence.'];

function buildFreeQuestionResponse({ cfg = {}, question = '', lang = 'en', deadCrew = [], turnId = 0 }) { // PATCH
  const q = String(question || '').trim();
  const isKo = lang === 'ko';

  const kw = getCurrentKeyword(cfg);
  const seed = String(cfg.seed || 'x'); // PATCH
  let branch = classifyBranch(q);
  const hashKey = seed + '|' + String(turnId) + '|' + question + '|' + branch; // PATCH
  const mentionedRole = detectRoleInQuestion(q);
  const dead = Array.isArray(deadCrew) ? deadCrew : [];
  if (mentionedRole && dead.includes(mentionedRole) && /^(roleinfo|alibi|who)$/.test(branch)) branch = 'default';

  const [speaker1, speaker2] = pickRolePair(branch === 'alibi' ? mentionedRole : null, deadCrew, hashKey);
  const safeSecondary = (speaker2 === speaker1) ? pickRolePair(null, deadCrew, hashKey + 'x')[1] : speaker2; // PATCH

  let line1;
  let arr1 = branch === 'status' ? (isKo ? STATUS_KO : STATUS_EN)
    : branch === 'decide' ? (isKo ? DECIDE_KO : DECIDE_EN)
    : branch === 'clue' ? (isKo ? CLUE_KO : CLUE_EN)
    : branch === 'mechanics' ? (isKo ? MECHANICS_KO : MECHANICS_EN)
    : branch === 'who' ? (isKo ? WHO_KO : WHO_EN)
    : branch === 'roleinfo' ? (isKo ? ROLEINFO_KO : ROLEINFO_EN)
    : branch === 'whywatch' ? (isKo ? WHYWATCH_KO : WHYWATCH_EN)
    : branch === 'alibi' ? (isKo ? ALIBI_KO : ALIBI_EN)
    : branch === 'frustration' ? (isKo ? FRUST_KO : FRUST_EN)
    : (isKo ? DEFAULT_KO : DEFAULT_EN);

  if (branch === 'roleinfo' && mentionedRole) { // PATCH
    const prefix = isKo ? ROLE_KO[mentionedRole] : mentionedRole;
    const filtered = arr1.filter((line) => line.startsWith(prefix + ':'));
    if (filtered.length > 0) arr1 = filtered; // PATCH
  } // PATCH

  const idx1 = simpleHash(hashKey) % arr1.length;

  if (branch === 'alibi') {
    const prefix = isKo ? ROLE_KO[speaker1] : speaker1;
    const honorific = isKo ? '함장, ' : 'Captain, ';
    line1 = prefix + ': ' + honorific + arr1[idx1];
  } else {
    line1 = arr1[idx1];
  }

  if (branch === 'clue') line1 = line1.replace(/%kw%/g, kw);

  // branch별 line2 전용화 (generic 긴급 문구는 fallback에서만)
  let secondArr;
  switch (branch) {
    case 'who': secondArr = isKo ? WHO_LINE2_KO : WHO_LINE2_EN; break;
    case 'whywatch': secondArr = isKo ? WHYWATCH_LINE2_KO : WHYWATCH_LINE2_EN; break;
    case 'mechanics': secondArr = isKo ? MECHANICS_LINE2_KO : MECHANICS_LINE2_EN; break;
    case 'roleinfo': secondArr = isKo ? ROLEINFO_LINE2_KO : ROLEINFO_LINE2_EN; break;
    case 'alibi': secondArr = isKo ? ALIBI_LINE2_KO : ALIBI_LINE2_EN; break;
    case 'status': secondArr = isKo ? STATUS_LINE2_KO : STATUS_LINE2_EN; break;
    case 'decide': secondArr = isKo ? DECIDE_LINE2_KO : DECIDE_LINE2_EN; break;
    case 'clue': secondArr = isKo ? CLUE_LINE2_KO : CLUE_LINE2_EN; break;
    case 'frustration': secondArr = isKo ? FRUSTRATION_LINE2_KO : FRUSTRATION_LINE2_EN; break;
    default: secondArr = isKo ? DEFAULT_LINE2_KO : DEFAULT_LINE2_EN;
  }
  const secondIdx = simpleHash(hashKey + '|second') % secondArr.length;
  let line2Raw = secondArr[secondIdx];
  if (branch === 'clue') line2Raw = line2Raw.replace(/%kw%/g, kw);
  const prefix2 = isKo ? ROLE_KO[safeSecondary] : safeSecondary;
  const honorific2 = isKo ? '함장, ' : 'Captain, ';
  const line2 = prefix2 + ': ' + honorific2 + line2Raw;

  return line1 + '\n' + line2;
}

buildFreeQuestionResponse.__version = FREE_QA_VERSION; // PATCH
module.exports = { buildFreeQuestionResponse };
