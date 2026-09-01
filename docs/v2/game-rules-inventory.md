# Telegram V1 game rules inventory

이 문서는 `telegram/bot/bot.js`에 섞인 책임을 A~G로 분류한다. “Domain Rule”은 게임 결과, command admissibility, turn 또는 authoritative state transition에 영향을 주는 규칙이다. dialogue state가 결과에 영향을 주지 않는 한 B/D로 분류했다.

## A. Domain Rule

아래 항목은 현재 `bot.js`에 남아 있는 숨은 Domain Rule이다.

| 숨은 규칙 | 현재 동작과 결과 영향 | V2 위치 |
|---|---|---|
| match start/resume/restart | player에 match가 없으면 생성한다. 끝난 match는 새 match로 전환한다. restart 시 이전 timeout을 먼저 반영할 수 있다. | application service가 lifecycle command를 만들고 engine의 `START_MATCH`/`END_MATCH` transition을 호출한다. entitlement와 association은 domain 밖이다. |
| opening phase command lock | `captain_phase=opening_chat`이고 sequence가 끝나지 않으면 player command를 받지 않는다. 실제 시간이 흐르는 동안 core timer는 별도로 시작돼 있어 opening 중에도 deadline이 소모될 수 있다. | `phase`와 허용 command를 canonical state machine에 둔다. opening dialogue 재생은 effect/presenter로 분리한다. 타이머 pause 여부는 제품 결정이 필요하다. |
| post-opening gate 해제 | “첫 함장 입력 대기” flag가 action/message뿐 아니라 state polling clock tick에서도 지워진다. 이로 인해 polling이 command gate 상태를 바꾼다. | read/poll은 state를 변경하지 않는다. gate 해제는 명시적 command만 수행한다. |
| turn progression | core는 turn을 올리지 않는다. bot의 action/accuse/message 및 여러 특수 dialogue branch가 `(turn || 1)+1`을 저장한다. 일부 정보/서사 질의도 turn을 소비한다. | command마다 `consumesTurn` 정책을 engine이 하나의 transition으로 적용한다. |
| action alias와 admissibility | `execute→accuse`, `cctv/engine→check_log`, `clue→find_clue`를 bot에서 변환한다. threat/accuse target whitelist도 bot에서 별도 검증한다. | transport-independent command normalization/validation boundary를 하나로 둔다. NLU는 canonical command를 제안할 뿐 규칙을 결정하지 않는다. |
| state polling clock tick | `/api/state`가 `applyMatchClockTick`을 호출해 timeout과 auto-kill을 저장한다. read 요청이 authoritative state를 mutation한다. | scheduler/application이 명시적 `TICK` command를 보낸다. GET/read projection은 순수하다. |
| skipped-threshold catch-up | polling tick은 최대 24번 반복해 미처리 kill mark를 연속 적용한다. action 경로는 auto-kill 하나를 적용한 뒤 요청 action을 처리하지 않고 반환한다. | `TICK` 한 번에 처리할 mark 수와 action preemption을 단일 규칙으로 확정한다. |
| timeout persistence | polling 경로가 timeout outcome, event, turn, DB shutdown을 한 흐름에서 적용한다. | engine은 TIMEOUT event/outcome과 persistence effect만 반환한다. effect runner가 저장한다. |
| auto-kill persistence | polling 경로가 victim, marks, outcome, event, turn과 DB shutdown을 독자 계산한다. | engine의 유일한 auto-kill transition으로 이동한다. |
| game-over short circuit | message/action/accuse가 종료 state를 별도 검사하고 transport별 summary/reveal을 만든다. | engine은 terminal state의 허용 command와 rejection을 정하고 presenter가 문구를 만든다. |
| authoritative host reveal precedence | 종료 뒤 여러 legacy field 중 우선순위로 impostor를 골라 `actual_imposter`를 붙인다. 잘못 동기화된 field가 공개 답을 바꿀 수 있다. | hidden state의 단일 `impostorRole`을 source of truth로 사용하고 종료 후 projection policy로 공개한다. |
| narrative branch turn/event writes | name, alibi, group suspicion, role opinion, lore 등 일부 bot-only branch가 event를 append하고 turn을 올린다. | 게임에 영향을 주면 명시적 domain command/event로 승격하고, 아니면 narrative effect/state로 격리해 domain turn을 소비하지 않는다. |

core 밖이지만 현재 결과에 직접 영향을 주는 연관 규칙도 있다.

- `core/state/matchStore.js`가 `Math.random`으로 hidden host를 선택한다.
- `core/engine/kills.js`는 240/60 strict `<` 경계와 고정 role-order victim을 정의한다.
- `core/engine/winlose.js`는 timeout, accusation, sole-surviving impostor를 정의한다.
- core auto/manual death 경로는 `dead_roles.length >= 4`일 때만 outcome을 계산해 sole-survivor helper와 종료 조건이 어긋날 수 있다.

## B. Dialogue / Presentation

| 책임 | 현재 위치/동작 | V2 처리 |
|---|---|---|
| scripted opening dialogue | A/B variant, 역할별 lines, delay와 표시 순서를 bot이 관리한다. variant는 module-global 상태로 교대한다. | presentation workflow와 scheduled effects로 격리한다. domain에는 phase 완료 여부만 반영한다. |
| deterministic fallback | raw domain-like events를 화면 label/line으로 만들고 LLM 실패 시 template을 쓴다. summary는 U+200B가 될 수 있다. | V1 presenter에 그대로 보존한다. V2 engine output에는 localized text를 넣지 않는다. |
| LLM rewrite/guard/sanitize | 응답 speaker, 이름, 존댓말, 역할, 형식, 중복을 보정한다. | AI/dialogue layer의 책임이다. 결과를 domain truth로 사용하지 않는다. |
| personal names | `crew_names`를 game state에 저장하고 display에 사용한다. | presentation profile 또는 match metadata로 이동한다. |
| host reveal text | 종료 응답에 실제 역할과 localized 문구를 붙인다. | public projection + presenter로 분리한다. |
| summaries/display logs | raw event를 Telegram/Miniapp 응답 shape로 변환한다. | transport presenter가 versioned DTO를 만든다. |

## C. NLU

| 책임 | 현재 동작 | V2 처리 |
|---|---|---|
| deterministic classification | state/lore/name/alibi/suspicion/role/targeted question 등을 regex와 heuristic으로 분류한다. | engine 밖 command translator로 유지한다. |
| LLM classification correction | ambiguous free input을 mini/4o mode로 보정하고 실패 시 deterministic classifier로 복귀한다. | AI-backed optional NLU adapter로 격리한다. canonical command validation은 engine이 다시 수행한다. |
| dialogue focus memory | last target/kind/text/reply/time으로 짧은 후속 발화를 해석한다. | NLU session state로 이동한다. game outcome state와 분리한다. clock을 주입한다. |
| aliases and target extraction | action alias, role token, accusation/threat target을 추출한다. | normalized command 생성 전 adapter 단계로 유지하되 의미 변경 규칙은 domain validation에 둔다. |

## D. Emotion / Tension

| 책임 | 현재 동작 | V2 처리 |
|---|---|---|
| suspicion matrix | `crew_suspicion`을 `game_state`에 생성/증가시켜 다음 dialogue에 사용한다. | narrative state aggregate로 분리한다. 승패에 쓰려면 별도 domain RFC가 필요하다. |
| trauma exposure | 특정 질문으로 role별 `trauma_exposure`를 올리고 답변 tone을 바꾼다. | narrative state로 격리한다. |
| manipulation tactic | impostor의 다음 dialogue tactic을 선택해 저장한다. | hidden narrative state로 두되 domain impostor truth를 복제하지 않는다. |
| cross-talk RNG | `Math.random() > 0.62` gate로 끼어들기 여부를 결정한다. | presenter/AI context에 주입 RNG를 사용한다. replay 필요 시 narrative event로 기록한다. |
| timer tension warnings | 6분/3분/1분 구간마다 한 번 CREW_DIALOGUE를 append하고 flags를 game state에 저장한다. 승패는 바꾸지 않지만 state와 event stream을 mutation한다. | engine의 `TIMER_THRESHOLD_REACHED` event를 presentation subsystem이 dialogue로 렌더링하거나, 완전히 narrative scheduler로 분리한다. |

## E. Persistence

- optional Supabase repository와 in-memory fallback이 한 파일에 있다.
- user entitlement, daily ticket, free-prompt quota, player-to-match association, match state/event 저장, shutdown 기록을 수행한다.
- append/update 순서가 여러 branch에 분산돼 atomic transition이 아니다.
- V2 engine은 DB를 호출하지 않고 `PERSIST_MATCH`, `APPEND_EVENTS`, `CLOSE_MATCH` 같은 effects만 기술한다. application unit-of-work가 optimistic version으로 저장한다.
- entitlement는 게임 규칙이 아니라 match 생성/AI 사용 전 application policy다.

## F. Locale

- request, persisted `game_state.locale`, default 순서로 locale을 결정한다.
- locale을 game state에 쓰고 action 질문, fallback, error, reveal, opening, tension 문구를 분기한다.
- V2 canonical domain state에는 locale을 두지 않는다. session/presentation metadata가 locale을 소유하며 동일 domain event를 각 언어 presenter가 렌더링한다.
- V1 response compatibility를 위해 기존 Korean/English formatting은 legacy presenter에 유지한다.

## G. HTTP / Telegram Transport

- Telegram polling/webhook message routing, Miniapp HTTP routes, CORS, health, request validation, response status/shape, server startup/shutdown이 포함돼 있다.
- `/api/state`가 read처럼 보이지만 clock tick과 opening recovery를 실행하는 command 성격도 갖는다.
- polling enablement와 Telegram SDK lifecycle은 transport concern이다.
- V2에서는 HTTP/Telegram handler가 input DTO를 command로 변환하고 result projection만 반환한다. engine은 SDK, status code, CORS, `playerId`를 알지 않는다.

## Legacy 기능의 처분 제안

| 처분 | 기능 |
|---|---|
| 유지 | Phase 1 fixtures, V1 response shape, localized fallback, current NLU heuristics, entitlement semantics, Supabase repository behavior. 모두 compatibility adapter 또는 별도 service로 유지한다. |
| 격리 | bot의 dialogue/LLM, emotion/tension, locale, persistence, Telegram/HTTP, opening playback, focus memory, personal names, legacy API stub. canonical engine 밖으로 경계를 만든다. |
| V2에서 폐기 | input mutation, 직접 `Date.now`/`Math.random`, read-poll mutation, duplicated timeout/kill calculation, multiple impostor truth fields, domain event 안의 localized dialogue, placeholder API를 규칙 source로 사용하는 방식. Telegram V1 코드에서는 승인 전 삭제하지 않는다. |
