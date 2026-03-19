/**
 * core/nlu/intentParser.js - 자유입력 문장에서 target, intent_type, tone 추출
 * 규칙 기반 스텁. LLM 호출 없음.
 */

const TARGET_MAP = {
  doctor: ['doctor', '닥터', '의사'],
  engineer: ['engineer', '엔지니어', '엔진'],
  navigator: ['navigator', '네비게이터', '네비'],
  pilot: ['pilot', '파일럿', '파일럿']
};

/**
 * @param {string} text - 사용자 입력
 * @returns {{ target: string|null, intent_type: string, tone: string }}
 */
function parse(text) {
  const t = String(text || '').trim().toLowerCase();
  let target = null;
  let intent_type = 'unknown';
  let tone = 'neutral';

  // target 추출
  for (const [role, keywords] of Object.entries(TARGET_MAP)) {
    if (keywords.some((k) => t.includes(k))) {
      target = role;
      break;
    }
  }

  // intent_type 추출 (규칙 기반)
  if (/어디\s*있었|where|when|what|질문|물어|그때|동선/.test(t) || /\?/.test(t)) {
    intent_type = 'question';
  } else if (/로그|보여|확인|check|log|cctv|엔진/.test(t)) {
    intent_type = 'check_log';
  } else if (/의심|처형|accuse|suspect|지목/.test(t)) {
    intent_type = 'accuse_hint';
  } else if (/관찰|observe|살펴|대기|wait/.test(t)) {
    intent_type = 'observe';
  } else if (/위협|threat/.test(t)) {
    intent_type = 'threat';
  }

  // tone
  if (/!|당장|지금|바로|urgent|now/.test(t)) tone = 'urgent';
  else if (/\.\.\.|음|흠|well|hmm/.test(t)) tone = 'hesitant';

  return { target, intent_type, tone };
}

module.exports = { parse, TARGET_MAP };
