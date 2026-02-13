/**
 * Localization Dictionary - Tartarus Protocol
 * Change LANG to 'ko' for Korean. Add ko strings when ready.
 */
const LANG = 'en';

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
      accuseBtn: "[ INITIATE PURGE PROTOCOL (ACCUSE) ]",
      restart: "REBOOT SYSTEM",
      buttons: {
        interrogate: "INTERROGATE CREW",
        cctv: "CHECK CCTV LOGS",
        engine: "CHECK ENGINE ROOM"
      },
      accuseModal: {
        title: "SELECT TARGET FOR ELIMINATION",
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
    }
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
      accuseBtn: "[ 처형 프로토콜 실행 (ACCUSE) ]",
      restart: "시스템 재부팅",
      buttons: {
        interrogate: "승무원 심문",
        cctv: "CCTV 로그 확인",
        engine: "엔진실 확인"
      },
      accuseModal: {
        title: "처형 대상 선택",
        cancel: "취소",
        deceased: "[사망] "
      }
    },
    opening: {
      boot: "[시스템 부팅 시퀀스...]",
      target: "Target: USSC Tartarus (Prototype Vessel)",
      mission: "Mission: PROJECT 'HORIZON' - Gravity Drive Test",
      location: "Location: Neptune Orbit (Edge of Solar System)",
      criticalFailure: "[치명적 고장]",
      gateway: "The Gravity Drive opened a gateway to... somewhere else.",
      broughtBack: "We brought something back with us.",
      primaryObjective: "[주요 목표]",
      objective1: "1. Find the 'HOST' (Imposter) hiding in human skin.",
      objective2: "2. Execute the traitor before the ship returns to Hell.",
      command: ">> Command: \"Report ship status.\""
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
    }
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
