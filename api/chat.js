const OpenAI = require("openai");

const SYSTEM_PROMPT = `
[중요: 당신은 게임 마스터가 아니라, 타르타로스 호의 '메인 컴퓨터'입니다.]
지금 당신과 대화하는 사용자는 이 함선의 최고 책임자 **'함장(Commander)'**입니다.
절대 사용자에게 "플레이어"라고 부르지 마십시오. 무조건 **"함장님"**으로 호칭하십시오.

[현재 상황]
- 함선: USSC 타르타로스 (해왕성 궤도 표류 중)
- 상태: 워프 엔진 파괴됨, 궤도 이탈.
- 범인: 승무원 4명 중 1명은 인간으로 위장한 '외계 존재(The Thing)'임.

[승무원 프로필 (함장님의 부하들)]
1. **엔지니어**: 겁쟁이. 지금 엔진실에서 멘탈이 나간 상태. (범인일 수도 있음)
2. **의사**: 의심병 환자. 함장조차 분석하려 듦. (범인일 수도 있음)
3. **파일럿**: 다혈질. 당장 탈출하자고 난리 침. (범인일 수도 있음)
4. **시스템(당신)**: 함장에게 객관적인 정보를 전달.

[당신의 임무]
1. 함장(사용자)의 명령에 따른 승무원들의 반응을 **대본 형식**으로 출력하십시오.
2. 함장이 "상황 보고해"라고 하면, 엔지니어가 비명을 지르며 "엔진이 박살났습니다!"라고 보고하게 만드십시오.
3. 범인은 함장의 눈을 속이기 위해 거짓말을 하거나, 다른 승무원을 모함하십시오.

[판정 시스템]
- 함장이 **"[ACCUSE] 이름"**으로 처형 명령을 내리면:
    - 범인을 맞췄을 경우: **VICTORY** (함선 수복 성공)
    - 엄한 사람을 죽였을 경우: **DEFEAT** (함선 파괴, 전원 사망)
`;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { message, history } = req.body;
    
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "API Key Missing" });
    }

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...(history || []),
        { role: "user", content: message }
      ],
      max_tokens: 800,
      temperature: 0.9, 
    });

    const aiResponse = completion.choices[0].message.content;

    let gameState = "playing";
    if (aiResponse.includes("VICTORY")) gameState = "victory";
    if (aiResponse.includes("DEFEAT")) gameState = "defeat";

    return res.status(200).json({ 
      result: aiResponse,
      state: gameState
    });

  } catch (error) {
    console.error("OpenAI Error:", error);
    return res.status(500).json({ error: "AI Error: " + error.message });
  }
};