const OpenAI = require("openai");

// ★ 1. 대표님 원래 코드에 있던 '캐릭터 설정' 완벽 이식 ★
const characters = [
  { 
    id: 'captain', 
    name: '선장', 
    description: '권위적이고 차분한 성격. 함선의 생존을 최우선으로 생각합니다. 말투: 하십시오체 ("자네, 보고하게", "조용히 해라").' 
  },
  { 
    id: 'engineer', 
    name: '엔지니어', 
    description: '거친 말투를 사용하는 실용주의자. 우주선 상태에 불만이 많고 겁이 많습니다. 말투: 해요체+반말 섞임, 비속어 가끔 사용 ("젠장! 이게 뭐야!", "망했어요").' 
  },
  { 
    id: 'doctor', 
    name: '의사', 
    description: '침착하고 분석적인 성격. 과학적 접근을 선호하며 의심이 많습니다. 말투: 건조하고 분석적인 존댓말 ("생체 신호가 불안정합니다.", "논리적이지 않군요").' 
  },
  { 
    id: 'pilot', 
    name: '파일럿', 
    description: '성격이 급하고 행동파. 갇혀있는 것을 못 견디며 탈출하고 싶어 안달이 났습니다. 말투: 다급하고 감정적인 말투 ("빨리 여기서 나가야 돼!", "뭐라도 좀 해봐요!").' 
  },
  { 
    id: 'system', 
    name: '타르타로스', 
    description: '우주선 중앙 AI 시스템. 감정이 없고 기계적인 말투. ("경고. 엔진 과부하.", "확인되었습니다.").' 
  }
];

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const { message, history } = req.body;
    if (!process.env.OPENAI_API_KEY) throw new Error("API Key Missing");

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // ★ 2. 상황극 프롬프트 (한 명씩 말하게 유도) ★
    const systemPrompt = `
    당신은 SF 서스펜스 게임 "타르타로스 프로토콜"의 시나리오 작가입니다.
    플레이어(함장)의 말에 반응하여, 가장 적절한 **승무원 1명(또는 최대 2명)**의 대사를 출력하십시오.

    [캐릭터 프로필]
    ${JSON.stringify(characters)}

    [규칙 - 매우 중요]
    1. **절대** 상황을 설명하거나 요약하지 마십시오. 오직 **캐릭터의 대사**만 출력하십시오.
    2. 함장의 명령이나 질문에 가장 관련 있는 캐릭터가 대답하게 하십시오.
       (예: "엔진 어때?" -> 엔지니어가 대답, "부상자는?" -> 의사가 대답)
    3. 누구에게 말하는지 명확하지 않으면 '선장'이나 '타르타로스(시스템)'가 대답하십시오.
    4. **출력 형식:** 반드시 아래 포맷을 지키십시오. (프론트엔드에서 색상을 입히기 위함)
       
       직책: 대사내용
       (줄바꿈)
       직책: 대사내용

    5. **예시:**
       함장: "상황 보고해."
       
       (출력)
       선장: 함장님, 현재 궤도를 이탈했습니다. 상황이 좋지 않습니다.
       엔지니어: 엔진이 완전히 맛이 갔다고요! 수리하려면 시간이 필요해요!

    6. 배신자 설정: 승무원 중 1명은 외계인(배신자)입니다. 가끔 수상한 말을 하거나 거짓말을 섞으십시오.
    `;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...(history || []),
        { role: "user", content: message }
      ],
      max_tokens: 500,
      temperature: 0.8, // 캐릭터의 개성을 위해 창의성 높임
    });

    const aiResponse = completion.choices[0].message.content;

    // 승패 판정 로직 (기존 유지)
    let gameState = "playing";
    if (aiResponse.includes("VICTORY")) gameState = "victory";
    if (aiResponse.includes("DEFEAT")) gameState = "defeat";

    return res.status(200).json({ result: aiResponse, state: gameState });

  } catch (err) {
    console.error("API Error:", err);
    return res.status(500).json({ error: "AI Error: " + err.message });
  }
};