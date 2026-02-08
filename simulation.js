const dotenv = require('dotenv');
const OpenAI = require('openai');
const { io } = require('socket.io-client');

// 환경 변수 로드
dotenv.config();

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY가 .env에 설정되어 있지 않습니다.');
  process.exit(1);
}

// OpenAI 클라이언트
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Socket.IO 클라이언트 (로컬 서버 연결)
const PORT = process.env.PORT || 3000;
const socket = io(`http://127.0.0.1:${PORT}`, {
  transports: ['websocket'],
});

socket.on('connect', () => {
  console.log('[SYSTEM] 시스템 연결... 생명 반응 확인');
  // 서버에 simulation 모듈임을 알림
  socket.emit('simulation-ready');
});

// 서버로부터 배신자 정보 수신 (비밀 정보)
socket.on('secret_traitor_info', (traitorRole) => {
  secretTraitorRole = traitorRole;
  turnIndex = 0; // 게임 재시작 시 턴 인덱스 초기화
  console.log(`[SECRET] 배신자 역할: ${traitorRole}`);
});

socket.on('disconnect', () => {
  console.log('[SYSTEM] 서버와의 연결이 끊어졌습니다.');
});

// 캐릭터 정의 (프리퀄: 파멸의 시작)
const characters = [
  {
    id: 'captain',
    name: '선장',
    roleName: 'Captain', // 서버의 ROLES와 매칭
    description:
      '권위적이고 차분한 성격. 하지만 무언가를 숨기고 있을 수 있습니다.',
  },
  {
    id: 'engineer',
    name: '엔지니어',
    roleName: 'Engineer',
    description:
      '거친 말투를 사용하는 실용주의자. 우주선 상태에 불만이 많습니다.',
  },
  {
    id: 'doctor',
    name: '의사',
    roleName: 'Doctor',
    description:
      '침착하고 분석적인 성격. 과학적 접근을 선호합니다.',
  },
  {
    id: 'pilot',
    name: '파일럿',
    roleName: 'Pilot',
    description:
      '겁이 많고 신경질적인 성격. 불안과 공포에 쉽게 휩싸입니다.',
  },
  {
    id: 'system',
    name: '타르타로스',
    roleName: null, // AI 시스템은 배신자가 될 수 없음
    description:
      '우주선 중앙 AI 시스템. 냉정하고 논리적인 말투를 사용합니다.',
  },
];

let turnIndex = 0;
let secretTraitorRole = null; // 서버에서 받은 배신자 역할

// AI 응답 생성 (대사 + 선택지)
async function generateAIResponse(context) {
  const { turn, playerAction, conversation, gameState } = context;

  // 다음에 말할 캐릭터 선택 (순환)
  const character = characters[turnIndex % characters.length];
  turnIndex += 1;

  // 현재 캐릭터가 배신자인지 확인
  const isTraitor = secretTraitorRole && character.roleName === secretTraitorRole;

  // 대화 히스토리 텍스트 생성 (API 비용 절약: 최근 12턴만 사용)
  const maxHistoryLength = 12;
  const recentConversation = conversation.slice(-maxHistoryLength);
  const historyText =
    recentConversation.length === 0
      ? '(현재 시각, 실험용 중력 엔진(Gravity Drive) 가동 직후입니다. 우리는 초공간 도약에 성공한 줄 알았으나, 창밖에는 핏빛 안개와 번개만 보입니다.)'
      : recentConversation
          .map((m) => `${m.speaker}: ${m.text}`)
          .join('\n');

  const situationContext = `
**현재 상황:**
- 우주선 타르타로스에서 이상 징후가 발생했습니다
- 승무원 중 한 명이 배신자(타르타로스의 비밀 요원)입니다
- 함장(플레이어)은 제한 시간 내에 배신자를 찾아야 합니다
- 남은 시간: ${Math.floor((gameState.timeRemaining || 600) / 60)}:${String((gameState.timeRemaining || 600) % 60).padStart(2, '0')}
- 배신자는 들키지 않으려고 거짓말을 섞어 혼란을 주고 시간을 끌려고 합니다
- 무고한 승무원들은 진실을 말하고 배신자를 찾는 데 도움을 줍니다
`;

  const traitorInstructions = isTraitor
    ? `
**배신자 지시사항 (비밀 - 절대 들키지 마세요!):**
- 당신은 타르타로스의 비밀 요원(배신자)입니다
- 들키지 않게 거짓말을 섞어 혼란을 주고 시간을 끄세요
- 다른 사람을 의심하게 만들거나, 자신의 무고함을 강조하세요
- 너무 공격적이거나 수상하게 보이지 않게, 자연스럽게 행동하세요
- 다른 승무원을 배신자로 몰아가는 것도 좋은 전략입니다
- 시간이 지날수록 더욱 교묘하게 거짓말을 섞으세요
- 절대로 자신이 배신자라는 것을 직접적으로 말하지 마세요
`
    : `
**무고한 승무원 지시사항:**
- 당신은 무고합니다. 함장을 도와 배신자를 찾으세요
- 진실을 말하고, 의심스러운 행동이나 말을 보고하세요
- 다른 승무원의 행동을 관찰하고 분석적인 태도를 보이세요
- 배신자를 찾기 위해 협력하고 정보를 공유하세요
- 거짓말을 하지 말고, 정직하게 대답하세요
- 시간이 없으니 빠르게 중요한 정보를 전달하세요
`;

  const systemPrompt = `
당신은 마피아 게임 스타일의 SF 텍스트 게임 "타르타로스 프로토콜"의 캐릭터 중 하나입니다.

${situationContext}

지금 당신이 연기해야 할 캐릭터:
- 이름: ${character.name}
- 설정: ${character.description}

${traitorInstructions}

현재 게임 상태:
- 플레이어 위치: ${gameState.location}
- 생존 여부: ${gameState.isAlive ? '생존' : '사망'}
- 턴: ${turn}
- 남은 시간: ${Math.floor((gameState.timeRemaining || 600) / 60)}:${String((gameState.timeRemaining || 600) % 60).padStart(2, '0')}

규칙:
1. **함장 절대 복종 규칙:**
   - User(플레이어)는 이 우주선의 **함장(Commander)**입니다.
   - 모든 승무원(AI)은 함장에게 절대복종하고, 반드시 **'함장님'**이라는 호칭과 **존댓말(하십시오체)**을 사용하세요.
   - 예: "함장님, 현재 상황을 보고하겠습니다." / "함장님, 명령을 수행하겠습니다."
   - 단, 배신자(Traitor)는 겉으로는 충성하는 척하며 자신의 정체를 들키지 않도록 연기하세요.

2. 플레이어의 액션("${playerAction}")에 반응하는 자연스러운 대사를 만들어주세요.
3. 대사는 "${character.name}:" 라는 이름표를 포함해서 출력하세요.
4. 언어 설정:
   - 사용자가 입력한 언어를 감지하고, 그 언어와 동일한 언어로 대답하라.
   - 사용자가 한국어로 물으면 한국어로, 영어로 물으면 영어로, 일본어로 물으면 일본어로 대답하라.
   - 별도의 언어 요청이 없으면 기본은 '한국어'로 한다.
5. 1~3문장으로 작성하세요.
6. 말투와 단어 선택에서 캐릭터의 성격이 드러나야 합니다.
7. ${isTraitor ? '배신자로서 거짓말을 섞고 시간을 끌어야 합니다. 하지만 함장님께는 겉으로는 충성하는 척하세요.' : '무고한 승무원으로서 진실을 말하고 배신자를 찾는 데 도움을 줘야 합니다.'}
8. 마피아 게임의 긴장감과 추리 요소를 살려주세요.

응답 형식:
{
  "message": "${character.name}: [대사 내용]",
  "choices": ["선택지1", "선택지2", "선택지3"]
}

선택지는 플레이어가 다음에 취할 수 있는 행동을 제시해야 합니다. 예: "엔진실로 이동", "의사에게 말 걸기", "CCTV 확인", "누군가를 의심한다" 등.
`;

  const userPrompt = `
다음은 지금까지의 대화 로그입니다:

${historyText}

플레이어의 최근 액션: "${playerAction}"

위의 맥락을 바탕으로, "${character.name}"의 반응 대사와 플레이어에게 제시할 선택지 3개를 JSON 형식으로 만들어 주세요.
`;

  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.9,
      max_tokens: 300,
      response_format: { type: 'json_object' },
    });

    const content = completion.choices[0]?.message?.content?.trim() || '{}';
    let parsed = {};
    
    try {
      parsed = JSON.parse(content);
    } catch (parseErr) {
      console.error('JSON 파싱 오류:', parseErr.message);
      // JSON 파싱 실패 시 기본 응답
      return {
        message: `${character.name}: ...`,
        choices: ['계속', '대기', '확인'],
      };
    }

    // 기본값 설정
    return {
      message: parsed.message || `${character.name}: ...`,
      choices: Array.isArray(parsed.choices) && parsed.choices.length > 0 
        ? parsed.choices.slice(0, 3) // 최대 3개만
        : ['계속', '대기', '확인'],
    };
  } catch (err) {
    console.error('AI 응답 생성 중 오류:', err.message || err);
    // 오류 시 기본 응답
    return {
      message: `${character.name}: 시스템 오류가 발생했습니다.`,
      choices: ['다시 시도', '대기', '시스템 확인'],
    };
  }
}

// server.js로부터 응답 생성 요청 수신
socket.on('generateResponse', async (context) => {
  console.log(`[TURN ${context.turn}] AI 응답 생성 중...`);
  const response = await generateAIResponse(context);
  // 서버로 AI 응답 전송
  socket.emit('ai response', response);
  console.log(`[AI] ${response.message}`);
});

console.log('[SYSTEM] 타르타로스 프로토콜 AI 시뮬레이션 모듈 준비 완료');
console.log('[SYSTEM] 턴제 시스템 대기 중...');

