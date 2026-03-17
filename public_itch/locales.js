/**
 * Localization Dictionary - Tartarus Protocol
 * Change LANG to 'ko' for Korean. Add ko strings when ready.
 */

/**
 * Localization - Tartarus Protocol
 * Game uses static data (game-data.js). No API required for itch.io.
 */
const LANG = (typeof window !== 'undefined' && window.__LANG) || 'en'; // PATCH: lang=ko URL 지원

const textData = {
  en: {
    intro: {
      pressEnter: "[ PRESS ENTER TO INITIALIZE PROTOCOL ]",
      supportHint: "Support the Developer ($2) ↓",
      bootLines: [
        "BIOS DATE 02/22/75 17:15:00 VER 1.02",
        "CPU: NEC V20, SPEED: 8 MHz",
        "640K RAM SYSTEM... OK",
        "LOADING TARTARUS KERNEL... OK",
        "MOUNTING DRIVE A:... OK"
      ]
    },
    game: {
      title: "TARTARUS PROTOCOL v4.0 (GLOBAL)",
      timerPrefix: "TIME UNTIL TOTAL SHIP COLLAPSE : ",
      clock: "[TIME] 10:00",
      placeholder: "Enter command...",
      inputHint: "Ask the crew a question, or enter terminal keywords (nav/time/sync) to retrieve system logs.",
      accuseBtn: "[ INITIATE PURGE PROTOCOL (ACCUSE) ]",
      restart: "REBOOT SYSTEM",
      buttons: {
        interrogate: "INTERROGATE CREW",
        cctv: "CHECK CCTV LOGS",
        engine: "CHECK ENGINE ROOM"
      },
      accuseModal: {
        title: "SELECT TARGET FOR ELIMINATION",
        instruction: "Choose one target. One bullet only. No second chance.",
        cancel: "CANCEL",
        deceased: "[DECEASED] "
      }
    },
    opening: {
      boot: "[SYSTEM BOOT SEQUENCE...]",
      target: "Target: USSC Tartarus (Prototype Vessel)",
      mission: "Mission: PROJECT 'HORIZON' - Gravity Drive Test",
      location: "Location: Neptune Orbit (Edge of Solar System)",
      criticalFailure: "[CRITICAL FAILURE]",
      gateway: "The Gravity Drive opened a gateway to... somewhere else.",
      broughtBack: "We brought something back with us.",
      primaryObjective: "[PRIMARY OBJECTIVE]",
      objective1: "1. Find the 'HOST' (Imposter) hiding in human skin.",
      objective2: "2. Execute the traitor before the ship returns to Hell.",
      command: ">> Command: \"Report ship status.\""
    },
    result: {
      victory: {
        title: "MISSION ACCOMPLISHED",
        desc: "Ship secured. Imposter eliminated.",
        imposterPrefix: "IDENTIFIED IMPOSTER: "
      },
      defeat: {
        title: "MISSION FAILED. CREW TERMINATED.",
        desc: "Innocent crew member executed. Ship destroyed.",
        imposterPrefix: "THE REAL IMPOSTER WAS: "
      },
      support: "Did you enjoy the horror? Please support the dev via the [Support This Game] button below!"
    },
    system: {
      totalFailure: "[TOTAL SYSTEM FAILURE]",
      allTerminated: "All crew members have been terminated.",
      missionFailed: "Mission failed. Ship destroyed."
    },
    apiMessages: {
      interrogate: "Interrogate crew",
      cctv: "Check CCTV logs",
      engine: "Check engine room"
    },
    apiError: "Connection error. Please try again."
  },
  ko: {
    intro: {
      pressEnter: "[ 엔터를 눌러 프로토콜 초기화 ]",
      supportHint: "Support the Developer ($2) ↓",
      bootLines: [
        "BIOS DATE 02/22/75 17:15:00 VER 1.02",
        "CPU: NEC V20, SPEED: 8 MHz",
        "640K RAM SYSTEM... OK",
        "LOADING TARTARUS KERNEL... OK",
        "MOUNTING DRIVE A:... OK"
      ]
    },
    game: {
      title: "TARTARUS PROTOCOL v4.0 (GLOBAL)",
      timerPrefix: "함선 붕괴까지 : ",
      clock: "[TIME] 10:00",
      placeholder: "명령 입력...",
      inputHint: "크루에게 질문하거나, 터미널 키워드(nav/time/sync)를 입력해 시스템 로그를 조회하십시오.",
      accuseBtn: "[ 처형 프로토콜 실행 (ACCUSE) ]",
      restart: "시스템 재부팅",
      buttons: {
        interrogate: "승무원 심문",
        cctv: "CCTV 로그 확인",
        engine: "엔진실 확인"
      },
      accuseModal: {
        title: "처형 대상 선택",
        instruction: "처형 대상 1명을 선택하십시오. 탄환은 1발뿐입니다.",
        cancel: "취소",
        deceased: "[사망] "
      }
    },
    opening: {
      boot: "[시스템 기동…]", // PATCH
      target: "대상 함선: USSC 타르타로스(프로토타입)", // PATCH
      mission: "임무: 프로젝트 'HORIZON' — 중력 드라이브 실험", // PATCH
      location: "현 위치: 해왕성 궤도(태양계 외곽)", // PATCH
      criticalFailure: "[치명적 오류]", // PATCH
      gateway: "중력 드라이브가 '여기가 아닌 곳'과 연결됐다.", // PATCH
      broughtBack: "귀환 신호에… 동승자가 섞였다.", // PATCH
      primaryObjective: "[주요 목표]", // PATCH
      objective1: "1. 승무원 얼굴을 한 HOST(숙주)를 찾아라.", // PATCH
      objective2: "2. 시간이 끝나기 전에 처형하라.", // PATCH
      command: ">> 명령: \"함선 상태 보고.\"" // PATCH
    },
    result: {
      victory: {
        title: "미션 성공",
        desc: "함선 확보. 임포스터 제거됨.",
        imposterPrefix: "확인된 임포스터: "
      },
      defeat: {
        title: "미션 실패. 승무원 전원 사망.",
        desc: "무고한 승무원이 처형당했습니다. 함선 파괴됨.",
        imposterPrefix: "진짜 임포스터: "
      },
      support: "재밌게 즐기셨다면, 게임 화면 아래의 [Support This Game] 버튼으로 개발자를 후원해주세요!"
    },
    system: {
      totalFailure: "[전체 시스템 고장]",
      allTerminated: "모든 승무원이 사망했습니다.",
      missionFailed: "미션 실패. 함선 파괴됨."
    },
    apiMessages: {
      interrogate: "Interrogate crew",
      cctv: "Check CCTV logs",
      engine: "Check engine room"
    },
    apiError: "연결 오류. 다시 시도해 주세요."
  }
};

function t(key) {
  const keys = key.split('.');
  let val = textData[LANG] || textData.en;
  for (const k of keys) {
    val = val?.[k];
  }
  if (val === undefined) {
    val = keys.reduce((o, k) => o?.[k], textData.en);
  }
  return val !== undefined ? val : key;
}
window.textData = textData;
window.t = t;
window.LANG = LANG;
console.log("[BOOT] locales.js loaded", !!window.textData);
