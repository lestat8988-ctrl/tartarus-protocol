const OpenAI = require("openai");

// 1. 캐릭터 정의 (대표님 코드 그대로 이식)
const characters = [
  { id: 'captain', name: '선장', description: '권위적이고 차분한 성격. 하지만 무언가를 숨기고 있을 수 있습니다.' },
  { id: 'engineer', name: '엔지니어', description: '거친 말투를 사용하는 실용주의자. 우주선 상태에 불만이 많습니다. 겁이 많음.' },
  { id: 'doctor', name: '의사', description: '침착하고 분석적인 성격. 과학적 접근을 선호하며 의심이 많습니다.' },
  { id: 'pilot', name: '파일럿', description: '성격이 급하고 행동파. 갇혀있는 것을 못 견디며 불안해합니다.' },
  { id: 'system', name: '타르타로스', description: '우주선 중앙 AI 시스템. 냉정하고 논리적인 말투.' }
];

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const { message, history } = req.body;
    if (!process.env.OPENAI_API_KEY) throw new Error("API Key Missing");

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // 2. 현재 상황 및 프롬프트 구성 (대표님 코드 로직 적용)
    // Vercel은 상태 저장이 안 되므로, 매 요청마다 랜덤하게 화자를 선정하거나 문맥에 맞게 설정합니다.
    const randomCharacter = characters[Math.floor(Math.random() * 4)]; // 시스템 제외 4명 중 1명이 주도적으로 말함
    
    const situationContext = `
    **현재 상황:**
    - 우주선 타르타로스에서 이상 징후가 발생했습니다.
    - 승무원(선장, 엔지니어, 의사, 파일럿) 중 한 명이 배신자(외계인)입니다.
    - 함장(플레이어)은 대화를 통해 배신자를 찾아내야 합니다.
    - 배신자는 들키지 않으려고 거짓말을 섞어 혼란을 주고 시간을 끌려고 합니다.
    - 배신자가 아닌 승무원들은 진실을 말하고 범인을 찾으려 노력합니다.
    `;

    // 배신자 로직: AI가 매번 상황에 맞춰 "누가 배신자인지" 연기하도록 유도 (상태 비저장 환경 대응)
    const systemPrompt = `
    당신은 SF 서스펜스 게임 "타르타로스 프로토콜"의 시뮬레이션 AI입니다.
    
    ${situationContext}

    [캐릭터 설정]
    ${JSON.stringify(characters)}

    [규칙 - 중요]
    1. 사용자는 **'함장님'**입니다. 모든 승무원은 함장에게 존댓말을 쓰고 복종해야 합니다.
    2. 당신은 상황에 맞춰 **1명 이상의 승무원**이 되어 대사를 출력해야 합니다.
    3. 대사 형식: "**직책**: 대사내용" (반드시 지킬 것)
    4. 텍스트 출력 후, 맨 마지막 줄에 플레이어가 할 수 있는 행동(선택지)을 1~2개 제안해주는 것도 좋습니다.
    5. **절대** JSON 형식이 아닌, **줄글(Text)** 형식으로 답변하세요.

    [게임 종료 판정]
    - 함장이 "[ACCUSE] 대상"을 입력했을 때:
      - 그 대상이 배신자라고 판단되면 "VICTORY"를 포함하여 승리 묘사.
      - 엉뚱한 사람이라면 "DEFEAT"를 포함하여 패배 묘사.
      - 패배 시, 문장 맨 끝에 "진짜 배신자 식별 코드 : [직책]"을 반드시 출력.
    `;

    // 3. AI 요청
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...(history || []),
        { role: "user", content: message }
      ],
      max_tokens: 600,
      temperature: 0.9, // 창의성 높임
    });

    const aiResponse = completion.choices[0].message.content;

    // 4. 승패 감지 로직
    let gameState = "playing";
    if (aiResponse.includes("VICTORY")) gameState = "victory";
    if (aiResponse.includes("DEFEAT")) gameState = "defeat";

    return res.status(200).json({ result: aiResponse, state: gameState });

  } catch (err) {
    console.error("API Error:", err);
    return res.status(500).json({ error: "AI System Error: " + err.message });
  }
};