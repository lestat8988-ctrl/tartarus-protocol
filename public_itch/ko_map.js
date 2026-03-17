/**
 * ko_map.js - English → Korean line mapping for Tartarus Protocol
 * Usage: window.__KO_MAP[key] || key  (매핑 없으면 원문 출력)
 */
(function () {
  function translateFragments(s) {
    if (!s || typeof s !== 'string') return s;
    return s
      .replace(/The autopsy bay was accessed\.\s*Someone was dissecting something\./gi, '부검실 접근 기록이 있습니다. 누군가 무언가를 해부하고 있었습니다.')
      .replace(/Autopsy\s+bay\s+malfunction\./ig, '부검실 시스템 오작동.')
      .replace(/Robotic\s+systems\s+engaged\./ig, '로봇 시스템 가동.')
      .replace(/Machinery\s+accident\s+in\s+engine\s+room\.?/ig, '기관실 기계 사고.')
      .replace(/Conveyor\s+incident\.?/ig, '컨베이어 사고.')
      .replace(/에어락\s+근처에서\s+봤어\./g, '에어락 근처에서 봤습니다.')
      .replace(/그들은\.\.\.\s*이상해\s+보였어\./g, '그들은... 이상해 보였습니다.')
      /* 반말 → 존댓말 통일 (witness 등) */
      .replace(/로그를 조작했어\./g, '로그를 조작했습니다.')
      .replace(/접근 권한이 있어\./g, '접근 권한이 있습니다.')
      .replace(/있는 걸 봤어\./g, '있는 걸 봤습니다.')
      .replace(/혼잣말을 하고 있어요\./g, '혼잣말을 하고 있었습니다.')
      .replace(/진단을 돌렸어\./g, '진단을 돌렸습니다.')
      .replace(/이상해\./g, '이상합니다.')
      .replace(/몰라\./g, '모릅니다.')
      .replace(/추측해\./g, '추측하십시오.')
      .replace(/아니면 죽어\./g, '아니면 죽습니다.')
      .replace(/변경했어\./g, '변경했습니다.')
      .replace(/데려왔어\./g, '데려왔습니다.')
      .replace(/빙의했어\./g, '빙의했습니다.')
      .replace(/알아\?/g, '압니까?')
      .replace(/보여\./g, '보입니다.')
      .replace(/될 수 있어!/g, '될 수 있습니다.')
      .replace(/열려 있어\./g, '열려 있습니다.')
      .replace(/필요해\./g, '필요합니다.')
      .replace(/바닥나고 있어\./g, '바닥나고 있습니다.')
      .replace(/찾아\./g, '찾으십시오.')
      .replace(/수리하자\./g, '수리하겠습니다.')
      .replace(/들려\./g, '들렸습니다.')
      .replace(/들렸어\./g, '들렸습니다.')
      .replace(/환각이야\./g, '환각입니다.')
      .replace(/진짜야\./g, '진짜입니다.')
      .replace(/영리해\./g, '영리합니다.')
      .replace(/숨어 있어\./g, '숨어 있습니다.')
      .replace(/먹고 있어\./g, '먹고 있습니다.')
      .replace(/제거해야 해\./g, '제거해야 합니다.')
      .replace(/타버려\./g, '타버립니다.')
      .replace(/용의자야\./g, '용의자입니다.')
      .replace(/이용할 수 있어\./g, '이용할 수 있습니다.')
      .replace(/알아\./g, '압니다.')
      .replace(/해부하고 있었어\./g, '해부하고 있었습니다.')
      .replace(/시험하고 있어\./g, '시험하고 있습니다.')
      .replace(/제거하고 있어\./g, '제거하고 있습니다.')
      .replace(/미쳐가고 있어\./g, '미쳐가고 있습니다.')
      .replace(/찾아야 해\./g, '찾아야 합니다.')
      .replace(/너무 늦기 전에\./g, '너무 늦기 전입니다.')
      .replace(/원했어요\./g, '원했습니다.')
      .replace(/Bulkhead\s+collapse\./ig, '격벽 붕괴.') // PATCH
      .replace(/High-impact\s+trauma\./ig, '생체 신호: 0.') // PATCH
      .replace(/Airlock\s+seal\s+failure\./ig, '에어락 밀봉 실패.') // PATCH
      .replace(/Pressure\s+differential\./ig, '기압차.') // PATCH
      .replace(/Body\s+recovered\s+from\s+corridor\./ig, '회수 불가.')
      .replace(/\[End of execution\]/ig, '[처리 종료]')
      /* 새 채널 템플릿 (CCTV/sync/nav/ENGINE/time) */
      .replace(/\[SYSTEM\]\s*CCTV logs corrupted\.\s*Partial data recovered\./gi, '[SYSTEM] cctv 로그 손상. 일부 데이터만 복구되었습니다.')
      .replace(/\[SYSTEM\]\s*CCTV timestamp anomaly:\s*(\d{2}:\d{2})\.\s*Partial recovery\./gi, '[SYSTEM] cctv 타임스탬프 이상: $1. 일부만 복구됨.')
      .replace(/\[SYSTEM\]\s*CCTV footage: corridor 7\.\s*\[REDACTED\] at (\d{2}:\d{2})\./gi, '[SYSTEM] cctv 영상: 복도 7. [삭제됨] $1.')
      .replace(/\[SYSTEM\]\s*CCTV: engine room access logged at (\d{2}:\d{2})\.\s*Identity redacted\./gi, '[SYSTEM] cctv: 기관실 접근 $1 기록. 신원 삭제됨.')
      .replace(/\[SYSTEM\]\s*CCTV fragment: \[REDACTED\] near airlock at (\d{2}:\d{2})\./gi, '[SYSTEM] cctv 조각: [삭제됨] 에어락 근처 $1.')
      .replace(/\[SYSTEM\]\s*Sync channel: nominal\.\s*No unauthorized access in time window\./gi, '[SYSTEM] sync 채널: 정상. 해당 시간대 무단 접근 없음.')
      .replace(/\[SYSTEM\]\s*Access log: \[REDACTED\] — sync query at (\d{2}:\d{2})\.\s*Clearance unknown\./gi, '[SYSTEM] 접속 로그: [삭제됨] — sync 쿼리 $1. 권한 불명.')
      .replace(/\[SYSTEM\]\s*Sync channel checksum nominal\.\s*No anomaly\./gi, '[SYSTEM] sync 채널 체크섬 정상. 이상 없음.')
      .replace(/\[SYSTEM\]\s*Log fragment: \[REDACTED\] accessed sync terminal at (\d{2}:\d{2})\.\s*Verified\./gi, '[SYSTEM] 로그 조각: [삭제됨]이 $1에 sync 터미널에 접근. 확인됨.')
      .replace(/\[SYSTEM\]\s*Interrogate logs: no anomaly\.\s*All statements within protocol\./gi, '[SYSTEM] 심문 로그: 이상 없음. 모든 진술 프로토콜 준수.')
      .replace(/\[SYSTEM\]\s*Nav channel: \[REDACTED\] accessed nav terminal at (\d{2}:\d{2})\.\s*Partial recovery\./gi, '[SYSTEM] nav 채널: [삭제됨]이 $1에 nav 터미널 접근. 일부만 복구됨.')
      .replace(/\[SYSTEM\]\s*Access log: \[REDACTED\] — nav query at (\d{2}:\d{2})\.\s*Clearance unknown\./gi, '[SYSTEM] 접속 로그: [삭제됨] — nav 쿼리 $1. 권한 불명.')
      .replace(/\[SYSTEM\]\s*Nav channel checksum nominal\.\s*No anomaly in time window\./gi, '[SYSTEM] nav 채널 체크섬 정상. 해당 시간대 이상 없음.')
      .replace(/\[SYSTEM\]\s*Log fragment: \[REDACTED\] accessed nav channel at (\d{2}:\d{2})\.\s*Verified\./gi, '[SYSTEM] 로그 조각: [삭제됨]이 $1에 nav 채널 접근. 확인됨.')
      .replace(/\[SYSTEM\]\s*Gravity Drive log: access at (\d{2}:\d{2})\.\s*Source redacted\./gi, '[SYSTEM] 중력 구동 로그: $1 접근 기록. 출처 삭제됨.')
      .replace(/\[SYSTEM\]\s*Engine room log: reactor stable at (\d{2}:\d{2})\.\s*No unauthorized access\./gi, '[SYSTEM] 기관실 로그: $1 기준 원자로 안정. 무단 접근 없음.')
      .replace(/\[SYSTEM\]\s*Reactor damage: CRITICAL\.\s*Repair impossible while entity presence detected\./gi, '[SYSTEM] 원자로 손상: 치명적. 실체 존재 감지 중 수리 불가.')
      .replace(/\[SYSTEM\]\s*Reactor readings nominal\.\s*Access record at (\d{2}:\d{2})\./gi, '[SYSTEM] 원자로 수치 정상. $1 접근 기록.')
      .replace(/\[SYSTEM\]\s*Engine room seal intact\.\s*No breach at (\d{2}:\d{2})\./gi, '[SYSTEM] 기관실 밀봉 정상. $1 침입 없음.')
      .replace(/\[SYSTEM\]\s*Core access log: (\d{2}:\d{2})\.\s*The thing is feeding on the core\./gi, '[SYSTEM] 코어 접근 로그: $1. 실체가 코어를 섭취 중.')
      .replace(/\[SYSTEM\]\s*Time channel: \[REDACTED\] accessed at (\d{2}:\d{2})\.\s*Logs confirm\./gi, '[SYSTEM] time 채널: [삭제됨]이 $1에 접근. 로그 확인됨.')
      .replace(/\[SYSTEM\]\s*Timestamp anomaly: (\d{2}:\d{2})\.\s*Partial data recovered\./gi, '[SYSTEM] 타임스탬프 이상: $1. 일부 데이터만 복구됨.')
      .replace(/\[SYSTEM\]\s*Time sync nominal\.\s*No drift at (\d{2}:\d{2})\./gi, '[SYSTEM] time 동기화 정상. $1 드리프트 없음.')
      .replace(/\[SYSTEM\]\s*Chronometer log: access at (\d{2}:\d{2})\.\s*Verified\./gi, '[SYSTEM] 크로노미터 로그: $1 접근. 확인됨.')
      .replace(/\[SYSTEM\]\s*Time channel checksum nominal\.\s*No anomaly\./gi, '[SYSTEM] time 채널 체크섬 정상. 이상 없음.')
      /* sync 추가 */
      .replace(/\[SYSTEM\]\s*Sync terminal access at (\d{2}:\d{2})\.\s*Source redacted\./gi, '[SYSTEM] sync 터미널 접근 $1. 출처 삭제됨.')
      .replace(/\[SYSTEM\]\s*Sync checksum mismatch in window (\d{2}:\d{2})\.\s*Investigating\./gi, '[SYSTEM] sync 체크섬 불일치 $1 구간. 조사 중.')
      .replace(/\[SYSTEM\]\s*Corridor logs: sync query at (\d{2}:\d{2})\.\s*Identity withheld\./gi, '[SYSTEM] 복도 로그: sync 쿼리 $1. 신원 비공개.')
      .replace(/\[SYSTEM\]\s*Sync channel: partial log at (\d{2}:\d{2})\.\s*No breach detected\./gi, '[SYSTEM] sync 채널: $1 부분 로그. 침입 미감지.')
      .replace(/\[SYSTEM\]\s*Unauthorized sync access attempt at (\d{2}:\d{2})\.\s*Blocked\./gi, '[SYSTEM] sync 무단 접근 시도 $1. 차단됨.')
      /* CCTV 추가 */
      .replace(/\[SYSTEM\]\s*CCTV feed gap: (\d{2}:\d{2})\.\s*Partial frames only\./gi, '[SYSTEM] cctv 피드 공백: $1. 일부 프레임만.')
      .replace(/\[SYSTEM\]\s*CCTV: corridor 3 motion at (\d{2}:\d{2})\.\s*Source unknown\./gi, '[SYSTEM] cctv: 복도 3 동작 $1. 출처 불명.')
      .replace(/\[SYSTEM\]\s*CCTV damage log: sector 5 at (\d{2}:\d{2})\.\s*Recovering\./gi, '[SYSTEM] cctv 손상 로그: 5구역 $1. 복구 중.')
      .replace(/\[SYSTEM\]\s*CCTV blind spot: (\d{2}:\d{2})\.\s*No coverage in sector\./gi, '[SYSTEM] cctv 사각: $1. 해당 구역 미촬영.')
      .replace(/\[SYSTEM\]\s*CCTV override detected at (\d{2}:\d{2})\.\s*Audit trail redacted\./gi, '[SYSTEM] cctv 오버라이드 감지 $1. 감사 추적 삭제됨.')
      /* nav 추가 */
      .replace(/\[SYSTEM\]\s*Nav terminal query at (\d{2}:\d{2})\.\s*Identity withheld\./gi, '[SYSTEM] nav 터미널 쿼리 $1. 신원 비공개.')
      .replace(/\[SYSTEM\]\s*Navigation logs: unauthorized access at (\d{2}:\d{2})\./gi, '[SYSTEM] 항법 로그: 무단 접근 $1.')
      .replace(/\[SYSTEM\]\s*Nav channel drift check at (\d{2}:\d{2})\.\s*Nominal\./gi, '[SYSTEM] nav 채널 드리프트 검사 $1. 정상.')
      .replace(/\[SYSTEM\]\s*Waypoint query at (\d{2}:\d{2})\.\s*\[REDACTED\]\. Verified\./gi, '[SYSTEM] 웨이포인트 쿼리 $1. [삭제됨]. 확인됨.')
      .replace(/\[SYSTEM\]\s*Nav checksum: anomaly at (\d{2}:\d{2})\.\s*Under review\./gi, '[SYSTEM] nav 체크섬: $1 이상. 검토 중.')
      /* ENGINE 추가 */
      .replace(/\[SYSTEM\]\s*Engine room: pressure nominal at (\d{2}:\d{2})\.\s*Seal verified\./gi, '[SYSTEM] 기관실: $1 기압 정상. 밀봉 확인됨.')
      .replace(/\[SYSTEM\]\s*Reactor coolant flow at (\d{2}:\d{2})\.\s*Within spec\./gi, '[SYSTEM] 원자로 냉각수 유량 $1. 규격 내.')
      .replace(/\[SYSTEM\]\s*Engine room entry at (\d{2}:\d{2})\.\s*\[REDACTED\]\. Logged\./gi, '[SYSTEM] 기관실 $1 입실 기록. [삭제됨].')
      .replace(/\[SYSTEM\]\s*Core breach scan at (\d{2}:\d{2})\.\s*Negative\./gi, '[SYSTEM] 코어 침입 스캔 $1. 음성.')
      .replace(/\[SYSTEM\]\s*Engine room hatch: sealed at (\d{2}:\d{2})\.\s*No tampering\./gi, '[SYSTEM] 기관실 해치: $1 밀봉됨. 변조 없음.')
      .replace(/\[SYSTEM\]\s*Maintenance log: reactor output fluctuation at (\d{2}:\d{2})\.\s*Within tolerance\./gi, '[SYSTEM] 정비 로그: 원자로 출력 변동 $1. 허용 범위 내.')
      .replace(/\[SYSTEM\]\s*Cooling system response: nominal at (\d{2}:\d{2})\.\s*No anomaly\./gi, '[SYSTEM] 냉각계통 응답: $1 정상. 이상 없음.')
      .replace(/\[SYSTEM\]\s*Engine room bulkhead status at (\d{2}:\d{2})\.\s*Sealed\./gi, '[SYSTEM] 기관실 격벽 상태 $1. 밀봉됨.')
      /* time 추가 */
      .replace(/\[SYSTEM\]\s*Time sequence mismatch at (\d{2}:\d{2})\.\s*Order corrupted\./gi, '[SYSTEM] time 순서 불일치 $1. 순서 손상됨.')
      .replace(/\[SYSTEM\]\s*Chrono drift at (\d{2}:\d{2})\.\s*Investigating\./gi, '[SYSTEM] 크로노 드리프트 $1. 조사 중.')
      .replace(/\[SYSTEM\]\s*Time channel: \[REDACTED\] query at (\d{2}:\d{2})\.\s*Source redacted\./gi, '[SYSTEM] time 채널: [삭제됨] 쿼리 $1. 출처 삭제됨.')
      .replace(/\[SYSTEM\]\s*Timestamp out of order at (\d{2}:\d{2})\.\s*Audit required\./gi, '[SYSTEM] 타임스탬프 순서 이상 $1. 감사 필요.')
      .replace(/\[SYSTEM\]\s*Time sync checksum: anomaly at (\d{2}:\d{2})\.\s*Partial recovery\./gi, '[SYSTEM] time 동기화 체크섬: $1 이상. 일부만 복구됨.')
      .replace(/\[SYSTEM\]\s*Timeline inconsistency: (\d{2}:\d{2})\.\s*Record gap detected\./gi, '[SYSTEM] 시간축 불일치: $1. 기록 공백 감지됨.')
      .replace(/\[SYSTEM\]\s*Timestamp reversal at (\d{2}:\d{2})\.\s*Sequence corrupted\./gi, '[SYSTEM] 타임스탬프 역전 $1. 순서 손상됨.')
      .replace(/\[SYSTEM\]\s*Chrono log fragment: (\d{2}:\d{2})\.\s*Partial recovery\./gi, '[SYSTEM] 크로노 로그 조각: $1. 일부만 복구됨.')
      /* 채널 표기 통일: 소문자 nav/sync/time/cctv/engine */
      .replace(/Sync 채널/g, 'sync 채널')
      .replace(/Nav 채널/g, 'nav 채널')
      .replace(/Time 채널/g, 'time 채널')
      .replace(/Sync 터미널/g, 'sync 터미널')
      .replace(/Nav 터미널/g, 'nav 터미널')
      .replace(/CCTV 채널/g, 'cctv 채널')
      .replace(/Engine 채널/g, 'engine 채널')
      /* 조사 자연화: 이(가) -> 이, (이)가 -> 가 */
      .replace(/이\(가\)/g, '이')
      .replace(/\(이\)가/g, '가')
      .replace(/\>\>\s*\[(?:interrogate|cctv|engine|sync|nav|time)\]/gi, '')
      .replace(/\[REDACTED\]/g, '[삭제됨]');
  }

  var M = {
    // --- [SYSTEM] Access log / Checksum mismatch 2줄 템플릿 (primary evidence)
    "[SYSTEM] Access log: Navigator — unauthorized sync query at 02:47": "[SYSTEM] 접속 로그: 네비게이터 — sync 쿼리 무단 조회 02:47",
    "[SYSTEM] Access log: Navigator — unauthorized nav query at 02:47": "[SYSTEM] 접속 로그: 네비게이터 — nav 쿼리 무단 조회 02:47",
    "[SYSTEM] Access log: Navigator — unauthorized time query at 02:47": "[SYSTEM] 접속 로그: 네비게이터 — time 쿼리 무단 조회 02:47",
    "[SYSTEM] Access log: Engineer — unauthorized sync query at 02:47": "[SYSTEM] 접속 로그: 엔지니어 — sync 쿼리 무단 조회 02:47",
    "[SYSTEM] Access log: Engineer — unauthorized nav query at 02:47": "[SYSTEM] 접속 로그: 엔지니어 — nav 쿼리 무단 조회 02:47",
    "[SYSTEM] Access log: Engineer — unauthorized time query at 02:47": "[SYSTEM] 접속 로그: 엔지니어 — time 쿼리 무단 조회 02:47",
    "[SYSTEM] Access log: Doctor — unauthorized sync query at 02:47": "[SYSTEM] 접속 로그: 닥터 — sync 쿼리 무단 조회 02:47",
    "[SYSTEM] Access log: Doctor — unauthorized nav query at 02:47": "[SYSTEM] 접속 로그: 닥터 — nav 쿼리 무단 조회 02:47",
    "[SYSTEM] Access log: Doctor — unauthorized time query at 02:47": "[SYSTEM] 접속 로그: 닥터 — time 쿼리 무단 조회 02:47",
    "[SYSTEM] Access log: Pilot — unauthorized sync query at 02:47": "[SYSTEM] 접속 로그: 파일럿 — sync 쿼리 무단 조회 02:47",
    "[SYSTEM] Access log: Pilot — unauthorized nav query at 02:47": "[SYSTEM] 접속 로그: 파일럿 — nav 쿼리 무단 조회 02:47",
    "[SYSTEM] Access log: Pilot — unauthorized time query at 02:47": "[SYSTEM] 접속 로그: 파일럿 — time 쿼리 무단 조회 02:47",
    "[SYSTEM] Checksum mismatch on sync channel — source: Navigator": "[SYSTEM] sync 채널 체크섬 불일치 — 출처: 네비게이터",
    "[SYSTEM] Checksum mismatch on sync channel — source: Engineer": "[SYSTEM] sync 채널 체크섬 불일치 — 출처: 엔지니어",
    "[SYSTEM] Checksum mismatch on sync channel — source: Doctor": "[SYSTEM] sync 채널 체크섬 불일치 — 출처: 닥터",
    "[SYSTEM] Checksum mismatch on sync channel — source: Pilot": "[SYSTEM] sync 채널 체크섬 불일치 — 출처: 파일럿",
    "[SYSTEM] Checksum mismatch on nav channel — source: Navigator": "[SYSTEM] nav 채널 체크섬 불일치 — 출처: 네비게이터",
    "[SYSTEM] Checksum mismatch on nav channel — source: Engineer": "[SYSTEM] nav 채널 체크섬 불일치 — 출처: 엔지니어",
    "[SYSTEM] Checksum mismatch on nav channel — source: Doctor": "[SYSTEM] nav 채널 체크섬 불일치 — 출처: 닥터",
    "[SYSTEM] Checksum mismatch on nav channel — source: Pilot": "[SYSTEM] nav 채널 체크섬 불일치 — 출처: 파일럿",
    "[SYSTEM] Checksum mismatch on time channel — source: Navigator": "[SYSTEM] time 채널 체크섬 불일치 — 출처: 네비게이터",
    "[SYSTEM] Checksum mismatch on time channel — source: Engineer": "[SYSTEM] time 채널 체크섬 불일치 — 출처: 엔지니어",
    "[SYSTEM] Checksum mismatch on time channel — source: Doctor": "[SYSTEM] time 채널 체크섬 불일치 — 출처: 닥터",
    "[SYSTEM] Checksum mismatch on time channel — source: Pilot": "[SYSTEM] time 채널 체크섬 불일치 — 출처: 파일럿",
    // 추가 시간 변형 (01:58, 02:31, 03:12, 04:03, 00:15)
    "[SYSTEM] Access log: Navigator — unauthorized sync query at 02:31": "[SYSTEM] 접속 로그: 네비게이터 — sync 쿼리 무단 조회 02:31",
    "[SYSTEM] Access log: Engineer — unauthorized sync query at 02:31": "[SYSTEM] 접속 로그: 엔지니어 — sync 쿼리 무단 조회 02:31",
    "[SYSTEM] Access log: Doctor — unauthorized sync query at 02:31": "[SYSTEM] 접속 로그: 닥터 — sync 쿼리 무단 조회 02:31",
    "[SYSTEM] Access log: Pilot — unauthorized sync query at 02:31": "[SYSTEM] 접속 로그: 파일럿 — sync 쿼리 무단 조회 02:31",
    "[SYSTEM] Access log: Navigator — unauthorized nav query at 02:31": "[SYSTEM] 접속 로그: 네비게이터 — nav 쿼리 무단 조회 02:31",
    "[SYSTEM] Access log: Engineer — unauthorized nav query at 02:31": "[SYSTEM] 접속 로그: 엔지니어 — nav 쿼리 무단 조회 02:31",
    "[SYSTEM] Access log: Doctor — unauthorized nav query at 02:31": "[SYSTEM] 접속 로그: 닥터 — nav 쿼리 무단 조회 02:31",
    "[SYSTEM] Access log: Pilot — unauthorized nav query at 02:31": "[SYSTEM] 접속 로그: 파일럿 — nav 쿼리 무단 조회 02:31",
    "[SYSTEM] Access log: Navigator — unauthorized time query at 02:31": "[SYSTEM] 접속 로그: 네비게이터 — time 쿼리 무단 조회 02:31",
    "[SYSTEM] Access log: Engineer — unauthorized time query at 02:31": "[SYSTEM] 접속 로그: 엔지니어 — time 쿼리 무단 조회 02:31",
    "[SYSTEM] Access log: Doctor — unauthorized time query at 02:31": "[SYSTEM] 접속 로그: 닥터 — time 쿼리 무단 조회 02:31",
    "[SYSTEM] Access log: Pilot — unauthorized time query at 02:31": "[SYSTEM] 접속 로그: 파일럿 — time 쿼리 무단 조회 02:31",

    // --- 승/패 핵심 문장
    "Wrong target. The entity laughs. You killed an innocent. DEFEAT.": "처형 대상 오류. 무고자 사망. 패배.", // PATCH
    "Real Imposter Identity Code: [Navigator]": "실제 임포스터 신원 코드: [네비게이터]",
    "Real Imposter Identity Code: [Engineer]": "실제 임포스터 신원 코드: [엔지니어]",
    "Real Imposter Identity Code: [Doctor]": "실제 임포스터 신원 코드: [닥터]",
    "Real Imposter Identity Code: [Pilot]": "실제 임포스터 신원 코드: [파일럿]",
    "The host convulses. Something shrieks as it flees the body. Android lubricant. VICTORY.": "호스트 제거. 생체 신호: 0. 승리.", // PATCH
    "[EMERGENCY ALERT] Target purged. White fluid detected. Entity expelled. [RESULT: VICTORY]": "[긴급 경보] 처리 완료. 승리.", // PATCH
    "[EMERGENCY ALERT] Innocent crew executed. The real imposter watches. DEFEAT.": "[긴급 경보] 무고자 사망. 패배.", // PATCH

    // --- PRIMARY OBJECTIVE / Command // PATCH
    "[PRIMARY OBJECTIVE]": "[주요 목표]", // PATCH
    "1. Find the 'HOST' (Imposter) hiding in human skin.": "1. 인간의 피부 속에 숨어 있는 'HOST'(임포스터)를 찾아라.", // PATCH
    "2. Execute the traitor before the ship returns to Hell.": "2. 함선이 지옥으로 돌아가기 전에 배신자를 처형하라.", // PATCH
    ">> Command: \"Report ship status.\"": ">> 명령: \"함선 상태를 보고하라.\"", // PATCH

    // --- Interrogate/CCTV/Engine 자주 나오는 문장
    "Navigator: Captain, I've been monitoring the corridors. Someone has been tampering with the logs.": "네비게이터: 함장, 복도를 감시해왔습니다. 누군가 로그를 조작하고 있습니다.",
    "Engineer: Don't look at me! The Doctor's been acting strange since the jump.": "엔지니어: 저를 보지 마십시오. 점프 이후 닥터가 이상합니다.", // PATCH
    "Doctor: Stress affects us all. The Pilot has been muttering to himself.": "닥터: 스트레스는 우리 모두에게 영향을 줍니다. 파일럿이 혼잣말을 하고 있었습니다.",
    "Pilot: We're all losing it. The ship... it's watching.": "파일럿: 우리 모두 미쳐가고 있습니다. 함선이... 우릴 지켜보고 있습니다.",
    "System: [SYSTEM] Hull breach in sector 7. Sealed. For now.": "시스템: [SYSTEM] 7구역 선체 손상. 밀봉됨. 당분간.",
    "Engineer: It's testing us. Picking us off.": "엔지니어: 우릴 시험하고 있습니다. 하나씩 제거하고 있습니다.",
    "Navigator: We have to find the host.": "네비게이터: 호스트를 찾아야 합니다.",
    "Doctor: Before there's no one left.": "닥터: 아무도 남지 않기 전입니다.",
    "System: [SYSTEM] CCTV logs corrupted. Partial data recovered.": "시스템: [SYSTEM] cctv 로그 손상. 일부 데이터 복구됨.",
    "Navigator: I see someone near the engine room. Before the last kill.": "네비게이터: 엔진실 근처에 누군가 보입니다. 마지막 살인 전입니다.",
    "Engineer: That could be any of us!": "엔지니어: 우리 중 누구든 될 수 있습니다.",
    "Doctor: The timestamps are wrong. Something altered them.": "닥터: 타임스탬프가 잘못됐습니다. 무언가가 변경했습니다.",
    "Doctor: The Engineer's vitals have been off. Since the jump.": "닥터: 엔지니어 생체 신호가 비정상입니다. 점프 이후부터입니다.", // PATCH
    "System: [SYSTEM] Log fragment: [REDACTED] accessed Gravity Drive at 02:47.": "시스템: [SYSTEM] 로그 조각: [삭제됨] 02:47에 중력 드라이브 접근.",
    "Pilot: Who has that clearance?": "파일럿: 그 권한을 가진 사람이 누구입니까?",
    "Navigator: All senior crew. We're all suspects.": "네비게이터: 모든 고급 승무원. 우리 모두 용의자입니다.",
    "Doctor: The entity is clever. It hides in our skin.": "닥터: 실체는 영리합니다. 우리 피부 속에 숨어 있습니다.",
    "System: [SYSTEM] Reactor damage: CRITICAL. Repair impossible while entity presence detected.": "시스템: [SYSTEM] 원자로 손상: 치명적. 실체 존재 감지 중 수리 불가.",
    "Engineer: The thing is feeding on the core. We have to purge the host first.": "엔지니어: 그게 코어를 먹고 있습니다. 먼저 호스트를 제거해야 합니다.",
    "Navigator: Execute the imposter. Seal the rift. Or we all burn.": "네비게이터: 임포스터를 처형하십시오. 균열을 봉인하십시오. 아니면 우리 모두 타버립니다.",
    "Doctor: Captain, the crew's psychological profiles—one of us has changed. Since the jump.": "닥터: 함장… 심리 프로필이 무너졌습니다. 점프 이후, 우리 중 한 명이 변했습니다.", // PATCH
    "Navigator: The entity rewrites the host. They look human. They're not.": "네비게이터: 놈이 숙주를 덮어씁니다. 겉은 인간… 안은 아닙니다.", // PATCH
    "Engineer: So we're hunting a ghost in a meat suit.": "엔지니어: 결론은… 사람 얼굴을 한 놈을 사냥하는 겁니다.", // PATCH
    "Pilot: And it's hunting us.": "파일럿: 반대로, 놈도 우리를 고르고 있습니다.", // PATCH
    /* INTERROGATE 전용 (void/ignore/observe/act 등) */
    "Pilot: Captain, the void is calling. I hear it. We all do.": "파일럿: 함장, 공허가 부르고 있습니다. 모두가 듣고 있습니다.",
    "Doctor: Ignore it. Focus on the mission.": "닥터: 무시하십시오. 임무에 집중하십시오.",
    "Engineer: Easy for you to say. You're not the one it's whispering to.": "엔지니어: 말은 쉽습니다. 속삭임을 듣는 쪽은 제가 아닙니다.",
    "Navigator: Stay focused. Find the imposter.": "네비게이터: 집중하십시오. HOST를 찾아야 합니다.",
    "Navigator: Captain, we need to act. The entity is among us.": "네비게이터: 함장, 행동해야 합니다. 실체가 우리 안에 있습니다.",
    "Engineer: But which one?": "엔지니어: 누구입니까?",
    "Doctor: Observe. The possessed one will slip.": "닥터: 관찰하십시오. 빙의된 자가 실수할 것입니다.",
    "Pilot: Or we all die waiting.": "파일럿: 아니면 기다리다 전멸합니다.",
    "Engineer: Captain, I've checked the reactor. The rift is still open. Something is feeding on it.": "엔지니어: 함장, 원자로를 점검했습니다. 균열이 아직 열려 있습니다. 무언가가 섭취 중입니다.",
    "Navigator: We're running out of time.": "네비게이터: 시간이 바닥나고 있습니다.",
    "Doctor: Find the host. Purge it. Then we can seal the breach.": "닥터: HOST를 찾으십시오. 제거하십시오. 그다음 균열을 봉인할 수 있습니다.",
    "Pilot: Or we all get pulled back to... wherever it came from.": "파일럿: 아니면 우리 모두... 그게 온 곳으로 끌려갑니다.",
    "Engineer: Captain, the rift is still open. I can try to seal it—but I need time.": "엔지니어: 함장, 균열이 아직 열려 있습니다. 봉인을 시도할 수 있지만—시간이 필요합니다.",
    "Navigator: You mean kill you. Like the others.": "네비게이터: 당신을 죽이라는 거지. 다른 사람들처럼.",
    "Doctor: We're running out of crew. And time.": "닥터: 승무원이 바닥나고 있습니다. 시간도.",
    "Pilot: Find the imposter. Then we repair.": "파일럿: 임포스터를 찾으십시오. 그다음 수리하겠습니다.",
    "Engineer: Captain, the engine room—something's wrong. I heard scratching. From inside the walls.": "엔지니어: 함장, 엔진실—뭔가 이상합니다. 긁는 소리가 들렸습니다. 벽 안에서.",
    "Doctor: Hallucinations. The warp exposure...": "닥터: 환각입니다. 워프 노출이...",
    "Navigator: Or it's real. One of us brought it back.": "네비게이터: 아니면 진짜입니다. 우리 중 누군가가 그걸 데려왔습니다.",
    "Pilot: We need to find who. Before it's too late.": "파일럿: 누군지 찾아야 합니다. 너무 늦기 전입니다.",
    "Doctor: Captain, I've run diagnostics. The crew's vitals are... off. One of us isn't fully human anymore.": "닥터: 함장, 진단을 돌렸습니다. 승무원 생체 신호가... 이상합니다. 우리 중 한 명은 더 이상 완전한 인간이 아닙니다.",
    "Navigator: The entity. It possessed someone.": "네비게이터: 실체. 누군가에게 빙의했습니다.",
    "Engineer: How do we know who?": "엔지니어: 정체 확인 불가. 로그로만 좁힐 수 있습니다.",
    "Pilot: We don't. We guess. Or we die.": "파일럿: 확인 불가. 추측하거나 전멸합니다.",
    "Navigator: I saw them near the airlock. Right before the alarm. They looked... wrong.": "네비게이터: 에어락 근처에서 봤습니다. 경보 직전에. 그들은... 이상해 보였습니다.",
    "Navigator: I saw someone near the airlock. The logs were tampered.": "네비게이터: 함장, 에어락 근처에서 누군가를 봤습니다. 로그가 조작돼 있습니다.", // PATCH
    "Pilot: The Engineer was alone with the core. Plenty of time to sabotage.": "파일럿: 엔지니어가 코어와 단둘이 있었습니다. 사보타주할 시간은 충분했습니다.", // PATCH
    "Doctor: I saw the Pilot near the engine room. Before the incident.": "닥터: 사고 전에 파일럿이 엔진실 근처에 있는 걸 봤습니다.",
    "Navigator: Someone tampered with the logs. The Engineer has access.": "네비게이터: 누군가 로그를 조작했습니다. 엔지니어가 접근 권한이 있습니다.",
    "Navigator: Someone tampered with the logs. Engineer has access.": "네비게이터: 누군가 로그를 조작했습니다. 엔지니어가 접근 권한이 있습니다.",
    "Navigator: The Doctor was acting erratic. I don't trust them.": "네비게이터: 닥터의 행동이 불안정합니다. 신뢰할 수 없습니다.", // PATCH
    "Pilot: Navigator's too calm. Too controlled. Like they're wearing a mask.": "파일럿: 네비게이터가 너무 차분합니다. 너무 통제되어 있습니다. 마스크를 쓴 것 같습니다.",
    "Doctor: Navigator's claustrophobia—someone could exploit that. The entity knows our fears.": "닥터: 네비게이터의 밀실 공포증—누군가 그걸 이용할 수 있습니다. 실체는 우리의 두려움을 압니다.",
    "Engineer: Navigator's been watching us. Recording. Why?": "엔지니어: 네비게이터가 우리를 감시하고 있습니다. 기록 중입니다. 왜죠?", // PATCH
    "Engineer: The Doctor's been in the autopsy bay too much. Alone.": "엔지니어: 닥터가 부검실에 너무 오래 있었습니다. 늘 혼자였습니다.", // PATCH
    "Pilot: Doctor's been dissecting something. Not the bodies. Something else.": "파일럿: 닥터가 뭔가를 해부하고 있었습니다. 시체가 아닙니다. 다른 무언가입니다.",
    "Doctor: The autopsy bay was accessed. Someone was dissecting something.": "닥터: 부검실 접근 기록이 있습니다. 누군가 무언가를 해부하고 있었습니다.",
    "The autopsy bay was accessed. Someone was dissecting something.": "부검실 접근 기록이 있습니다. 누군가 무언가를 해부하고 있었습니다.",
    "Navigator: The warp signature was corrupted before we jumped.": "네비게이터: 점프 전에 워프 시그니처가 손상됐습니다.",
    "Engineer: The reactor damage pattern suggests external interference.": "엔지니어: 원자로 손상 패턴이 외부 간섭을 시사합니다.",
    "Engineer: Someone accessed the core at 02:47. Clearance logs are missing.": "엔지니어: 누군가 02:47에 코어에 접근했습니다. 출입 로그가 없습니다.",
    "Doctor: Vitals show one crew member has anomalous readings since the jump.": "닥터: 생체 신호에 점프 이후 이상 수치가 있는 승무원이 한 명 있습니다.",
    "Pilot: Bulkhead seals were manually overridden. Someone wanted an exit.": "파일럿: 격벽 밀봉이 수동으로 해제됐습니다. 누군가 탈출을 원했습니다.",
    "Pilot: I heard scratching from inside the walls. Near the engine room.": "파일럿: 벽 안에서 긁는 소리가 들렸습니다. 엔진실 근처입니다.",
    "Navigator: The Doctor has been in the autopsy bay alone too often.": "네비게이터: 닥터가 부검실에 혼자 너무 자주 있었습니다.",
    "Engineer: The Pilot was near the engine room before the last kill.": "엔지니어: 마지막 살인 전에 파일럿이 엔진실 근처에 있었습니다.",
    "Engineer: Gravity Drive logs show unauthorized access.": "엔지니어: 중력 드라이브 로그에 무단 접근이 기록돼 있습니다.",
    "[EMERGENCY ALERT] Doctor terminated. Autopsy bay malfunction. Robotic systems engaged.": "[긴급 경보] 닥터 사망. 부검실 이상. 로봇 시스템 가동.", // PATCH
    "[EMERGENCY ALERT] Navigator terminated. Airlock seal failure. Pressure differential. Body recovered from corridor.": "[긴급 경보] 네비게이터 사망. 에어락 밀봉 실패. 압력 이상. 회수 불가.", // PATCH
    "[EMERGENCY ALERT] Engineer terminated. Machinery accident in engine room. Conveyor incident.": "[긴급 경보] 엔지니어 사망. 기관실 기계 사고. 컨베이어 사고.",
    "[EMERGENCY ALERT] Engineer terminated. Machinery accident in engine room. Conveyor incident. [End of execution]": "[긴급 경보] 엔지니어 사망. 기관실 기계 사고. 컨베이어 사고. [처리 종료]",
    "[EMERGENCY ALERT] Pilot terminated. Bulkhead collapse. High-impact trauma.": "[긴급 경보] 파일럿 사망. 격벽 붕괴. 생체 신호: 0.", // PATCH
    "[WITNESS TESTIMONY INCOMING]": "[목격자 증언 수신 중]",
    "[End of execution]": "[처리 종료]", // PATCH
    "[EMERGENCY ALERT]": "[긴급 경보]" // PATCH
  };

  function translateRole(role) {
    var k = String(role || '').trim().toLowerCase();
    if (k === 'navigator') return '네비게이터'; if (k === 'engineer') return '엔지니어';
    if (k === 'doctor') return '닥터'; if (k === 'pilot') return '파일럿';
    return role;
  }

  /** 받침 있으면 "이", 없으면 "가" (주격 조사) */
  function josaIga(roleKo) {
    if (!roleKo || typeof roleKo !== 'string') return '가';
    var last = roleKo.charAt(roleKo.length - 1);
    var c = last.charCodeAt(0);
    if (c >= 0xAC00 && c <= 0xD7A3) {
      var jong = (c - 0xAC00) % 28;
      return jong !== 0 ? '이' : '가';
    }
    return '가';
  }

  var PATTERNS = [ // PATCH
    { re: /^\[SYSTEM\]\s*Suspicious activity:\s*(Navigator|Engineer|Doctor|Pilot)\s+near\s+(\S+)\s+terminal\s+at\s+(\d{2}:\d{2})$/i, fn: function(m) { var r = translateRole(m[1]); return '[SYSTEM] 수상한 활동: ' + r + josaIga(r) + ' ' + m[3] + '에 ' + m[2] + ' 터미널 근처에 있었습니다.'; } },
    { re: /^\[SYSTEM\]\s*Log fragment:\s*(Navigator|Engineer|Doctor|Pilot)\s+accessed\s+(\S+)\s+channel\s+at\s+(\d{2}:\d{2})\.\s*Verified\.$/i, fn: function(m) { return '[SYSTEM] 로그 조각: ' + translateRole(m[1]) + ' ' + m[3] + '에 ' + m[2] + ' 채널 접근. 확인됨.'; } },
    { re: /^\[SYSTEM\]\s*Security flag:\s*(Navigator|Engineer|Doctor|Pilot)\s+accessed\s+(\S+)\s+.*at\s+(\d{2}:\d{2})/i, fn: function(m) { return '[SYSTEM] 보안 플래그: ' + translateRole(m[1]) + ' ' + m[3] + '에 ' + m[2] + ' 접근.'; } },
    { // PATCH
      re: /^System:\s*\[EMERGENCY ALERT\]\s*(Navigator|Engineer|Doctor|Pilot)\s+terminated\.\s*(.+)$/i, // PATCH
      fn: function(m) { // PATCH
        var role = m[1]; // PATCH
        var rest = m[2]; // PATCH
        // 영어 사망 원인 → 한국어 치환 (조각 단위 우선, 기존 전체 패턴 유지) // PATCH
        rest = rest
          .replace(/Autopsy bay malfunction\.?/i, '부검실 시스템 오작동.')
          .replace(/Robotic systems engaged\.?/i, '로봇 시스템 가동.')
          .replace(/Machinery accident in engine room\.?/i, '기관실 기계 사고.')
          .replace(/Conveyor incident\.?/i, '컨베이어 사고.')
          .replace(/Airlock seal failure\.?/i, '에어락 밀봉 실패.')
          .replace(/Pressure differential\.?/i, '기압차.')
          .replace(/\[End of execution\]/gi, '[처리 종료]')
          .replace(/Bulkhead collapse\.\s*High-impact trauma\.?/i, '격벽 붕괴. 생체 신호: 0.')
          .replace(/Airlock seal failure\.\s*Pressure differential\.\s*Body recovered from corridor\.?/i, '에어락 밀봉 실패. 기압차. 회수 불가.')
          .replace(/Machinery accident in engine room\.?\s*Conveyor incident\.?/i, '기관실 기계 사고. 컨베이어 사고.')
          .replace(/Autopsy bay malfunction\.\s*Robotic systems engaged\.?/i, '부검실 시스템 오작동. 로봇 시스템 가동.');
        return '시스템: [긴급 경보] ' + translateRole(role) + ' 사망. ' + rest; // PATCH
      } // PATCH
    }, // PATCH
    { // PATCH
      re: /^(?:\[긴급 경보\]\s*)?시스템:\s*\[긴급 경보\]\s*(네비게이터|엔지니어|닥터|파일럿)\s*사망\.\s*(.+)$/i, // PATCH
      fn: function(m) { // PATCH
        var roleKo = m[1]; // PATCH
        var rest = m[2]; // PATCH
        // 영어 조각 → 한국어 조각 치환 (조각 단위) // PATCH
        rest = rest
          .replace(/Autopsy bay malfunction\.?/i, '부검실 시스템 오작동.')
          .replace(/Robotic systems engaged\.?/i, '로봇 시스템 가동.')
          .replace(/Machinery accident in engine room\.?/i, '기관실 기계 사고.')
          .replace(/Conveyor incident\.?/i, '컨베이어 사고.')
          .replace(/Bulkhead collapse\.?/i, '격벽 붕괴.')
          .replace(/High-impact trauma\.?/i, '생체 신호: 0.')
          .replace(/Airlock seal failure\.?/i, '에어락 밀봉 실패.')
          .replace(/Pressure differential\.?/i, '기압차.')
          .replace(/Body recovered from corridor\.?/i, '회수 불가.')
          .replace(/\[End of execution\]/gi, '[처리 종료]');
        return '시스템: [긴급 경보] ' + roleKo + ' 사망. ' + rest; // PATCH
      } // PATCH
    }, // PATCH
    {
      re: /^(Navigator|Engineer|Doctor|Pilot):\s*I heard the (Navigator|Engineer|Doctor|Pilot) muttering\.\s*In a language that wasn't human\.$/i,
      fn: function(m) {
        var s = translateRole(m[1]);
        var t = translateRole(m[2]);
        return s + ': 함장, ' + t + josaIga(t) + ' 중얼거리는 걸 들었습니다. 인간의 언어가 아니었습니다.';
      }
    },
    { // PATCH
      re: /^(Navigator|Engineer|Doctor|Pilot):\s*The\s+(Navigator|Engineer|Doctor|Pilot)'s\s+vitals\s+have\s+been\s+off\.\s*Since\s+the\s+jump\.$/i, // PATCH
      fn: function(m) { // PATCH
        return translateRole(m[1]) + ': ' + translateRole(m[2]) + ' 생체 신호가 비정상입니다. 점프 이후부터.'; // PATCH
      } // PATCH
    }, // PATCH
    { // PATCH
      re: /^(Navigator|Engineer|Doctor|Pilot) was in the (.+) during the incident\. Logs confirm\.$/, // PATCH
      fn: function(m) { // PATCH
        var place = m[2]; // PATCH
        place = place.replace(/\bbridge\b/i, '함교') // PATCH
                 .replace(/\bengine room\b/i, '엔진실') // PATCH
                 .replace(/\bmed bay\b/i, '의무실') // PATCH
                 .replace(/\bhangar\b/i, '격납고') // PATCH
                 .replace(/\bcorridor\b/i, '복도'); // PATCH
        return translateRole(m[1]) + '는 사건 당시 ' + place + '에 있었습니다. 로그 확인됨.'; // PATCH
      } // PATCH
    } // PATCH
  ]; // PATCH

  window.__KO_MAP = M;
  window.__KO_PATTERNS = PATTERNS;
  window.__KO_TRANSLATE_FRAGMENTS = translateFragments;
  window.__KO_ROLE = translateRole;
  window.__KO_JOSA_IGA = josaIga;

  function applyFragmentsToTranslate() { // PATCH
    if (window.__KO_TRANSLATE) { // PATCH
      var orig = window.__KO_TRANSLATE; // PATCH
      window.__KO_TRANSLATE = function(line) { var out = orig(line); return translateFragments(out); }; // PATCH
    } // PATCH
  } // PATCH
  if (document.readyState === 'complete') applyFragmentsToTranslate(); // PATCH
  else window.addEventListener('load', applyFragmentsToTranslate); // PATCH
})();
