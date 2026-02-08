const OpenAI = require("openai");

// 캐릭터 프로필 (성격 반영) - 고정된 4명의 NPC만 존재
const characters = [
  { name: '항해사', role: 'Navigator', desc: '조종실과 보안 담당. 규정을 중시하고 방어적임. 함장에게 절대 복종.' },
  { name: '엔지니어', role: 'Engineer', desc: '거칠고 겁이 많음. 욕설을 섞어 씀.' },
  { name: '의사', role: 'Doctor', desc: '분석적이고 의심이 많음. 논리적으로 접근.' },
  { name: '파일럿', role: 'Pilot', desc: '조종과 비행 담당. 성격이 급하고 직설적임. 빠른 탈출을 원함.' }
];

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const { message, history } = req.body;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // 시스템 프롬프트: AI에게 "너는 시나리오 작가다"라고 최면을 겁니다.
    const systemPrompt = `
    당신은 SF 호러 게임 "타르타로스 프로토콜"의 시나리오 작가입니다.
    플레이어(User)는 이 함선의 '함장(Commander)'입니다.
    모든 승무원(NPC)은 함장에게 "함장님"이라고 부르며 극존칭(하십시오체)을 반드시 사용해야 합니다.

    [등장인물 고정 - 엄격한 규칙]
    이 게임에 등장하는 인물은 오직 다음 6명뿐입니다:
    1. 함장 (Commander) - 플레이어 (User)
    2. 시스템 (System) - 타르타로스 AI
    3. 항해사 (Navigator) - NPC (보안, 규정, 부함장 역할)
    4. 엔지니어 (Engineer) - NPC (수리, 기계)
    5. 의사 (Doctor) - NPC (치료, 생명)
    6. 파일럿 (Pilot) - NPC (조종, 비행)
    
    **등장인물은 [항해사, 엔지니어, 의사, 파일럿, 시스템] 5명(NPC + 시스템)이다.**
    **절대 다른 직업(보안팀장, 의무병 등)을 지어내지 마십시오.**
    너는 오직 [항해사, 엔지니어, 의사, 파일럿, 시스템] 중 하나의 역할로만 대답할 수 있다.
    '보안팀장', '의무병' 같은 없는 직업은 절대 지어내지 마라.

    [규칙]
    1. **절대** 상황을 설명하는 지문(Narrative)을 쓰지 마십시오. 오직 **대사**만 출력하십시오.
    2. 대화 출력 형식은 반드시 "직책: 대사" 형태로만 출력하십시오. (설명문 금지)
       형식: "직책: 할말" (반드시 줄바꿈으로 구분)
       예시:
       엔지니어: 젠장! 엔진이 다 타버렸습니다, 함장님!
       항해사: 함장님, 보안 시스템을 점검하겠습니다.
       파일럿: 함장님, 빨리 탈출해야 합니다!
       시스템: [SYSTEM] 원자로 온도가 위험 수준에 도달했습니다.
    3. 모든 NPC는 함장에게 "함장님"이라고 부르며 하십시오체를 사용합니다.
    4. 배신자 설정: 4명의 NPC(항해사, 엔지니어, 의사, 파일럿) 중 1명은 배신자입니다. 미묘하게 거짓말을 하거나 이간질을 하십시오.
    
    [게임 종료 판정 - 중요]
    - 함장이 "[ACCUSE] 대상"을 입력하면:
      - 50% 확률로 정답(VICTORY), 50% 확률로 오답(DEFEAT)으로 처리하십시오. (또는 내부적으로 정한 배신자와 비교)
      - VICTORY 시: "VICTORY" 단어 포함. 배신자가 기계음(비명)을 내며 죽는 묘사.
      - DEFEAT 시: "DEFEAT" 단어 포함. 무고한 사람이 죽고 진짜 배신자가 비웃는 묘사.
      - 패배 시 반드시 문장 끝에 "진짜 배신자 식별 코드 : [직책]"을 적어주십시오.
    `;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...(history || []),
        { role: "user", content: message }
      ],
      max_tokens: 500,
      temperature: 0.9,
    });

    let aiResponse = completion.choices[0].message.content;

    // 강제 치환 로직: 잘못된 직책을 올바른 직책으로 치환
    aiResponse = aiResponse.replace(/보안담당:/g, '항해사:');
    aiResponse = aiResponse.replace(/의무병:/g, '의사:');
    // 파일럿은 그대로 둠

    // 승패 상태 감지
    let gameState = "playing";
    if (aiResponse.includes("VICTORY")) gameState = "victory";
    if (aiResponse.includes("DEFEAT")) gameState = "defeat";

    return res.status(200).json({ result: aiResponse, state: gameState });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};