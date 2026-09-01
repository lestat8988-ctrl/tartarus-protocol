# Tartarus V2 state schema

## 목표

V2 state는 한 command를 동일 state/context에 적용하면 byte-equivalent한 domain 결과를 만들 수 있어야 한다. persistence record, locale, Telegram user 정보, LLM dialogue memory는 canonical game state에 포함하지 않는다.

## Canonical aggregate

아래 표기는 설계 계약이며 Phase 2에서는 구현하지 않는다.

```ts
type GameStateV2 = Readonly<{
  schemaVersion: 2;
  rulesetVersion: string;
  matchId: string;
  revision: number;
  turn: number;
  phase: 'LOBBY' | 'OPENING' | 'PLAYING' | 'RESOLVED';
  clock: Readonly<{
    startedAtMs: number | null;
    deadlineAtMs: number | null;
    durationMs: number;
    triggeredThresholdsSec: readonly number[];
  }>;
  crew: Readonly<Record<CrewRole, Readonly<{
    status: 'ALIVE' | 'DEAD';
    death?: Readonly<{ atMs: number; cause: 'AUTO_KILL' | 'COMMAND'; zone?: string }>;
  }>>>;
  resources: Readonly<{
    pistolHolder: Role | null;
    evidence: readonly EvidenceRef[];
  }>;
  accusation: Readonly<{
    history: readonly AccusationRecord[];
  }>;
  outcome: Outcome | null;
  rng: Readonly<{
    algorithm: 'mulberry32-v1';
    seed: string;
    state: number;
    draws: number;
  }>;
  hidden: HiddenGameStateV2;
}>;

type HiddenGameStateV2 = Readonly<{
  impostorRole: CrewRole;
  evidenceDeck: readonly HiddenEvidence[];
  evidenceCursor: number;
  scenarioId: string;
}>;

type Outcome = Readonly<{
  code: 'CREW_WIN' | 'IMPOSTOR_WIN' | 'ACCUSE_FAILED';
  winner: 'CREW' | 'IMPOSTOR';
  reason: 'CORRECT_ACCUSATION' | 'WRONG_ACCUSATION' | 'TIMEOUT' | 'SOLE_SURVIVOR';
  resolvedAtMs: number;
}>;
```

`Role`은 초기에는 `CAPTAIN | DOCTOR | ENGINEER | NAVIGATOR | PILOT`, `CrewRole`은 captain을 제외한 네 역할이다. role과 zone은 locale-independent stable ID다.

## Public projection

engine은 state 자체를 transport에 반환하지 않는다. 별도 pure projection이 audience에 맞는 view를 만든다.

```ts
type PublicGameStateV2 = Readonly<{
  schemaVersion: 2;
  matchId: string;
  revision: number;
  turn: number;
  phase: GameStateV2['phase'];
  remainingMs: number | null;
  crew: GameStateV2['crew'];
  resources: GameStateV2['resources'];
  accusation: GameStateV2['accusation'];
  outcome: Outcome | null;
  revealedImpostorRole?: CrewRole;
}>;
```

Projection 규칙은 다음과 같다.

- `hidden`, seed, RNG state, unrevealed evidence deck은 public view에 절대 포함하지 않는다.
- `revealedImpostorRole`은 `phase === 'RESOLVED'`이고 reveal policy가 허용할 때만 `hidden.impostorRole`에서 계산한다.
- `remainingMs`는 `now`를 주입받은 projection에서 계산한다. 표시용 초 단위 floor/ceil은 presenter가 정한다.
- locale, personal names, display text, Telegram identifiers, entitlement는 public game state 필드가 아니다.

## Domain과 분리할 상태

| 상태 | 소유자 |
|---|---|
| `locale`, personal names, localized display logs | presentation session |
| dialogue focus, last reply, NLU classification metadata | NLU session |
| suspicion matrix, trauma, manipulation tactic, cross-talk | narrative/emotion state |
| entitlement, daily ticket, AI prompt quota | account/application policy |
| Telegram player/chat association | transport/application repository |
| persisted event rows, timestamps, DB IDs | repository envelope |
| opening playback cursor/delay/recovery lock | workflow state; command gate에 필요한 `phase`만 domain에 둔다. |

## Evidence schema

```ts
type EvidenceRef = Readonly<{
  evidenceId: string;
  kind: 'LOG' | 'CCTV' | 'BIO' | 'PHYSICAL' | 'TESTIMONY';
  sourceRole?: CrewRole;
  discoveredAtTurn: number;
}>;

type HiddenEvidence = Readonly<{
  evidenceId: string;
  truth: 'TRUE' | 'RED_HERRING';
  implicates: readonly CrewRole[];
  payloadKey: string;
}>;
```

Localized clue text는 `payloadKey`를 presentation catalog에서 렌더링한다. evidence draw는 `hidden.evidenceDeck`과 cursor 또는 명시적 RNG transition으로 결정한다.

## 불변조건

- `revision`은 accepted state-changing command마다 정확히 1 증가한다.
- `turn` 증가 여부는 command policy로 한 곳에서 결정한다. transport는 직접 올리지 않는다.
- `phase === 'RESOLVED'`이면 `outcome !== null`이며 일반 gameplay command를 받지 않는다.
- `outcome !== null`이면 이후 결과를 바꾸는 command를 받지 않는다.
- dead role은 다시 사망할 수 없고 impostor는 auto-kill victim이 될 수 없다.
- `triggeredThresholdsSec`는 중복이 없고 configured threshold 집합의 값만 포함한다.
- accusation history와 emitted accusation events는 순서와 결과가 일치한다.
- RNG draw를 소비한 transition은 `rng.state`와 `rng.draws`를 함께 갱신한다.
- input state와 모든 nested collection은 mutation되지 않는다.
- hidden truth의 authoritative impostor field는 하나뿐이다.

## Replay envelope

```ts
type ReplayEntry = Readonly<{
  sequence: number;
  stateRevisionBefore: number;
  command: CommandV2;
  context: Readonly<{
    nowMs: number;
    rngStateBefore: number;
  }>;
  expectedEventIds: readonly string[];
  stateHashAfter: string;
}>;
```

Replay는 initial state와 ordered entries를 reducer에 다시 적용해 event IDs, RNG state, outcome, state hash를 검증한다. 외부 effect의 실제 실행 결과는 domain replay 입력이 아니며, 필요하면 후속 explicit command로 기록한다.

## Migration mapping

| V1 | V2 |
|---|---|
| `hidden_host_role` 및 여러 legacy impostor field | `hidden.impostorRole` 하나 |
| `game_state.dead_roles` | `crew[role].status/death` |
| `game_state.triggered_kill_marks` | `clock.triggeredThresholdsSec` |
| `game_state.clues` | `resources.evidence` |
| `game_state.pistol_holder` | `resources.pistolHolder` |
| `game_state.accuse_history` | `accusation.history` |
| `game_state.game_over/outcome` | `phase='RESOLVED'` + structured `outcome` |
| top-level `turn` | canonical `turn` |
| `game_state.locale`, names, emotion fields | domain 밖 전용 state |
