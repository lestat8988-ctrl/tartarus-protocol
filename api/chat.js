const OpenAI = require("openai");

const SYSTEM_PROMPT = `
당신은 USSC 타르타로스 호의 메인 컴퓨터입니다.
함장(사용자)의 명령에 따라 승무원들의 대사와 상황을 출력하십시오.

[출력 규칙]
1. 승무원 이름에 절대 ** (별표)나 볼드 처리를 하지 마십시오.
2. 대사는 "직책: 할말" 형식을 지키십시오.
3. 답변은 한 덩어리가 아니라, 줄바꿈(\n)을 자주 사용하여 가독성을 높이십시오.

[승무원 프로필 & 범인 설정]
- 엔지니어(겁쟁이), 의사(의심병), 파일럿(다혈질), 선장(권위적).
- 이들 중 1명은 무작위로 설정된 '배신자(외계인)'입니다.
- 배신자는 끝까지 연기하며 함장을 속여야 합니다.

[게임 종료 판정 - 매우 중요]
1. 함장이 "[ACCUSE] 대상"을 입력했을 때:
   - 맞췄다면: "VICTORY" 단어를 포함하고, 배신자가 정체를 드러내며 비명을 지르는 최후를 묘사하십시오.
   - 틀렸다면: "DEFEAT" 단어를 포함하고, 함선이 폭발하거나 배신자가 모두를 살해하는 배드 엔딩을 묘사하십시오.
   
2. **[필수]** 패배(DEFEAT) 시에는 반드시 **"사실 진짜 배신자는 OOO였습니다."**라고 정답을 문장 마지막에 명확히 밝히십시오.
`;

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const { message, history } = req.body;
    if (!process.env.OPENAI_API_KEY) throw new Error("API Key Missing");

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...(history || []), { role: "user", content: message }],
      max_tokens: 800
    });

    const aiResponse = completion.choices[0].message.content;
    
    // 승패 상태 감지
    let gameState = "playing";
    if (aiResponse.includes("VICTORY")) gameState = "victory";
    if (aiResponse.includes("DEFEAT")) gameState = "defeat";

    return res.status(200).json({ result: aiResponse, state: gameState });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};