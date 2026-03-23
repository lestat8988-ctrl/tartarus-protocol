# Intro 배경·언어 수정 정리

## 1. 배경 이미지 경로

### 적용 방식

- **경로**: `./assets/tartarus-ship-neptune.png` (telegram/miniapp 기준 상대 경로)
- **출처**: `public/assets/tartarus-ship-neptune.png`를 `telegram/miniapp/assets/`로 복사
- **정적 서버**: `npx serve .\telegram\miniapp -l 4200`처럼 miniapp만 서빙해도 이미지 표시 가능

### CSS

```css
#intro-screen {
  background: #000 url(./assets/tartarus-ship-neptune.png) center center no-repeat;
  background-size: cover;
}
#intro-screen::before {
  /* 어두운 오버레이로 텍스트 가독성 확보 */
  background: linear-gradient(180deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.6) 40%, rgba(0,0,0,0.85) 100%);
}
```

- `background-size: cover`, `background-position: center` 적용
- 배경 위에 반투명 그라데이션으로 텍스트 가독성 확보

---

## 2. 기본 언어를 영어로 고정

### 코드 변경

```javascript
var lang = localStorage.getItem(LANG_KEY) || 'en';
```

- 기존: `|| 'ko'`
- 변경: `|| 'en'`

### 동작

- **최초 진입**: `localStorage`에 값 없음 → `lang = 'en'`
- **재방문**: `localStorage`에 저장된 값 사용
- **html lang**: `lang="en"`으로 설정

---

## 3. 한국어 버튼 클릭 시 바뀌는 텍스트

| 요소 | 영어 (기본) | 한국어 (한국어 버튼 클릭 후) |
|------|-------------|------------------------------|
| Intro 본문 | [SYSTEM INITIALIZE…], Target vessel, HADES ALERT, PRIMARY OBJECTIVES 등 | [시스템 기동…], 대상 함선, [하데스 경보], [주요 목표] 등 |
| Init 버튼 | [ SYSTEM INITIALIZE ] | [ 시스템 기동 ] |
| 언어 버튼 활성 | ENGLISH | 한국어 |
| HUD (게임 화면) | TIME UNTIL TOTAL SHIP COLLAPSE, [HADES ALERT], 액션 버튼 영어 라벨 등 | 함선 붕괴까지, [하데스 경보], 액션 버튼 한글 라벨 등 |

### 언어 토글

- **한국어 버튼**: `lang = 'ko'` 저장 후 `renderIntroScreen()` 호출 → 전체 Intro 문구 한글 전환
- **ENGLISH 버튼**: `lang = 'en'` 저장 후 `renderIntroScreen()` 호출 → 전체 Intro 문구 영어 전환
