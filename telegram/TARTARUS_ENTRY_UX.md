# Tartarus 진입 UX 정리 (Vercel 정렬)

디자인은 텔레그램 miniapp 스타일 유지, **내용/문구/흐름은 Vercel public/index.html·locales.js와 동일**.

---

## 1. Intro 내용이 Vercel판과 맞춰진 방식

### OPENING_LINES

- `public/index.html`의 `OPENING_LINES`와 **동일한 라인 구조** 사용
- 라인 배열을 그대로 반영 (빈 줄 `" "`, `[하데스 경보]`, `[주요 목표]` 섹션 포함)
- ko: 시스템 기동, 대상 함선, 임무, 현 위치, 하데스 경보 4줄, 주요 목표 3줄
- en: SYSTEM INITIALIZE, Target vessel, Mission, Location, HADES ALERT 4줄, PRIMARY OBJECTIVES 3줄

### 렌더링

- `renderIntroScreen()`에서 `OPENING_LINES[lang]` 배열을 순회
- 각 라인을 `.lore-line`, `.lore-alert`, `.lore-section-title` 등으로 분류해 표시

---

## 2. Intro → Initialize → Game 전환 구조

### 화면 상태

| 상태 | 설명 |
|------|------|
| `screen = 'intro'` | 첫 진입 시 intro 화면 표시 |
| `screen = 'game'` | SYSTEM INITIALIZE 클릭 후 게임 HUD 표시 |

### 전환 흐름

1. **진입**: miniapp 로드 → intro 화면만 표시 (`#intro-screen`), 게임 HUD (`#game-screen`) 숨김
2. **언어 선택**: `한국어` / `ENGLISH` 버튼 클릭 → `lang` 변경 → `renderIntroScreen()` 즉시 반영
3. **SYSTEM INITIALIZE**: 클릭 시
   - `screen = 'game'`
   - `#intro-screen`에 `.hidden` 추가
   - `#game-screen`에 `.visible` 추가
   - `renderGameLabels()` 호출
   - `doStart(false)` → `POST /api/start` 호출, 게임 상태 로드

### 코드 위치

- `index.html`: `introInitBtn` click → `screen`, visibility, `doStart(false)`

---

## 3. HUD 내용이 Vercel판과 같아진 방식

### GAME_LABELS (public/locales.js·index.html 기준)

| 항목 | ko | en |
|------|-----|-----|
| countdown | 함선 붕괴까지 | TIME UNTIL TOTAL SHIP COLLAPSE |
| hades/objectives | OPENING_LINES와 동일 본문 | 동일 |
| location | 현재 위치 | Current Location |
| threat | 위협도 | Threat Level |
| execute btn | [ 처형 프로토콜 실행 (ACCUSE) ] | [ INITIATE PURGE PROTOCOL (ACCUSE) ] |
| question | 승무원 심문 | INTERROGATE CREW |
| cctv | CCTV 로그 확인 | CHECK CCTV LOGS |
| engine | 엔진실 확인 | CHECK ENGINE ROOM |
| pistol | 권총 획득 | TAKE PISTOL |
| threatBtn | 위협 | THREAT |
| clue | 단서 수집 | FIND CLUE |
| restart | 시스템 재부팅 | REBOOT SYSTEM |
| accuse modal | 처형 대상 선택 / 탄환 1발 | SELECT TARGET FOR ELIMINATION / One bullet only |

### 액션 연결

- **승무원 심문**: `네비게이터 어디 있었어` / `Where was the navigator`
- **CCTV 로그 확인**: `CCTV 로그를 확인한다.` / `Checking CCTV logs.`
- **엔진실 확인**: `엔진실 로그를 확인한다.` / `Checking engine room logs.`
- **처형 프로토콜**: 모달 → accuse 전송
- 나머지(pistol, threat, clue): console.log 유지

---

## 4. 언어 선택 처리 방식

### 저장

- `localStorage` 키: `tartarus_miniapp_lang`
- 값: `'ko'` | `'en'`

### 기본값

- 미저장 시 `'ko'` (한국어 우선)

### 적용 범위

| 화면 | 적용 내용 |
|------|-----------|
| Intro | 세계관 문구, [ SYSTEM INITIALIZE ] 버튼 |
| Game | 함선 붕괴까지, 하데스 경보, 주요 목표, 액션 버튼, 입력창 placeholder, 처형 모달 |

### 반영 시점

- 언어 버튼 클릭 시 `renderIntroScreen()` 또는 `renderGameLabels()` 즉시 호출

---

## 5. Accuse 팝업 처리 흐름

### 트리거

- "처형 프로토콜 실행" 버튼 클릭 → `openExecuteModal()` 호출
- `game_over === true`이면 모달 열지 않음

### 팝업 UI

- 제목: "처형 대상 선택" / "SELECT TARGET FOR ELIMINATION"
- 대상 버튼: 닥터, 엔지니어, 네비게이터, 파일럿 (또는 Doctor, Engineer, Navigator, Pilot)
- 취소 / 확정 버튼

### 전송 텍스트 (intentParser 규칙 준수)

| 언어 | doctor | engineer | navigator | pilot |
|------|--------|----------|-----------|-------|
| ko | 닥터를 의심한다 | 엔지니어를 의심한다 | 네비게이터를 의심한다 | 파일럿을 의심한다 |
| en | accuse doctor | accuse engineer | accuse navigator | accuse pilot |

### 처리 흐름

1. 대상 선택 → `selectedExecuteTarget` 저장
2. 확정 클릭 → `closeExecuteModal()` → `doMessage(ACCUSE_TEXTS[lang][target])`
3. `POST /api/message` → `processMessageApi` → `intentParser.parse` → `accuse_hint` + target
4. `ep1Engine.applyAction` → ACCUSE 처리, 승패 판정
5. 응답 → `updateStatus`, `appendLog`, `applyEvents`

### bot.js

- 기존 `processMessageApi` 사용, 수정 없음
- `intentParser`가 "의심", "accuse" + 역할명 인식 → `accuse_hint` + target 반환

---

## 6. 로컬 테스트 방법

### 사전 조건

- Node.js
- `public`, `public_itch`, `api/ep1/*` 미수정 유지

### 실행

```bash
node telegram/bot/bot.js
```

- 로컬 API 서버: `http://localhost:8788`
- miniapp: `http://localhost:8788/` 또는 `http://localhost:8788/miniapp`

### 테스트 순서

1. 브라우저에서 `http://localhost:8788/` 접속
2. Intro 화면 확인 → 언어 전환 (한국어/ENGLISH)
3. [ SYSTEM INITIALIZE ] 클릭 → 게임 HUD 표시
4. "승무원 심문" / "CCTV 로그 확인" 동작 확인
5. "처형 프로토콜 실행" 클릭 → 팝업 → 대상 선택 → 확정 → accuse 전송 확인
6. Game over 시 잠금 + "시스템 재부팅" / "REBOOT SYSTEM" 동작 확인

### API 엔드포인트

| 경로 | 메서드 | 용도 |
|------|--------|------|
| `/api/start` | POST | 매치 시작/재시작, `{ playerId, restart? }` |
| `/api/message` | POST | 액션/accuse 전송, `{ playerId, text }` |

---

## 7. 수정 파일

- `telegram/miniapp/index.html` — intro, game HUD, i18n, execute 모달
- `telegram/bot/bot.js` — 변경 없음 (기존 API 유지)
