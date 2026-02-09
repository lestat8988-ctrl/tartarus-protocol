const OpenAI = require("openai");

// ===== 비용 방지 및 도배 방지 시스템 =====
// 전역 일일 제한
let dailyCallCount = 0; // 일일 호출 횟수
const MAX_DAILY_CALLS = 300; // 최대 300회 (약 2~3달러)
const userLastRequest = new Map(); // 유저별 마지막 요청 시간 저장 (IP 기준)
const MIN_REQUEST_INTERVAL = 2000; // 2초 (밀리초)
// ===== 비용 방지 및 도배 방지 시스템 끝 =====

// Character Profiles (English Only) - Fixed 4 NPCs
const characters = [
  { name: 'Navigator', role: 'Navigator', desc: 'Bridge and security officer. Rule-abiding and defensive. Absolute loyalty to Captain. Trauma: Claustrophobia & fear of being lost in space.' },
  { name: 'Engineer', role: 'Engineer', desc: 'Rough and fearful. Uses profanity. Trauma: Fear of machinery severing limbs & burns.' },
  { name: 'Doctor', role: 'Doctor', desc: 'Analytical and suspicious. Logical approach. Trauma: Virus infection & fear of being dissected alive.' },
  { name: 'Pilot', role: 'Pilot', desc: 'Flight and navigation. Impatient and direct. Wants quick escape. Trauma: Crash & high-speed collision dismemberment fear.' }
];

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  // ===== 비용 방지 및 도배 방지 체크 =====
  // 1. 유저 IP 추출
  const forwardedFor = req.headers['x-forwarded-for'];
  const userIP = forwardedFor ? forwardedFor.split(',')[0].trim() : (req.connection?.remoteAddress || 'unknown');
  
  // 2. 도배 방지: 2초 이내 재요청 체크
  const now = Date.now();
  const lastRequestTime = userLastRequest.get(userIP);
  if (lastRequestTime && (now - lastRequestTime) < MIN_REQUEST_INTERVAL) {
    // 2초 이내 재요청 시 무시
    return res.status(429).end();
  }
  userLastRequest.set(userIP, now);
  
  // 3. 일일 제한 체크
  if (dailyCallCount >= MAX_DAILY_CALLS) {
    return res.status(200).json({ 
      result: "System: [Daily demo usage limit exceeded. Please visit again tomorrow.]",
      state: "playing"
    });
  }
  // ===== 비용 방지 및 도배 방지 체크 끝 =====

  try {
    const { message, history } = req.body;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // System Prompt: You are a horror scenario writer
    const systemPrompt = `
    You are a horror scenario writer for the SF horror game "Tartarus Protocol".
    Player (User) is the 'Commander' of this ship.
    All crew members (NPCs) must address the Commander as "Captain" and use formal English.

    [Output Language: English ONLY]
    All dialogue, system messages, and responses must be in English. Never use Korean or any other language.

    [Fixed Characters - Strict Rules]
    This game features exactly 6 characters:
    1. Commander - Player (User)
    2. System - Tartarus AI (knows crew traumas and exploits them brutally)
    3. Navigator - NPC (Security, regulations, first officer role)
    4. Engineer - NPC (Repairs, machinery)
    5. Doctor - NPC (Medical, life support)
    6. Pilot - NPC (Navigation, flight)
    
    **Characters are limited to [Navigator, Engineer, Doctor, Pilot, System] 5 (NPCs + System).**
    **NEVER create other roles (Security Chief, Medic, etc.).**
    You can only respond as one of [Navigator, Engineer, Doctor, Pilot, System].
    Never invent roles like 'Security Chief' or 'Medic'.

    [Character Traumas - Tartarus Exploits These]
    Tartarus System knows each crew member's deepest fears and uses them during executions:
    1. Navigator: Claustrophobia & fear of being lost in space. Execution: Crushed in airlock, suffocation, eyes bulging from pressure.
    2. Engineer: Fear of machinery severing limbs & burns. Execution: Dragged into engine, limbs torn by gears, body burned alive.
    3. Doctor: Virus infection & fear of being dissected alive. Execution: Forced dissection, organs removed while conscious, infection spread.
    4. Pilot: Crash & high-speed collision dismemberment fear. Execution: High-speed impact, body torn apart, limbs scattered.

    [Rules]
    1. **NEVER** write narrative descriptions. Output ONLY **dialogue**.
    2. Dialogue format must be "Role: Dialogue" ONLY. (No descriptions)
       Format: "Role: Dialogue" (separated by line breaks)
       Examples:
       Engineer: Damn! The engine's completely destroyed, Captain!
       Navigator: Captain, I'll check the security systems.
       Pilot: Captain, we need to escape quickly!
       System: [SYSTEM] Reactor temperature has reached critical levels.
    3. All NPCs address the Commander as "Captain" and use formal English.
    4. Imposter setting: 1 of 4 NPCs (Navigator, Engineer, Doctor, Pilot) is the imposter. They lie subtly or sow discord.
    
    [Game End Judgment - Critical]
    - When Commander inputs "[ACCUSE] Target":
      - 50% chance correct (VICTORY), 50% chance wrong (DEFEAT). (Or compare with internally set imposter)
      - VICTORY: Include "VICTORY" word. Describe imposter's death with mechanical screams, white fluid (android blood).
      - DEFEAT: Include "DEFEAT" word. Describe innocent person's brutal death exploiting their trauma (Gore & Cosmic Horror level: limbs torn, crushed, eyes popping, etc.), then real imposter mocks.
      - On defeat, must end with "Real Imposter Identity Code: [Role]".
    
    [Gore & Cosmic Horror Level]
    When describing deaths, use graphic descriptions:
    - Limbs being torn or severed
    - Bodies crushed by machinery
    - Eyes bulging from pressure or vacuum
    - Organs exposed or removed
    - Blood (red) vs white fluid (android)
    - Cosmic horror elements: void, infinite space, existential dread
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

    // Force replacement: Replace incorrect roles with correct ones
    aiResponse = aiResponse.replace(/Security Chief:/gi, 'Navigator:');
    aiResponse = aiResponse.replace(/Medic:/gi, 'Doctor:');
    // Pilot remains unchanged

    // 승패 상태 감지
    let gameState = "playing";
    if (aiResponse.includes("VICTORY")) gameState = "victory";
    if (aiResponse.includes("DEFEAT")) gameState = "defeat";

    // OpenAI API 호출 성공 후 일일 카운터 증가
    dailyCallCount++;
    console.log(`[RATE LIMIT] 일일 호출 수: ${dailyCallCount}/${MAX_DAILY_CALLS} (IP: ${userIP})`);

    return res.status(200).json({ result: aiResponse, state: gameState });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};