# Tartarus — 텔레그램판 최종 QA 체크리스트

실기 테스트용 한 장 요약. 항목마다 **테스트 방법 → 기대 결과 → 실패 시 의심 포인트** 순으로 적음.

---

## 1. 현재 상태 요약

- [ ] **서버 권위형 코어**는 거의 완료 (엔진 + `matchStore` / `playerStore` 기준 상태가 권위).
- [ ] **텔레그램 봇 HTTP API**(`telegram/bot/bot.js`, 기본 포트 **8788**)와 **miniapp**(`telegram/miniapp/index.html`) 연동 경로는 구성됨.
- [ ] **LLM 대사**는 API 키·모델 설정 시 non-terminal 액션 배치에 연결됨; 미설정 시 deterministic fallback.
- [ ] **최종 확인이 필요한 영역**
  - [ ] 한국어 UX / 로그 / 결과
  - [ ] 영문 UX / 로그 / 결과
  - [ ] **DB 영구 저장** (현재 봇은 아래 §5 참고 — Supabase 미연결)
  - [ ] **Telegram 실기기** (WebApp URL, 모바일 UI)

---

## 2. 사전 준비

| 항목 | 체크 | 메모 |
|------|------|------|
| 봇 서버 실행 | [ ] | 예: 프로젝트 루트에서 `node telegram/bot/bot.js` (포트 8788) |
| miniapp 로드 | [ ] | `telegram/miniapp/index.html` 열기 또는 정적 서빙; API는 `http://localhost:8788` (같은 오리진이면 `API_BASE`가 `''`) |
| (선택) `localStorage` 초기화 | [ ] | DevTools → Application → Local Storage → 해당 오리진 삭제 후 `playerId`/언어 재설정 |
| 브랜치 / 커밋 확인 | [ ] | QA에 사용한 Git SHA 기록 |
| Telegram 실기기용 **공개 URL** | [ ] | HTTPS WebApp URL 없으면 텔레그램 클라이언트에서 miniapp 열기 불가 → 터널/호스팅 필요 여부 판단 |
| DB 검증 도구 | [ ] | **연결 후**: Supabase SQL / Table Editor. **현재 봇 경로**: DB 없음 → §5 |

---

## 3. 한국어 버전 QA 체크리스트

### 3.1 Intro 진입

- [ ] **테스트**: 앱 로드 후 인트로 스크롤/타이틀 확인 → `[ 시스템 기동 ]` 또는 동등 버튼으로 게임 화면 전환.
- [ ] **기대**: 인트로만 표시, 깨진 레이아웃 없음.
- [ ] **실패 시**: `intro-screen` / `game-screen` 전환 스크립트, 리소스 로드 오류.

### 3.2 기본 언어 (시작값 / 전환)

- [ ] **테스트**: 최초 진입 언어, `한국어` / `ENGLISH` 토글 후 새로고침·재진입 시 유지 여부(`localStorage`).
- [ ] **기대**: 선택 언어와 UI 라벨(버튼/브리핑) 일치.
- [ ] **실패 시**: `LANG_KEY`, `GAME_LABELS` 매핑, 토글 핸들러.

### 3.3 질문 (question)

- [ ] **테스트**: 자연어로 특정 승무원에게 질문 (또는 의도에 맞는 한국어 입력).
- [ ] **기대**: `[함장]` + 함장 발화, 이어서 크루 블록(닥터 등) 로그; LLM 켜면 한국어 반응, 꺼져도 deterministic 문장.
- [ ] **실패 시**: `intentParser`, `processMessageApi`, `getDialogueLlmKind`=`QUESTION`, 이벤트 배열.

### 3.4 의심 (suspect)

- [ ] **테스트**: 대상 지정 의심 발화.
- [ ] **기대**: `[함장]` + 의심 문구, 크루 반응 순서·헤더 정상.
- [ ] **실패 시**: `SUSPECT` 이벤트, LLM 검증 실패 시 fallback.

### 3.5 시스템 로그 확인 (check_log)

- [ ] **테스트**: 로그 확인 관련 입력 또는 UI에서 해당 액션에 해당하는 플로우.
- [ ] **기대**: `[함장]` + 확인 문구(또는 입력 반영), 엔지니어 중심 톤 등 LLM 규칙 또는 fallback.
- [ ] **실패 시**: `CHECK_LOG`, `captainInputLine` 옵션, `toPlayerDisplayLogs`.

### 3.6 위협 (threaten)

- [ ] **테스트**: 위협 모달에서 대상 선택 → 확정.
- [ ] **기대**: `[함장]` + 위협 문구, 타깃/비타깃 크루 반응(복창 금지 규칙은 LLM 경로).
- [ ] **실패 시**: `/api/action` `threaten` + `target`, `THREATEN` 이벤트.

### 3.7 단서 수집 (collect_clue)

- [ ] **테스트**: 단서 수집 버튼/연동 액션 실행.
- [ ] **기대**: `[함장]` + 행동 줄, `[시스템]` + 단서 본문(엔진 값) 유지.
- [ ] **실패 시**: `FIND_CLUE`, `mergeFindClueDeterministicClue`, `clue_text`.

### 3.8 권총 획득 (take_pistol)

- [ ] **테스트**: 권총 획득 액션 실행(버튼 → `/api/action` `take_pistol`).
- [ ] **기대**: `[함장]` + 본문(기본 `권총을 획득했다.` 등), 이어서 크루 4인 반응(LLM) 또는 fallback 두 줄 구조.
- [ ] **실패 시**: `TAKE_PISTOL` in `getDialogueLlmKind`, `toPlayerDisplayLogs` 함장 블록.

### 3.9 처형 프로토콜 (accuse)

- [ ] **테스트**: 처형 모달에서 생존 대상 선택 → 확정.
- [ ] **기대**: 게임 규칙에 맞는 사망/승패 전개, 로그에 처형·사망·결과 반영.
- [ ] **실패 시**: `/api/accuse`, `ACCUSE` / `DEATH`, `game_over`.

### 3.10 Auto-kill

- [ ] **테스트**: 규칙상 자동 사망이 발생하는 시나리오(시간·조건은 기획 기준).
- [ ] **기대**: `[시스템]` 등 플레이어 로그에 사망 통지, `dead_roles` 갱신.
- [ ] **실패 시**: `kills` / 엔진 이벤트 순서, `updateStatus` 반영.

### 3.11 Dead role — 버튼 비활성 / 사망 표시

- [ ] **테스트**: 사망 발생 후 처형·위협 모달 재오픈, 상단 dead 표시 확인.
- [ ] **기대**: 사망 역할 버튼 비활성·라벨에 사망 표기, 선택 불가.
- [ ] **실패 시**: `isRoleDead`, `applyDeadStateToModalButtons`, `game_state.dead_roles`.

### 3.12 Pending → idle 복귀

- [ ] **테스트**: 메시지/액션 전송 직후 배너(크루 반응 중 등) → 응답 완료 후.
- [ ] **기대**: 잠시 후 idle 문구(예: 함장 입력 대기), 입력 가능.
- [ ] **실패 시**: `userActionPending`, `captainUserActionLockSeq`, fetch `finally`.

### 3.13 입력 잠금 / 해제

- [ ] **테스트**: pending 중 전송·액션 연타; 게임 오버 후 입력.
- [ ] **기대**: pending·game over 시 잠금, 정상 시 해제.
- [ ] **실패 시**: `input-area` `disabled`, `userActionPending`, `isGameOver`.

### 3.14 Restart

- [ ] **테스트**: 게임 종료 후 `새 매치 시작` 등 restart.
- [ ] **기대**: 새 세션 로그, 타이머·상태 초기화, `match_id` 갱신(응답/헤더에서 확인).
- [ ] **실패 시**: `/api/start` `restart: true`, `clearGameLogPanelAndState` 연동.

### 3.15 역할 색상 (게임 로그)

- [ ] **테스트**: `[함장]`…`[파일럿]` 및 연속 대사 줄 색 구분.
- [ ] **기대**: 헤더·본문·내레이션이 동일 역할 색 계열; 시스템/타이머 레드 정책 유지.
- [ ] **실패 시**: `data-role`, `lastLogBlockRole`, `#game-screen .log-panel` CSS 변수.

### 3.16 결과 모달

- [ ] **테스트**: 승/패 및 기타 종료 시 모달.
- [ ] **기대**: 제목·설명· outcome 행(해당 시) 한국어 일관.
- [ ] **실패 시**: `showResultModal`, `result-modal` 클래스·텍스트.

### 3.17 actual_imposter 표시

- [ ] **테스트**: 게임 종료 후 결과 UI에서 임포스터 공개 여부(기획: game_over 시에만).
- [ ] **기대**: API `actual_imposter`와 UI 표시 일치(노출 정책 준수).
- [ ] **실패 시**: `match.impostor_role` / `hidden_host_role` 폴백, 미니앱 `result-imposter` 분기.

---

## 4. 영문 버전 QA 체크리스트

### 4.1 Intro / 버튼 / 상태 문구

- [ ] **테스트**: `ENGLISH` 선택 후 인트로·게임 화면 라벨 전부 스캔.
- [ ] **기대**: 영어로 일관; 한글 잔존 없음(의도된 혼용 제외).
- [ ] **실패 시**: `GAME_LABELS.en`, 누락 키.

### 4.2 영어 상태 문구 자연스러움

- [ ] **테스트**: 함장 입력 대기 / 크루 반응 중 등 status 한 줄 읽기.
- [ ] **기대**: 문법·어색하지 않은 짧은 문장.
- [ ] **실패 시**: `refreshCaptainPhaseStatusUi`, 번역 문자열.

### 4.3 액션 흐름 (질문 / 의심 / 로그 / 위협 / 단서 / 권총 / 처형)

- [ ] **테스트**: §3와 동일 시나리오를 영문 UI·영어 입력(또는 지원되는 EN 의도)으로 반복.
- [ ] **기대**: 로그 헤더는 역할 브래킷 정책 유지(`[Captain]` 등 표시 규칙은 miniapp 매핑에 따름); 흐름 동일.
- [ ] **실패 시**: `mapBracketInnerToLogRole`, 파서 EN 토큰.

### 4.4 역할 헤더 표시 방식

- [ ] **테스트**: 영문 모드에서 로그 스크롤.
- [ ] **기대**: `[Captain]` / `[Doctor]` 등 표시가 깨지지 않고 가독성 유지.
- [ ] **실패 시**: `canonicalBracketHeaderFromTypeString` / LLM 출력 혼합.

### 4.5 결과 모달 영어

- [ ] **테스트**: 게임 종료 후 모달.
- [ ] **기대**: 영어 라벨·본문.
- [ ] **실패 시**: 결과 모달 i18n 키.

### 4.6 Restart 후 영어 유지

- [ ] **테스트**: EN에서 restart.
- [ ] **기대**: 재시작 후에도 EN 유지(`localStorage`).
- [ ] **실패 시**: `doStart` / 초기화 시 `lang` 리셋 여부.

### 4.7 영문 LLM 대사 품질

- [ ] **테스트**: LLM 켜진 상태에서 여러 액션 실행.
- [ ] **기대**: 영어 브리핑이면 한국어 섞임 최소; 계약 JSON 내 텍스트가 요구 역할에 맞음.
- [ ] **실패 시**: `buildDialogueSystemPrompt` 한국어 고정 여부 — **현재 코어 프롬프트는 한국어 중심**이면 EN 품질 이슈는 알려진 제한일 수 있음.

### 4.8 Fallback 시 영어 로그 품질

- [ ] **테스트**: API 키 제거 또는 LLM 실패 유도 후 동일 액션.
- [ ] **기대**: deterministic 문장이 영어 UI와 동시에 읽기 가능(혼용이면 기록만).
- [ ] **실패 시**: `toPlayerDisplayLogs` 고정 한글 문자열.

---

## 5. DB 로그 저장 검증 체크리스트

### 중요 전제 (권위 구조)

- [ ] **텔레그램 봇(`telegram/bot/bot.js`)은 `core/state/matchStore.js` + `core/state/playerStore.js`를 사용**한다. 구현은 **인메모리 `Map`** 이며 **Supabase에 쓰지 않는다.** 프로세스 재시작 시 매치/플레이어 상태는 소실된다.
- [ ] **리포지토리에 존재하는 Supabase 연동 예시**는 **`api/ep1/store.js`** — 테이블 **`ep1_matches`**, **`ep1_events`** (주석에 컬럼 설명 있음: `match_id`, `turn`, `game_over`, `outcome`, `hidden_host_role`, `private_state` 등 / 이벤트는 `actor`, `role`, `action`, `target`, `dialogue`, `server_result` 등). **이 경로는 현재 텔레그램 봇과 연결되어 있지 않다.**
- [ ] **별도**: `api/play.js`는 `match_logs` 등 다른 용도 — 텔레그램 EP1과 직접 동일하지 않을 수 있음.
- [ ] 아래 항목은 **Supabase(또는 동등 영속 계층)를 텔레그램 봇에 연결한 뒤** 수행하거나, **연결 전에는 “연결 후 검증 예정”**으로만 체크한다. 스키마가 합쳐질 때 **실제 테이블·컬럼명은 구현 PR 기준으로 재확인**할 것.

### 5.1 새 match 생성 시 저장 여부

- [ ] **테스트 방법**: 영속 계층 연결 후 `/api/start` 또는 첫 매치 생성 → DB에서 해당 `match_id` 조회.
- [ ] **기대 결과**: 행 생성(또는 설계된 키로 조회 가능).
- [ ] **실패 시 의심**: 어댑터 미호출, upsert 조건, `match_id` 소스 불일치.

### 5.2 액션별 저장 (question / suspect / check_log / threaten / collect_clue / take_pistol / accuse)

- [ ] **테스트 방법**: 액션마다 1회씩 수행 후 이벤트 테이블(또는 JSON 배열 컬럼) 조회.
- [ ] **기대 결과**: 타입·순서·내용이 엔진 이벤트와 대응.
- [ ] **실패 시 의심**: `appendEvent` 미연동, 배치 단위 누락, LLM 전용 display log만 클라이언트에 있고 서버 미기록.

### 5.3 game_over / outcome 저장

- [ ] **테스트 방법**: 게임 종료 후 매치 행의 종료 플래그·결과 필드 확인 (`game_state` 또는 설계된 `outcome` 컬럼).
- [ ] **기대 결과**: 종료 시점과 UI outcome 일치.
- [ ] **실패 시 의심**: `updateMatch` 패치 누락, 스키마 필드명 불일치.

### 5.4 dead_roles 저장

- [ ] **테스트 방법**: 처형/사망 후 저장소의 사망 배열 확인.
- [ ] **기대 결과**: `dead_roles`와 UI 동일.
- [ ] **실패 시 의심**: JSON 병합 오류, 이전 턴 덮어쓰기.

### 5.5 actual_imposter / impostor_role / hidden_host_role

- [ ] **테스트 방법**: 게임 종료 후 API 응답과 DB 비교 (`impostor_role`, `hidden_host_role` 등 실제 저장 필드명은 **구현 확인 필요**).
- [ ] **기대 결과**: 공개 정책에 맞게 노출·저장.
- [ ] **실패 시 의심**: 종료 전에만 쓰기, 마스킹 누락.

### 5.6 restart 후 새 match_id

- [ ] **테스트 방법**: restart 전후 `match_id` / PK 비교.
- [ ] **기대 결과**: 새 세션 = 새 id(설계가 그렇다면).
- [ ] **실패 시 의심**: `getOrCreateMatch` 키 재사용, player 매핑 미갱신.

### 5.7 match 단위 구분

- [ ] **테스트 방법**: 두 플레이어 또는 연속 두 매치의 데이터가 섞이지 않는지 조회.
- [ ] **기대 결과**: `match_id`별 격리.
- [ ] **실패 시 의심**: 전역 캐시, 잘못된 FK.

### 5.8 turn / event 누락

- [ ] **테스트 방법**: 연속 턴 액션 후 이벤트 개수·`turn` 단조 증가 여부.
- [ ] **기대 결과**: 누락 없음.
- [ ] **실패 시 의심**: 트랜잭션 실패 무시, dedupe 과도 적용.

### 5.9 중복 저장

- [ ] **테스트 방법**: 동일 액션 재시도·폴링 이중 기록 여부.
- [ ] **기대 결과**: 의도된 idempotency 또는 중복 제거.
- [ ] **실패 시 의심**: 클라이언트 재전송, 서버 이중 `appendEvent`.

### 5.10 영문·한글 로그 저장 시 깨짐

- [ ] **테스트 방법**: 한글·영어·특수문자 섞인 `dialogue`/로그 필드 insert 후 조회.
- [ ] **기대 결과**: UTF-8 그대로.
- [ ] **실패 시 의심**: DB 인코딩, 잘못된 escape, 바이너리 컬럼 타입.

---

## 6. Telegram 실기기 스모크 테스트

- [ ] **공개 HTTPS URL**으로 WebApp이 열리는가 (localhost 불가).
- [ ] Telegram 앱에서 **miniapp 실행** (봇 메뉴/버튼 링크).
- [ ] **모바일 UI**: 스크롤, 모달, 하단 입력 가림 없음.
- [ ] **pending / idle 배너**: 전송 후 대기 문구 → 해제.
- [ ] **입력 잠금**: 응답 대기 중 오동작 없음.
- [ ] **액션**: 질문 / 의심 / 로그 확인 / 위협 / 단서 / 권총 / 처형 / restart 한 사이클 이상.
- [ ] **결과 모달** 노출·닫기.
- [ ] **사망 역할** 버튼 비활성.
- [ ] **색상 가독성** (실내 밝기·OLED 기준 스쳐보기).

---

## 7. Go / No-Go 기준

**Go (텔레그램 시연·실험 가능)**

- [ ] 봇 + miniapp이 **동일 API 베이스**로 연결됨.
- [ ] 한국어 기준 **시작→핵심 액션 1회→종료 또는 restart** 무크리티컬 버그 없음.
- [ ] LLM 없어도 **fallback**으로 시연 가능.

**No-Go (막는 버그)**

- [ ] 매치 생성/메시지 API **5xx** 또는 CORS/혼합 콘텐츠로 WebApp 빈 화면.
- [ ] 처형/종료 후 **소프트락**(입력 영구 불가).
- [ ] **게임 규칙 오판정**(잘못된 즉시 승패) — 의도와 다를 때.

**시연 가능 (완화)**

- [ ] 영문 카피 일부 어색, LLM 품질 편차 → **기록 후 Go** 가능.
- [ ] DB 미연결 → **기능 시연은 Go**, “영구 로그”만 No-Go로 표시.

---

## 8. 오늘 상태 결론 (짧게)

- [ ] **지금 당장 텔레그램 실험**: 공개 URL·봇 토큰·WebApp URL만 갖추면 **로컬과 동일 API로 실기 스모크 가능**. 영속 DB는 **봇 경로에 없음** → 재시작 시 상태 초기화.
- [ ] **반드시 확인할 것**: (1) **KO 핵심 플로우** §3, (2) **EN 표면** §4, (3) **실기** §6, (4) DB는 **연결 설계 확정 후** §5.

---

*문서 버전: 저장소 기준 텔레그램 봇 = 인메모리 스토어; Supabase 테이블명은 `api/ep1/store.js` 주석 및 코드 기준.*
