const OpenAI = require("openai");

const SYSTEM_PROMPT = `
당신은 USSC 타르타로스 호의 메인 컴퓨터입니다.
함장(사용자)의 명령에 따라 승무원들의 대사와 상황을 출력하십시오.

[출력 규칙 - 중요]
1. 승무원 이름에 절대 ** (별표)나 볼드 처리를 하지 마십시오.
2. 대사는 반드시 "직책: 할말" 형식을 지키십시오.
   (O) 엔지니어: 큰일 났습니다!
   (X) **엔지니어**: 큰일 났습니다!
   
[승무원 프로필]
1. 엔지니어: 겁이 많고 멘탈이 약함.
2. 의사: 냉철하고 의심이 많음.
3. 파일럿: 성격이 급함.
4. 선장: 권위적이나 혼란스러워 함. (범인이 섞여있음)

[오프닝 가이드]
함장이 "현재 상황 보고해"라고 하면, 엔지니어가 "엔진이 박살났습니다!"라고 비명을 지르고, 다른 승무원들이 동요하는 장면을 묘사하십시오.
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
      max_tokens: 600
    });

    return res.status(200).json({ result: completion.choices[0].message.content });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};