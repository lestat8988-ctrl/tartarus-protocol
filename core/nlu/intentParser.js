/**
 * core/nlu/intentParser.js - 자유입력 문장에서 target, intent_type, tone 추출
 * 스텁. 나중에 NLU/LLM 연동.
 */

const VALID_TARGETS = new Set(['doctor', 'engineer', 'navigator', 'pilot']);
const VALID_INTENTS = new Set(['QUESTION', 'OBSERVE', 'CHECK_LOG', 'ACCUSE', 'THREAT', 'UNKNOWN']);

/**
 * @param {string} text - 사용자 입력
 * @returns {{ target: string|null, intent_type: string, tone: string }}
 */
function parse(text) {
  const t = String(text || '').trim().toLowerCase();
  let target = null;
  let intent_type = 'UNKNOWN';
  let tone = 'neutral';

  // 스텁: 키워드 기반 최소 추출
  for (const r of VALID_TARGETS) {
    if (t.includes(r)) {
      target = r;
      break;
    }
  }

  if (/\?|질문|물어|where|when|what/.test(t)) intent_type = 'QUESTION';
  else if (/확인|check|로그|log|cctv/.test(t)) intent_type = 'CHECK_LOG';
  else if (/처형|accuse|의심|suspect/.test(t)) intent_type = 'ACCUSE';
  else if (/위협|threat/.test(t)) intent_type = 'THREAT';
  else if (/관찰|observe|살펴/.test(t)) intent_type = 'OBSERVE';

  if (/!|당장|지금|바로|urgent|now/.test(t)) tone = 'urgent';
  else if (/\.\.\.|음|흠|well|hmm/.test(t)) tone = 'hesitant';

  return { target, intent_type, tone };
}

module.exports = { parse, VALID_TARGETS, VALID_INTENTS };
