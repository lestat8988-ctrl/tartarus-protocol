# Tartarus V2 canonical engine 평가

## 범위와 안전 기준

- Phase 1 checkpoint: `d7d7f998b44b83ab1d1a61cf5d2814ad7c9f78ed`
- 평가 대상: `core/engine/ep1Engine.js`, `src/engine/TartarusEngine.js`, `api/ep1/[op].js`
- Telegram V1 production 경로는 교체하거나 수정하지 않았다.
- Railway, Vercel, Supabase, Telegram 및 실제 AI provider에는 접근하지 않았다.
- 결론은 **ADOPT WITH CHANGES**다. `core/engine`의 현재 파일을 그대로 canonical로 선언한다는 뜻이 아니라, 현재 규칙을 출발점으로 V2 계약에 맞는 순수 reducer를 새 경로에서 구축한다는 뜻이다.

## 세 구현 비교

| 관점 | `core/engine/ep1Engine.js` | `src/engine/TartarusEngine.js` | `api/ep1/[op].js` |
|---|---|---|---|
| state | match envelope와 `game_state`를 사용한다. clue, pistol, dead roles, accuse history, kill marks, outcome이 있다. | history를 매번 계산해 `resultText`, `deadCrew`, `isGameOver`, `actualImposter`, `rngState`를 반환한다. 정규화된 state aggregate는 없다. | module-scope `Map`에 turn, phase, location, raw/public events, crew status를 저장한다. hidden truth는 없다. |
| action/command | 11개 action과 intent alias를 처리한다. 정규화 중 입력 action을 mutation한다. | `message`, `wait`, `accuse`만 처리한다. action shorthand로 history 마지막 항목을 추가할 수 있다. | payload를 이벤트로 append하고 항상 accepted placeholder로 응답한다. 실제 규칙 검증은 없다. |
| timer | 420초 deadline, floor 기반 remaining seconds, timeout 판정이 있다. 일부 fallback에서 직접 현재 시각을 읽는다. | 없다. | 없다. |
| auto-kill | 240/60초 mark, strict `<` 경계, deterministic role order, mark 중복 방지가 있다. | `wait`마다 seed RNG로 희생자를 선택한다. wall-clock mark 개념은 없다. | 없다. |
| host/impostor | `hidden_host_role`을 입력으로 받는다. 선택 자체는 `matchStore`가 `Math.random`으로 수행한다. | seed PRNG로 history replay 시작 시 선택한다. | 결정하지 않는다. |
| evidence | clue catalog, pistol, threat, check-log 서사가 있다. clue 선택은 직접 `Math.random`을 사용한다. | structured evidence는 없다. message response와 witness 문구만 있다. | action summary만 기록한다. |
| accuse | target과 hidden host를 비교해 즉시 종료한다. | target과 generated imposter를 비교해 즉시 종료한다. | ACCUSE도 일반 로그일 뿐 종료하지 않는다. |
| win/lose | timeout, correct/wrong accuse, sole-surviving impostor helper가 있다. 자동/수동 death 종료 조건에는 불일치 가능성이 있다. | correct/wrong accuse와 innocents 전멸을 텍스트 중심으로 처리한다. | 항상 `game_over:false`, `outcome:null`이다. |
| RNG | clue는 process-global `Math.random`; kill victim은 고정 role order다. RNG state가 없다. | seed hash와 명시적 Mulberry32 state를 사용한다. 동일 입력 replay가 재현된다. | RNG가 없다. |
| replay | event는 만들지만 reducer replay 계약과 RNG 추적이 없다. | 전체 history replay가 가능하다. 다만 full history와 이미 advance된 `rngState`를 동시에 넘길 때 기준점 의미가 불명확하다. | event log 조회만 가능하며 규칙 replay가 아니다. |
| hidden/public | hidden host가 match top-level에 있고 별도 projection 함수가 없다. bot이 종료 뒤 reveal을 붙인다. | `actualImposter`를 게임 종료 전에도 반환한다. public projection이 없다. | raw/public event 배열은 나뉘지만 secret state가 없어서 진정한 hidden/public 분리는 아니다. |
| 외부 결합 | DB/HTTP/Telegram/LLM 호출은 없지만 locale별 dialogue와 직접 clock/RNG fallback이 섞여 있다. | 파일에서 game data를 읽는 load-time 의존 외에는 계산이 독립적이다. presentation text가 결과에 섞여 있다. | HTTP, auth, storage, timestamp와 규칙 placeholder가 한 파일에 결합돼 있다. |

## Telegram V1 대 core parity

Phase 1의 51개 characterization test를 유지하고 Phase 2에 17개 비교 test를 추가했다. 선택된 동일 입력에서 SUSPECT→OBSERVE와 239초 auto-kill의 dead roles/triggered marks는 일치한다. 다음은 반드시 보존해 관찰한 기존 동작이며, 이 단계에서 수정하지 않았다.

| 항목 | CURRENT BEHAVIOR | INTENDED/UNKNOWN | V2 CANDIDATE |
|---|---|---|---|
| direct `SUSPECT` | `intentToAction("suspect")`가 알려진 token으로 취급되지 않아 `OBSERVE`로 바뀌며, caller의 action 객체도 mutation된다. Telegram V1도 같은 결과를 저장한다. | UNKNOWN | `SUSPECT`를 명시적 비종료 command로 정의하거나 제거한다. 암묵적 `OBSERVE` 변환은 하지 않는다. |
| 240초 auto-kill | 정확히 240초에는 발동하지 않고 239초 이하에서 240 mark가 발동한다. | UNKNOWN | 제품 결정 후 `<` 또는 `<=`를 named threshold policy로 고정한다. |
| 60초 auto-kill | 240 mark 처리 후 정확히 60초에는 발동하지 않고 59초 이하에서 발동한다. | UNKNOWN | 240초와 같은 명시적 경계 정책을 사용한다. |
| threat target 누락 | core는 `ok:true`와 시스템 dialogue를 반환한다. Telegram adapter는 engine 호출 전에 `ok:false`로 거절한다. | UNKNOWN | engine이 typed rejection을 반환하고 모든 transport가 그대로 매핑한다. |
| timer 1ms | 시작 1ms 뒤 `remaining_sec`은 floor 때문에 419다. | UNKNOWN | domain은 millisecond를 보존하고 UI countdown rounding은 projection/presentation 정책으로 분리한다. |
| fallback summary | 표시 로그가 있어도 summary가 U+200B 한 글자다. | UNKNOWN | domain 밖 V1 compatibility presenter에서만 보존하고 V2 event/outcome에는 넣지 않는다. |
| input action mutation | 정규화 과정에서 `action.action`과 `action.target`을 덮어쓴다. | UNKNOWN | 입력 command는 immutable로 취급하고 새 normalized command를 만든다. |
| direct `Math.random` | `FIND_CLUE`가 global `Math.random()`을 직접 호출한다. | UNKNOWN | `context.random` 또는 stateful PRNG를 통해서만 draw하고 replay metadata에 소비를 기록한다. |

추가 parity gap은 다음과 같다.

- Telegram adapter가 turn을 증가시키며 core reducer 자체는 turn을 증가시키지 않는다.
- `/api/state` polling의 `applyMatchClockTick`이 timeout/auto-kill 규칙을 core와 별도로 다시 구현한다.
- polling tick은 한 호출에서 최대 24회 반복해 건너뛴 kill mark를 연속 처리하지만 action 경로의 core 호출은 한 번에 한 auto-kill만 처리한다.
- bot의 시작/opening 상태와 command lock은 core state machine에 없다.
- bot은 종료 뒤 `actual_imposter`를 projection에 붙이지만 core는 public/hidden view를 만들지 않는다.
- legacy `api/ep1/[op].js`는 ACCUSE도 placeholder로 받아들이며 승패를 결정하지 않는다.

## `src/engine`에서 가져올 가치

| 기능 | 평가 | 포팅 방향 |
|---|---|---|
| seeded RNG | 높음 | stable seed-to-state와 serializable PRNG transition을 V2 내부 모듈로 옮긴다. 알고리즘/version을 state에 명시한다. |
| deterministic replay | 높음 | initial state + ordered commands + recorded context로 동일 결과를 재생하는 검증 API를 둔다. |
| action history replay | 높음 | history를 매번 텍스트 결과로 다시 계산하는 형태가 아니라 canonical event/command envelope를 replay한다. |
| `rngState` | 높음, 계약 수정 필요 | draw 전후 cursor 또는 state를 명확히 한다. full replay의 origin state와 incremental apply의 current state를 혼용하지 않는다. |
| reproducible simulation | 높음 | clock과 RNG를 주입하고 effect 실행을 막아 대량 simulation이 가능한 순수 API로 만든다. |
| generated imposter | 일부 채택 | seed 기반 선택은 채택하되 hidden state에만 저장하고 public result에는 노출하지 않는다. |
| text response pools | 낮음 | presentation/dialogue subsystem으로 격리한다. canonical outcome을 텍스트로 표현하지 않는다. |

`src/engine/evidence/generate_match_config.js`의 seed 기반 incident/evidence deck 생성 방식도 포팅 가치가 있다. 다만 중복 PRNG 구현을 하나로 합치고 생성 결과를 hidden state의 match configuration으로 저장해야 한다.

## 최종 평가: ADOPT WITH CHANGES

`core/engine`을 선택하는 이유는 현재 Telegram V1이 의존하는 실제 규칙 면적이 가장 크고 Phase 1 fixture와 직접 연결돼 있기 때문이다. timer, kill mark, accusation, outcome, clue/pistol state를 버리고 다른 구현을 선택하면 behavior migration 위험이 더 커진다.

그대로 ADOPT할 수 없는 이유는 다음과 같다.

- caller command mutation과 직접 `Math.random` 사용으로 pure/deterministic하지 않다.
- fallback `Date` 생성으로 clock 주입이 강제되지 않는다.
- turn, match lifecycle, opening command lock, polling catch-up rule이 bot에 남아 있다.
- locale별 dialogue가 domain events에 섞여 있다.
- hidden/public projection과 replay/versioned RNG contract가 없다.
- death 종료 조건과 `resolveOutcome`의 sole-survivor 규칙이 한 경로에서 일관되지 않을 수 있다.
- invalid command/target이 typed rejection이 아니라 성공 dialogue 또는 adapter별 오류로 갈린다.

따라서 Phase 3에서는 production import를 바꾸지 않은 채 V2 전용 새 reducer를 만들고, parity fixture를 양쪽에 실행하는 방식으로 이행해야 한다. Telegram V1 adapter의 교체는 별도 승인과 shadow verification 전에는 하지 않는다.
