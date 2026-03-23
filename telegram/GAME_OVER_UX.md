# Game Over 상태 UX 정리

## 1. Game Over 잠금 방식

### 트리거
- `game_state.game_over === true`일 때 `setGameOverLock(true)` 호출

### 적용 범위

| 대상 | 비활성화 방식 |
|------|----------------|
| **액션 버튼** | `.action-btn.locked` 클래스 적용 → `opacity: 0.4`, `pointer-events: none`, `cursor: not-allowed`, 테두리/글자색 흐리게 |
| **자유입력창** | `.input-area.disabled` 클래스 + placeholder `"게임 종료됨"` |
| **전송 버튼** | `.input-area.disabled`로 input·button 함께 비활성화 (opacity, pointer-events) |

### 코드 위치
- `index.html` → `setGameOverLock(locked)`
- `updateStatus(state)` 내부에서 `gs.game_over && gs.outcome` 조건으로 호출

---

## 2. Restart 흐름

### miniapp → bot.js

1. **버튼**: game over 시에만 `.restart-section`이 보이고, `"새 매치 시작"` 버튼 표시
2. **클릭 시**: `doStart(true)` 호출 → `POST /api/start`에 `{ playerId, restart: true }` 전송
3. **bot.js 처리**: `getStartStateApi(playerId, { restart: true })` 호출
   - 플레이어의 `match_id`를 `null`로 초기화
   - 이후 기존 로직대로 새 `match_id` 생성, player에 새 match 바인딩
4. **응답**: `ok`, `match_id`, `remaining_sec`, `game_state`, `events` 등 반환
5. **miniapp**: `updateStatus()`로 새 상태 반영 → `game_over: false`이므로 잠금 해제, restart 섹션 숨김

### API 스펙

```
POST /api/start
Body: { playerId: string, restart?: boolean }
Response: { ok, match_id, remaining_sec, game_state, events, ... }
```

- `restart: true` → 기존 매치와의 연결 끊고 새 매치 생성 후 그 상태 반환

---

## 3. dead_roles 표시 방식

### 조건
- `game_state.dead_roles`가 배열이고 `length > 0`일 때만 표시

### UI
- 상태 카드(`.status-card`) 내 `.status-item.full-width#status-dead-wrap` 블록
- 라벨: "Dead Roles"
- 값: `dead_roles.join(', ')` (쉼표로 구분)
- 스타일: `.status-value.threat` → 빨간색(`#ef2a2a`)

### 숨김
- `dead_roles`가 없거나 빈 배열이면 `status-dead-wrap`를 `display: none`으로 숨김

---

## 4. Outcome 배지 (상단)

- `game_over` + `outcome` 존재 시 배지 표시
- outcome 종류별 색상 대비 강화:
  - `crew_win`: 녹색 배경·테두리, 밝은 녹색 글자, 글로우
  - `impostor_win`: 빨간색 배경·테두리, 밝은 빨간 글자, 글로우
  - `accuse_failed`: 주황색 계열 배경·테두리, 밝은 주황 글자

---

## 5. 수정된 파일 목록

- `telegram/miniapp/index.html` – 게임오버 잠금, restart 버튼, dead_roles 표시, outcome 배지 스타일
- `telegram/bot/bot.js` – `getStartStateApi` `restart` 옵션, `/api/start` 요청 body 처리

---

## 6. 제약 준수

- `public`, `public_itch`, `api/ep1/*` 미수정
- API_BASE·fetch 구조 유지
- Telegram SDK·결제 미사용
