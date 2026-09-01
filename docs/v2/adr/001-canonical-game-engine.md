# ADR-001: V2 canonical game engine 선택

- Status: Accepted for V2 design; production adoption not approved
- Date: 2026-09-01
- Decision: **ADOPT WITH CHANGES** for `core/engine`
- Baseline checkpoint: `d7d7f998b44b83ab1d1a61cf5d2814ad7c9f78ed`

## Context

프로젝트에는 서로 다른 세 가지 engine-like 구현이 있다.

- `core/engine/ep1Engine.js`는 Telegram V1이 실제 사용하는 timer, auto-kill, action, accusation, outcome 규칙을 가진다.
- `src/engine/TartarusEngine.js`는 seed와 serializable `rngState`로 history를 재현하지만 현재 Telegram 규칙과 state/evidence/timer를 포괄하지 않는다.
- `api/ep1/[op].js`는 HTTP와 in-memory event log를 제공하는 placeholder이며 ACCUSE조차 승패를 결정하지 않는다.

V2는 순수하고 deterministic하며 replay/simulation 가능한 단일 game-domain source of truth가 필요하다. 동시에 production Telegram V1의 동작을 승인 없이 바꾸면 안 된다.

## Decision

`core/engine`의 규칙 집합을 V2 canonical engine의 migration baseline으로 채택하되 현재 구현 파일을 그대로 채택하지 않는다.

V2 candidate는 다음을 만족하는 새, versioned reducer여야 한다.

- `applyCommand({ state, command, context: { now, random } })`
- immutable inputs/outputs와 deterministic transition
- direct clock/RNG/global/service access 금지
- hidden state와 audience별 public projection 분리
- localized dialogue 없는 stable domain events
- 외부 작업은 declarative effects로만 반환
- turn, timer, kill, accusation, win/lose, command validation을 모두 engine이 소유
- initial state + commands + clock/RNG context로 replay와 simulation 가능

`src/engine`에서는 seeded PRNG transition, `rngState`, history replay의 아이디어를 포팅한다. `api/ep1/[op].js`는 canonical 후보에서 제외한다.

## Alternatives considered

### ADOPT `core/engine` unchanged

거절했다. input mutation, direct `Math.random`, optional direct clock, locale dialogue, incomplete projection/replay 때문에 V2 원칙을 위반한다. bot에 중복된 rules도 제거하지 못한다.

### ADOPT `src/engine/TartarusEngine.js`

거절했다. deterministic foundation은 좋지만 420초 timer, 240/60 kill marks, pistol/clue/threat, Telegram action set, structured outcome가 없다. `actualImposter`를 non-terminal result에 노출하며, full replay와 supplied current `rngState`의 의미도 불명확하다.

### ADOPT `api/ep1/[op].js`

거절했다. HTTP/storage placeholder이며 domain engine이 아니다. accusation, evidence, hidden truth, timer, auto-kill, win/lose, RNG, replay가 없다.

### Greenfield rules rewrite

현재는 거절했다. Phase 1의 51개 behavior fixture와 가장 먼 경로라 production parity 위험이 크다. core 규칙을 characterization하면서 단계적으로 순수 reducer로 옮기는 편이 검증 가능하다.

## Consequences

긍정적 결과는 다음과 같다.

- Telegram V1과 가까운 규칙에서 출발해 parity를 정량화할 수 있다.
- seed/replay 기능을 선택적으로 통합할 수 있다.
- bot.js의 domain leakage를 명확한 이동 목록으로 관리할 수 있다.
- transport/provider/persistence 교체가 game outcome을 바꾸지 않는 구조가 된다.

비용과 위험은 다음과 같다.

- 일정 기간 legacy engine과 V2 candidate를 함께 유지하고 differential test해야 한다.
- 현재 모순된 동작은 기술적으로 “고치는” 대신 제품 결정을 받아 versioned rule로 확정해야 한다.
- narrative turn, opening timer, polling catch-up처럼 bot에 숨어 있는 규칙을 옮길 때 parity가 쉽게 깨진다.
- RNG 알고리즘과 replay envelope가 한번 저장되면 장기 호환 계약이 된다.

## Guardrails

- Phase 2에서는 production import/path를 변경하지 않는다.
- V2 candidate는 별도 module과 tests에서 시작한다.
- Telegram V1 경로는 Phase 1 51개 test가 계속 통과해야 한다.
- shadow/differential 결과와 명시적 승인 전 production adapter를 V2로 전환하지 않는다.
- provider, persistence, transport는 canonical reducer 내부로 들어오지 않는다.

## Phase 3 진입 전 필요한 결정

1. `SUSPECT`를 first-class command로 유지할지, `accuse_hint`만 유지할지 결정한다.
2. auto-kill 경계를 strict `<`로 보존할지 정확한 240/60초에 발동하도록 바꿀지 결정한다.
3. missing threat/accuse target을 typed rejection으로 통일할지 V1 successful dialogue를 V2에도 유지할지 결정한다.
4. public countdown을 floor, ceil 또는 millisecond 중 무엇으로 계약할지 결정한다.
5. opening dialogue 동안 domain timer가 계속 흐를지 pause할지 결정한다.
6. 정보/서사/NLU-only command가 domain turn을 소비할지 결정한다.
7. skipped kill marks를 한 `TICK`에서 모두 catch up할지 한 번에 하나만 적용할지 결정한다.
8. wrong accusation을 즉시 terminal `ACCUSE_FAILED`로 유지할지 계속 플레이하게 할지 결정한다.
9. impostor/evidence 생성 seed의 소유자와 공개 가능한 replay metadata 범위를 결정한다.
10. game 종료 시 hidden impostor를 항상 공개할지 audience별 reveal policy를 둘지 결정한다.
