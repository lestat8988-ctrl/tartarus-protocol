# Tartarus V2 command, event, outcome, effect contract

## Canonical reducer

```ts
applyCommand({
  state,
  command,
  context: {
    now,
    random
  }
}) => {
  state,
  events,
  outcome,
  effects
}
```

구체 계약은 다음과 같다.

```ts
type ApplyCommandInput = Readonly<{
  state: GameStateV2;
  command: CommandV2;
  context: Readonly<{
    now: number;
    random: RandomSource;
  }>;
}>;

type ApplyCommandResult = Readonly<{
  accepted: boolean;
  state: GameStateV2;
  events: readonly DomainEventV2[];
  outcome: Outcome | null;
  effects: readonly EffectV2[];
  rejection?: CommandRejection;
}>;

type RandomSource = Readonly<{
  algorithm: 'mulberry32-v1';
  state: number;
  nextUint32(): Readonly<{ value: number; state: number }>;
}>;
```

`now`는 epoch milliseconds다. reducer는 `Date.now`, `new Date()` fallback, `Math.random`, DB, HTTP, Telegram SDK, LLM, locale catalog를 호출하지 않는다. input state/command/context를 mutation하지 않는다.

## Command envelope

```ts
type CommandV2 = Readonly<{
  commandId: string;
  type:
    | 'START_MATCH'
    | 'COMPLETE_OPENING'
    | 'TICK'
    | 'QUESTION'
    | 'OBSERVE'
    | 'CHECK_LOG'
    | 'REPAIR'
    | 'SUSPECT'
    | 'ACCUSE'
    | 'WAIT'
    | 'TAKE_PISTOL'
    | 'FIND_EVIDENCE'
    | 'THREATEN';
  actor: Role;
  target?: Role | ZoneId;
  payload?: Readonly<Record<string, unknown>>;
  expectedRevision: number;
}>;
```

- NLU string과 transport alias는 `CommandV2`가 아니다. adapter가 `execute`, `cctv`, 자연어 등을 canonical type으로 변환한다.
- engine은 phase, actor, target, revision, resource, terminal-state 조건을 다시 검증한다.
- malformed/invalid command는 state를 그대로 반환하고 typed `rejection`과 `COMMAND_REJECTED` event policy를 따른다.
- `SUSPECT`의 유지 여부와 turn 소비 정책은 Phase 3 전 제품 결정이 필요하지만, 유지한다면 `OBSERVE`로 묵시 변환하지 않는다.

## Domain events

모든 event는 localized 문장 대신 stable field를 가진다.

```ts
type DomainEventV2 = Readonly<{
  eventId: string;
  sequence: number;
  type:
    | 'MATCH_STARTED'
    | 'OPENING_COMPLETED'
    | 'TIMER_THRESHOLD_REACHED'
    | 'TIMEOUT_REACHED'
    | 'CREW_DIED'
    | 'QUESTION_ASKED'
    | 'AREA_OBSERVED'
    | 'LOG_CHECKED'
    | 'REPAIR_ATTEMPTED'
    | 'SUSPECT_RECORDED'
    | 'ACCUSATION_RESOLVED'
    | 'PISTOL_TAKEN'
    | 'EVIDENCE_FOUND'
    | 'THREAT_MADE'
    | 'MATCH_RESOLVED'
    | 'COMMAND_REJECTED';
  atMs: number;
  turn: number;
  actor?: Role;
  target?: Role | ZoneId;
  data: Readonly<Record<string, string | number | boolean | null>>;
  visibility: 'PUBLIC' | 'HIDDEN' | 'SYSTEM';
}>;
```

예시는 다음과 같다.

```js
{
  type: 'CREW_DIED',
  atMs: 1767225781000,
  turn: 3,
  target: 'DOCTOR',
  data: { cause: 'AUTO_KILL', thresholdSec: 240, zoneId: 'MEDICAL_BAY' },
  visibility: 'PUBLIC'
}
```

Presenter가 이를 한국어 또는 영어 dialogue/display log로 변환한다. AI가 생성한 문장은 event의 authoritative data가 아니다.

## Outcome

- `outcome`은 `state.outcome`과 동일한 structured value거나 `null`이다.
- reducer가 resolve transition에서 `MATCH_RESOLVED`를 정확히 한 번 emit한다.
- timeout, correct accusation, wrong accusation, sole-survivor의 우선순위는 ruleset version으로 고정한다.
- V1처럼 `game_over` boolean과 outcome string을 서로 다른 경로에서 따로 갱신하지 않는다.

## Effects

effect는 외부 작업 요청이며 reducer가 실행하지 않는다.

```ts
type EffectV2 =
  | Readonly<{ type: 'PERSIST_TRANSITION'; matchId: string; expectedRevision: number }>
  | Readonly<{ type: 'SCHEDULE_TICK'; matchId: string; atMs: number }>
  | Readonly<{ type: 'CANCEL_SCHEDULED_TICKS'; matchId: string }>
  | Readonly<{ type: 'REQUEST_DIALOGUE'; eventIds: readonly string[]; audience: 'PLAYER' }>
  | Readonly<{ type: 'PUBLISH_PUBLIC_EVENTS'; eventIds: readonly string[] }>
  | Readonly<{ type: 'NOTIFY_MATCH_RESOLVED'; matchId: string }>;
```

- DB row, Telegram chat ID, HTTP status와 provider 이름은 engine effect payload에 넣지 않는다. application layer가 match/session mapping으로 해석한다.
- dialogue request는 optional이다. 실패해도 canonical state/outcome은 바뀌지 않고 deterministic presenter fallback을 사용할 수 있다.
- effect delivery는 idempotency key `(matchId, revision, effect index)`를 사용한다.

## Timer와 auto-kill ordering

권장 reducer ordering은 다음과 같다.

1. revision/shape/terminal/phase validation
2. injected `now`로 timeout 확인
3. 도달한 timer thresholds와 auto-kill 처리
4. command가 preempt되지 않았다면 command 적용
5. win/lose 계산
6. turn/revision/RNG 갱신
7. events/effects 생성

V1은 action path에서 auto-kill 하나가 command를 preempt하고 polling path에서 여러 mark를 catch up한다. V2의 한 `TICK`이 모든 누락 mark를 처리할지 하나만 처리할지는 Phase 3 전 확정해야 한다.

## Replay와 simulation

- production과 simulation은 같은 `applyCommand`를 호출한다.
- simulation은 fixed `now` sequence와 seeded `RandomSource`를 제공하고 effects를 수집만 한다.
- replay는 recorded command, `now`, RNG-before state를 순서대로 적용해 events/state hash를 검증한다.
- command ID 중복은 idempotent no-op 또는 typed duplicate rejection으로 일관되게 처리한다.
- ruleset/RNG algorithm version이 다르면 replay를 거절하고 migration을 요구한다.

## V1 compatibility boundary

- V1 adapter는 기존 field, U+200B summary, localized lines와 HTTP shape를 계속 제공할 수 있다.
- adapter가 V2 result를 V1 DTO로 변환하더라도 outcome, target validation, timer/kill 규칙을 다시 계산하면 안 된다.
- production 경로 교체 전에는 Phase 1 fixtures를 legacy와 V2 candidate 모두에 실행하고 shadow diff를 수집한다.
