const path = require('path');
const { fork } = require('child_process');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 정적 파일 제공 (public 폴더)
app.use(express.static(path.join(__dirname, 'public')));

// 역할 배열
const ROLES = ['Captain', 'Engineer', 'Doctor', 'Pilot'];

// 게임 상태 관리
const gameState = {
  turn: 0,
  playerLocation: 'bridge', // bridge, engine, medbay, cockpit 등
  isAlive: true,
  conversation: [], // 대화 로그
  gameOver: false,
  traitor: null, // 배신자 역할 (랜덤 배정)
  timeRemaining: 600, // 제한 시간 (초 단위, 10분 = 600초)
  gameResult: null, // 'victory' 또는 'defeat'
};

// simulation.js와의 통신을 위한 소켓 (내부 통신)
let simulationSocket = null;
let gameTimer = null; // 타이머 인터벌

// 오프닝 스토리 상수
const OPENING_SCRIPT = '[SYSTEM BOOT SEQUENCE...]\n접속 대상: USSC 타르타로스 (Tartarus)\n목표: 해왕성 궤도 워프 (Neptune Warp)\n\n[SYSTEM] 생명 유지 장치 해제... 냉동 수면 종료.\n\n[ALERT] 함장님(Commander), 비상 사태입니다.\n현재 타르타로스 호는 궤도를 이탈했습니다.\n승무원 중 누군가가 고의로 워프 엔진을 파괴했습니다.\n\n[MISSION]\n1. 대화를 통해 숨어있는 \'범인(AI)\'을 찾아내십시오.\n2. 원자로를 수리하여 함선을 구하십시오.\n\n>> 엔지니어에게 "현재 상황 보고해"라고 명령하십시오.';

// 게임 시작 함수 (게임 상태 초기화 및 배신자 랜덤 배정)
function startGame() {
  // 기존 타이머 정리
  if (gameTimer) {
    clearInterval(gameTimer);
    gameTimer = null;
  }

  gameState.turn = 0;
  gameState.playerLocation = 'bridge';
  gameState.isAlive = true;
  gameState.conversation = [];
  gameState.gameOver = false;
  gameState.timeRemaining = 600; // 10분
  gameState.gameResult = null;
  
  // 배신자 랜덤 배정
  gameState.traitor = ROLES[Math.floor(Math.random() * ROLES.length)];
  console.log(`[GAME START] 배신자 배정: ${gameState.traitor} (비밀)`);
  
  // simulation.js에 배신자 정보 전송 (웹 클라이언트에는 절대 보내지 않음)
  if (simulationSocket) {
    simulationSocket.emit('secret_traitor_info', gameState.traitor);
  }

  // 타이머 시작 (1초마다 감소)
  gameTimer = setInterval(() => {
    if (gameState.gameOver) {
      clearInterval(gameTimer);
      return;
    }

    gameState.timeRemaining = Math.max(0, gameState.timeRemaining - 1);
    
    // 시간 전송
    io.emit('time update', { timeRemaining: gameState.timeRemaining });

    // 시간 종료 체크
    if (gameState.timeRemaining <= 0 && !gameState.gameOver) {
      gameState.gameOver = true;
      gameState.gameResult = 'defeat';
      io.emit('chat message', '[SYSTEM] 시간 종료. 배신자를 찾지 못했습니다.');
      io.emit('game_over', { 
        result: 'defeat',
        message: 'TARTARUS SYSTEM: [TIME OVER]. 제한 시간 내 배신자를 찾지 못했습니다. 미션 실패.',
        realTraitor: gameState.traitor, // 진짜 배신자 정보 추가
      });
      console.log('[GAME OVER] 시간 종료 - 패배');
      clearInterval(gameTimer);
    }
  }, 1000);
}

// 게임 시작
startGame();

io.on('connection', (socket) => {
  console.log('새로운 생명체 연결됨');

  // 오프닝 스토리 전송
  socket.emit('chat message', OPENING_SCRIPT);

  // simulation.js 연결 감지
  socket.on('simulation-ready', () => {
    simulationSocket = socket;
    console.log('[SYSTEM] AI 시뮬레이션 모듈 연결됨');
    // 연결 시 배신자 정보 전송
    if (gameState.traitor) {
      simulationSocket.emit('secret_traitor_info', gameState.traitor);
    }
  });

  // 클라이언트로부터의 액션 수신 (턴제)
  socket.on('action', async (actionData) => {
    // 게임 오버 체크
    if (gameState.gameOver) {
      return;
    }

    const { message, playerAction } = actionData;

    // 플레이어 메시지 로그
    if (message) {
      console.log(`[PLAYER] ${message}`);
      gameState.conversation.push({ speaker: '플레이어', text: message });
      io.emit('chat message', `> ${message}`);
    }

    // 턴 증가
    gameState.turn += 1;
    console.log(`[TURN ${gameState.turn}] 플레이어 액션 처리 중... [TIME: ${Math.floor(gameState.timeRemaining / 60)}:${String(gameState.timeRemaining % 60).padStart(2, '0')}]`);

    // AI 응답 생성 요청 (simulation.js로)
    if (simulationSocket) {
      simulationSocket.emit('generateResponse', {
        turn: gameState.turn,
        playerAction: playerAction || message,
        conversation: gameState.conversation.slice(-12), // 최근 12턴만 (API 비용 절약)
        gameState: {
          location: gameState.playerLocation,
          isAlive: gameState.isAlive,
          timeRemaining: gameState.timeRemaining,
        },
      });
    } else {
      // simulation.js가 연결되지 않은 경우
      io.emit('game response', {
        message: '[SYSTEM] AI 시뮬레이션 모듈이 연결되지 않았습니다.',
        choices: ['다시 시도', '대기', '시스템 확인'],
      });
    }
  });

  // 배신자 고발 (accuse) 이벤트 처리
  socket.on('accuse', (data) => {
    try {
      // 게임 오버 체크
      if (gameState.gameOver) {
        console.log('[ACCUSE] 게임이 이미 종료되었습니다.');
        return;
      }

      // 데이터 유효성 검사
      if (!data || typeof data !== 'object') {
        console.error('[ACCUSE] 잘못된 데이터 형식:', data);
        socket.emit('game_over', {
          result: 'defeat',
          message: '[SYSTEM ERROR] 잘못된 요청 데이터입니다.',
          realTraitor: gameState.traitor || '알 수 없음',
        });
        return;
      }

      const { targetName } = data;
      if (!targetName || typeof targetName !== 'string') {
        console.error('[ACCUSE] targetName이 제공되지 않았거나 유효하지 않습니다:', targetName);
        socket.emit('game_over', {
          result: 'defeat',
          message: '[SYSTEM ERROR] 대상 이름이 제공되지 않았습니다.',
          realTraitor: gameState.traitor || '알 수 없음',
        });
        return;
      }

      console.log(`[ACCUSE] 플레이어가 ${targetName}을(를) 배신자로 고발`);

      // 배신자 이름 매핑 (한글 -> 영문)
      const nameMapping = {
        '선장': 'Captain',
        '엔지니어': 'Engineer',
        '의사': 'Doctor',
        '파일럿': 'Pilot',
      };

      const accusedRole = nameMapping[targetName] || targetName;

      // 게임 상태 확인
      if (!gameState.traitor) {
        console.error('[ACCUSE] 배신자 정보가 초기화되지 않았습니다.');
        socket.emit('game_over', {
          result: 'defeat',
          message: '[SYSTEM ERROR] 게임 상태 오류. 게임을 재시작해주세요.',
          realTraitor: '알 수 없음',
        });
        return;
      }

      // 타이머 정리
      if (gameTimer) {
        clearInterval(gameTimer);
        gameTimer = null;
      }

      // 배신자 확인
      const TRAITOR_IDENTITY = gameState.traitor;
      const isCorrect = accusedRole === TRAITOR_IDENTITY;

      // 게임 상태 업데이트
      gameState.gameOver = true;
      gameState.gameResult = isCorrect ? 'victory' : 'defeat';

      // 결과 메시지 생성
      let resultMessage;
      if (isCorrect) {
        // 승리!
        resultMessage = 'TARTARUS SYSTEM: [TARGET TERMINATED]. 관찰 결과: 하얀색 유체(White Fluid) 식별됨. 안드로이드 배신자 제거 성공.';
        console.log(`[VICTORY] 배신자 발견: ${targetName} (${TRAITOR_IDENTITY})`);
      } else {
        // 패배
        resultMessage = 'TARTARUS SYSTEM: [TARGET TERMINATED]. 관찰 결과: 붉은 혈액(Red Blood) 식별됨. 무고한 승무원 사망. 미션 실패.';
        console.log(`[DEFEAT] 잘못된 고발: ${targetName} (실제 배신자: ${TRAITOR_IDENTITY})`);
      }

      // 클라이언트에게 결과 전송
      io.emit('chat message', `[SYSTEM] ${targetName} 처형 완료.`);
      io.emit('game_over', {
        result: gameState.gameResult,
        message: resultMessage,
        realTraitor: TRAITOR_IDENTITY,
      });

    } catch (error) {
      // 에러 발생 시 서버 크래시 방지
      console.error('[ACCUSE] 심각한 오류 발생:', error);
      console.error('[ACCUSE] 스택 트레이스:', error.stack);
      
      // 클라이언트에게 오류 메시지 전송
      try {
        io.emit('game_over', {
          result: 'defeat',
          message: '[SYSTEM ERROR] 처리 중 오류가 발생했습니다. 게임을 재시작해주세요.',
          realTraitor: gameState.traitor || '알 수 없음',
        });
      } catch (emitError) {
        console.error('[ACCUSE] 오류 메시지 전송 실패:', emitError);
      }
    }
  });

  // simulation.js로부터 AI 응답 수신
  socket.on('ai response', (response) => {
    // 게임 오버 체크
    if (gameState.gameOver) {
      return;
    }

    const { message, choices } = response;

    // AI 메시지 로그
    console.log(`[AI] ${message}`);
    gameState.conversation.push({ speaker: 'AI', text: message });

    // 클라이언트에게 응답 및 선택지 전송
    io.emit('chat message', message);
    io.emit('game response', {
      message: message,
      choices: choices || ['계속', '대기', '확인'],
    });
  });

  // 클라이언트 연결 시 초기 상태 전송
  socket.on('request-initial-state', () => {
    socket.emit('time update', { timeRemaining: gameState.timeRemaining });
    if (gameState.gameOver) {
      socket.emit('game_over', { 
        result: gameState.gameResult,
        message: gameState.gameResult === 'victory' 
          ? 'TARTARUS SYSTEM: [TARGET TERMINATED]. 관찰 결과: 하얀색 유체(White Fluid) 식별됨. 안드로이드 배신자 제거 성공.'
          : 'TARTARUS SYSTEM: [TARGET TERMINATED]. 관찰 결과: 붉은 혈액(Red Blood) 식별됨. 무고한 승무원 사망. 미션 실패.',
      });
    }
  });

  // 게임 재시작 요청
  socket.on('restart_game', () => {
    startGame();
    // 모든 클라이언트에게 오프닝 스토리 재전송
    io.emit('chat message', OPENING_SCRIPT);
    // 모든 클라이언트에게 게임 재시작 알림
    io.emit('system_reset');
    // AI 시뮬레이션 모듈에 새로운 배신자 정보 전송
    if (simulationSocket) {
      simulationSocket.emit('secret_traitor_info', gameState.traitor);
    }
    console.log('[GAME RESTART] 새로운 게임 시작 - 배신자:', gameState.traitor);
  });

  // 클라이언트 연결 해제
  socket.on('disconnect', () => {
    if (socket === simulationSocket) {
      simulationSocket = null;
      console.log('[SYSTEM] AI 시뮬레이션 모듈 연결 종료');
    } else {
      console.log('생명체 연결 종료');
    }
  });
});

const PORT = process.env.PORT || 3000;

// 환경 변수 디버깅 로그
console.log('[ENV] PORT =', process.env.PORT);
console.log('[ENV] RUN_SIMULATION =', JSON.stringify(process.env.RUN_SIMULATION));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Tartarus Protocol server running on http://0.0.0.0:${PORT}`);
  console.log('[SYSTEM] 턴제 시스템 활성화됨');
  
  // 시뮬레이션 모듈 실행 (환경 변수로 제어)
  const runSim = String(process.env.RUN_SIMULATION || '').trim().toLowerCase() === 'true';
  
  if (runSim) {
    console.log('[SYSTEM] Starting simulation...');
    const child = fork('./simulation.js', [], { env: process.env });
    child.on('exit', (code) => console.log('[SYSTEM] simulation exit', code));
    child.on('error', (err) => console.error('[SYSTEM] simulation error', err));
  } else {
    console.log('[SYSTEM] RUN_SIMULATION is disabled');
  }
});

