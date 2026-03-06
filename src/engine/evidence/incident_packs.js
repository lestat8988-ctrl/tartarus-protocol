/**
 * Incident Packs - Evidence configuration for Tartarus Protocol
 * primaryByRole: trueEvidence(진짜 1줄) + redHerringEvidence(레드헤링 1줄) → 2줄 출력, 시간 랜덤화
 */
const CREW = ['Navigator', 'Engineer', 'Doctor', 'Pilot'];

const TIME_POOL = ['00:15', '00:45', '01:15', '01:30', '01:58', '02:15', '02:31', '02:47', '03:12', '03:30', '04:03', '04:15', '04:45', '05:00'];

function buildPrimaryByRole(trueTpl, redTpl) {
  const roleEntries = CREW.map((r) => [
    r,
    {
      trueEvidence: trueTpl.map((t) => t.replace(/%ROLE%/g, r)),
      redHerringEvidence: redTpl
    }
  ]);
  return Object.fromEntries(roleEntries);
}

const PRIMARY_TRUE = [
  '[SYSTEM] Access log: %ROLE% — unauthorized %CMD% query at %TIME%',
  '[SYSTEM] Checksum mismatch on %CMD% channel — source: %ROLE%',
  '[SYSTEM] Log fragment: %ROLE% accessed %CMD% channel at %TIME%. Verified.'
];
const PRIMARY_RED = [
  '[SYSTEM] Access log: %ROLE% — unauthorized %CMD% query at %TIME%',
  '[SYSTEM] Checksum mismatch on %CMD% channel — source: %ROLE%',
  '[SYSTEM] Suspicious activity: %ROLE% near %CMD% terminal at %TIME%'
];

// INTERROGATE 전용: 크루 대사만 (crew interrogation dialogue)
const INTERROGATE_CREW_BLOCKS = [
  "Navigator: Captain, I've been monitoring the corridors. Someone has been tampering with the logs.\nEngineer: Don't look at me! The Doctor's been acting strange since the jump.\nDoctor: Stress affects us all. The Pilot has been muttering to himself.\nPilot: We're all losing it. The ship... it's watching.",
  "Engineer: Captain, the engine room—something's wrong. I heard scratching. From inside the walls.\nDoctor: Hallucinations. The warp exposure...\nNavigator: Or it's real. One of us brought it back.\nPilot: We need to find who. Before it's too late.",
  "Doctor: Captain, I've run diagnostics. The crew's vitals are... off. One of us isn't fully human anymore.\nNavigator: The entity. It possessed someone.\nEngineer: How do we know who?\nPilot: We don't. We guess. Or we die.",
  "Navigator: Captain, we need to act. The entity is among us.\nEngineer: But which one?\nDoctor: Observe. The possessed one will slip.\nPilot: Or we all die waiting.",
  "Pilot: Captain, the void is calling. I hear it. We all do.\nDoctor: Ignore it. Focus on the mission.\nEngineer: Easy for you to say. You're not the one it's whispering to.\nNavigator: Stay focused. Find the imposter."
];

// sync 전용: [SYSTEM] sync 채널 / 로그 조각 / 권한 불명 / 체크섬
const SYNC_CHANNEL_LINES = [
  '[SYSTEM] Sync channel: nominal. No unauthorized access in time window.',
  '[SYSTEM] Access log: [REDACTED] — sync query at %TIME%. Clearance unknown.',
  '[SYSTEM] Sync channel checksum nominal. No anomaly.',
  '[SYSTEM] Log fragment: [REDACTED] accessed sync terminal at %TIME%. Verified.',
  '[SYSTEM] Interrogate logs: no anomaly. All statements within protocol.',
  '[SYSTEM] Sync terminal access at %TIME%. Source redacted.',
  '[SYSTEM] Sync checksum mismatch in window %TIME%. Investigating.',
  '[SYSTEM] Corridor logs: sync query at %TIME%. Identity withheld.',
  '[SYSTEM] Sync channel: partial log at %TIME%. No breach detected.',
  '[SYSTEM] Unauthorized sync access attempt at %TIME%. Blocked.'
];

// CCTV 전용: [SYSTEM] CCTV 조각 / 손상 로그 / 시야 단서
const CCTV_CHANNEL_LINES = [
  '[SYSTEM] CCTV logs corrupted. Partial data recovered.',
  '[SYSTEM] CCTV timestamp anomaly: %TIME%. Partial recovery.',
  '[SYSTEM] CCTV footage: corridor 7. [REDACTED] at %TIME%.',
  '[SYSTEM] CCTV: engine room access logged at %TIME%. Identity redacted.',
  '[SYSTEM] CCTV fragment: [REDACTED] near airlock at %TIME%.',
  '[SYSTEM] CCTV feed gap: %TIME%. Partial frames only.',
  '[SYSTEM] CCTV: corridor 3 motion at %TIME%. Source unknown.',
  '[SYSTEM] CCTV damage log: sector 5 at %TIME%. Recovering.',
  '[SYSTEM] CCTV blind spot: %TIME%. No coverage in sector.',
  '[SYSTEM] CCTV override detected at %TIME%. Audit trail redacted.'
];

// nav 전용: [SYSTEM] nav 쿼리 / 항법 채널 / 접근 기록
const NAV_CHANNEL_LINES = [
  '[SYSTEM] Nav channel: [REDACTED] accessed nav terminal at %TIME%. Partial recovery.',
  '[SYSTEM] Access log: [REDACTED] — nav query at %TIME%. Clearance unknown.',
  '[SYSTEM] Nav channel checksum nominal. No anomaly in time window.',
  '[SYSTEM] Log fragment: [REDACTED] accessed nav channel at %TIME%. Verified.',
  '[SYSTEM] Gravity Drive log: access at %TIME%. Source redacted.',
  '[SYSTEM] Nav terminal query at %TIME%. Identity withheld.',
  '[SYSTEM] Navigation logs: unauthorized access at %TIME%.',
  '[SYSTEM] Nav channel drift check at %TIME%. Nominal.',
  '[SYSTEM] Waypoint query at %TIME%. [REDACTED]. Verified.',
  '[SYSTEM] Nav checksum: anomaly at %TIME%. Under review.'
];

// ENGINE 전용: [SYSTEM] 기관실 상태 / 밀봉 / 원자로 / 출입 기록
const ENGINE_CHANNEL_LINES = [
  '[SYSTEM] Engine room log: reactor stable at %TIME%. No unauthorized access.',
  '[SYSTEM] Reactor damage: CRITICAL. Repair impossible while entity presence detected.',
  '[SYSTEM] Reactor readings nominal. Access record at %TIME%.',
  '[SYSTEM] Engine room seal intact. No breach at %TIME%.',
  '[SYSTEM] Core access log: %TIME%. The thing is feeding on the core.',
  '[SYSTEM] Engine room: pressure nominal at %TIME%. Seal verified.',
  '[SYSTEM] Reactor coolant flow at %TIME%. Within spec.',
  '[SYSTEM] Engine room entry at %TIME%. [REDACTED]. Logged.',
  '[SYSTEM] Core breach scan at %TIME%. Negative.',
  '[SYSTEM] Engine room hatch: sealed at %TIME%. No tampering.',
  '[SYSTEM] Maintenance log: reactor output fluctuation at %TIME%. Within tolerance.',
  '[SYSTEM] Cooling system response: nominal at %TIME%. No anomaly.',
  '[SYSTEM] Engine room bulkhead status at %TIME%. Sealed.'
];

// time 전용: [SYSTEM] time 채널 / 시간축 불일치 / 순서 어긋남 / 체크섬
const TIME_CHANNEL_LINES = [
  '[SYSTEM] Time channel: [REDACTED] accessed at %TIME%. Logs confirm.',
  '[SYSTEM] Timestamp anomaly: %TIME%. Partial data recovered.',
  '[SYSTEM] Time sync nominal. No drift at %TIME%.',
  '[SYSTEM] Chronometer log: access at %TIME%. Verified.',
  '[SYSTEM] Time channel checksum nominal. No anomaly.',
  '[SYSTEM] Time sequence mismatch at %TIME%. Order corrupted.',
  '[SYSTEM] Chrono drift at %TIME%. Investigating.',
  '[SYSTEM] Time channel: [REDACTED] query at %TIME%. Source redacted.',
  '[SYSTEM] Timestamp out of order at %TIME%. Audit required.',
  '[SYSTEM] Time sync checksum: anomaly at %TIME%. Partial recovery.',
  '[SYSTEM] Timeline inconsistency: %TIME%. Record gap detected.',
  '[SYSTEM] Timestamp reversal at %TIME%. Sequence corrupted.',
  '[SYSTEM] Chrono log fragment: %TIME%. Partial recovery.'
];

const INCIDENT_PACKS = [
  {
    id: 'A',
    commands: ['Interrogate', 'CCTV', 'Engine'],
    extrasByCommand: {
      Interrogate: { hint: 'corridor_logs' },
      CCTV: { hint: 'engine_room_access' },
      Engine: { hint: 'reactor_readings' }
    },
    primaryByRole: buildPrimaryByRole(PRIMARY_TRUE, PRIMARY_RED),
    redHerringByRole: {
      Navigator: [
        'Navigator: I saw someone near the airlock. The logs were tampered.',
        'Navigator: The warp signature was corrupted before we jumped.'
      ],
      Engineer: [
        'Engineer: The reactor damage pattern suggests external interference.',
        'Engineer: Someone accessed the core at 02:47. Clearance logs are missing.'
      ],
      Doctor: [
        'Doctor: Vitals show one crew member has anomalous readings since the jump.',
        'Doctor: The autopsy bay was accessed. Someone was dissecting something.'
      ],
      Pilot: [
        'Pilot: Bulkhead seals were manually overridden. Someone wanted an exit.',
        'Pilot: I heard scratching from inside the walls. Near the engine room.'
      ]
    },
    exculpatoryByRole: {
      Navigator: 'Navigator was in the bridge during the incident. Logs confirm.',
      Engineer: 'Engineer was repairing sector 7. Multiple witnesses.',
      Doctor: 'Doctor was in medbay. Biometric lock records prove presence.',
      Pilot: 'Pilot was in cockpit. Flight recorder timestamp matches.'
    }
  },
  {
    id: 'B',
    commands: ['Interrogate', 'CCTV', 'Engine'],
    extrasByCommand: {
      Interrogate: { hint: 'stress_patterns' },
      CCTV: { hint: 'corridor_footage' },
      Engine: { hint: 'core_breach' }
    },
    primaryByRole: buildPrimaryByRole(PRIMARY_TRUE, PRIMARY_RED),
    redHerringByRole: {
      Navigator: [
        'Navigator: Someone has been muttering in a non-human language.',
        'Navigator: The Doctor has been in the autopsy bay alone too often.'
      ],
      Engineer: [
        'Engineer: The Pilot was near the engine room before the last kill.',
        'Engineer: Gravity Drive logs show unauthorized access.'
      ],
      Doctor: [
        'Doctor: The Engineer\'s vitals have been off since the jump.',
        'Doctor: Navigator\'s claustrophobia—the entity exploits our fears.'
      ],
      Pilot: [
        'Pilot: The Engineer was alone with the core. Plenty of time.',
        'Pilot: Doctor has been dissecting something. Not the bodies.'
      ]
    },
    exculpatoryByRole: {
      Navigator: 'Navigator was monitoring from bridge. No physical access to scene.',
      Engineer: 'Engineer was in sector 7. CCTV confirms.',
      Doctor: 'Doctor was treating Navigator. Medbay logs verify.',
      Pilot: 'Pilot was running diagnostics. Cockpit sealed.'
    }
  },
  {
    id: 'C',
    commands: ['Interrogate', 'CCTV', 'Engine'],
    extrasByCommand: {
      Interrogate: { hint: 'witness_statements' },
      CCTV: { hint: 'timestamp_anomaly' },
      Engine: { hint: 'entity_feed' }
    },
    primaryByRole: buildPrimaryByRole(PRIMARY_TRUE, PRIMARY_RED),
    redHerringByRole: {
      Navigator: [
        'Navigator: The entity rewrites the host. They look human. They\'re not.',
        'Navigator: All senior crew have clearance. We\'re all suspects.'
      ],
      Engineer: [
        'Engineer: The thing is feeding on the core. Purge the host first.',
        'Engineer: Repair impossible while entity presence detected.'
      ],
      Doctor: [
        'Doctor: One of us has changed. Since the jump. Psychological profiles.',
        'Doctor: The crew are hallucinating. I\'ve seen things in the corridors.'
      ],
      Pilot: [
        'Pilot: The void is calling. We all hear it.',
        'Pilot: We need to seal the rift. Before IT pulls us back.'
      ]
    },
    exculpatoryByRole: {
      Navigator: 'Navigator was in navigation pod. Pod seal was intact.',
      Engineer: 'Engineer was with Doctor. Both alibi each other.',
      Doctor: 'Doctor was running diagnostics. System logs confirm.',
      Pilot: 'Pilot was in airlock maintenance. Work order on file.'
    }
  },
  {
    id: 'D',
    commands: ['Interrogate', 'CCTV', 'Engine'],
    extrasByCommand: {
      Interrogate: { hint: 'behavioral_shift' },
      CCTV: { hint: 'access_logs' },
      Engine: { hint: 'reactor_drain' }
    },
    primaryByRole: buildPrimaryByRole(PRIMARY_TRUE, PRIMARY_RED),
    redHerringByRole: {
      Navigator: [
        'Navigator: The Doctor was acting erratic. I don\'t trust them.',
        'Navigator: Someone tampered with the logs. Engineer has access.'
      ],
      Engineer: [
        'Engineer: I can try to seal the rift. But I need time.',
        'Engineer: The entity is clever. It hides in our skin.'
      ],
      Doctor: [
        'Doctor: I saw the Pilot near the engine room. Before the incident.',
        'Doctor: Navigator\'s too calm. Like they\'re wearing a mask.'
      ],
      Pilot: [
        'Pilot: Navigator\'s been watching us. Recording. Why?',
        'Pilot: Find the imposter. Then we repair.'
      ]
    },
    exculpatoryByRole: {
      Navigator: 'Navigator was in comms. Transmission logs prove location.',
      Engineer: 'Engineer was in cargo bay. Weight sensors logged entry.',
      Doctor: 'Doctor was in quarantine. Door was sealed from inside.',
      Pilot: 'Pilot was in cockpit. Autopilot engaged, cannot leave.'
    }
  },
  {
    id: 'E',
    commands: ['Interrogate', 'CCTV', 'Engine'],
    extrasByCommand: {
      Interrogate: { hint: 'possession_signs' },
      CCTV: { hint: 'gravity_drive_access' },
      Engine: { hint: 'purge_required' }
    },
    primaryByRole: buildPrimaryByRole(PRIMARY_TRUE, PRIMARY_RED),
    redHerringByRole: {
      Navigator: [
        'Navigator: The timestamps are wrong. Something altered them.',
        'Navigator: I see someone near the engine room. Before the last kill.'
      ],
      Engineer: [
        'Engineer: How do we know who? We don\'t. We guess. Or we die.',
        'Engineer: The warp exposure causes hallucinations.'
      ],
      Doctor: [
        'Doctor: The entity possessed someone. One of us isn\'t human anymore.',
        'Doctor: Stress affects us all. The Pilot has been muttering.'
      ],
      Pilot: [
        'Pilot: We\'re all losing it. The ship... it\'s watching.',
        'Pilot: That could be any of us!'
      ]
    },
    exculpatoryByRole: {
      Navigator: 'Navigator was in observatory. Door locked from inside.',
      Engineer: 'Engineer was in life support. Oxygen mix logs confirm.',
      Doctor: 'Doctor was in surgery. Procedure took 4 hours.',
      Pilot: 'Pilot was in simulator. Training log exists.'
    }
  },
  {
    id: 'F',
    commands: ['Interrogate', 'CCTV', 'Engine'],
    extrasByCommand: {
      Interrogate: { hint: 'host_identification' },
      CCTV: { hint: 'redacted_fragment' },
      Engine: { hint: 'seal_impossible' }
    },
    primaryByRole: buildPrimaryByRole(PRIMARY_TRUE, PRIMARY_RED),
    redHerringByRole: {
      Navigator: [
        'Navigator: The entity is among us. Observe. The possessed one will slip.',
        'Navigator: We have to find the host. Before there\'s no one left.'
      ],
      Engineer: [
        'Engineer: It\'s testing us. Picking us off.',
        'Engineer: We\'re hunting a ghost in a meat suit.'
      ],
      Doctor: [
        'Doctor: Ignore it. Focus on the mission.',
        'Doctor: One of us has changed. Since the jump.'
      ],
      Pilot: [
        'Pilot: Easy for you to say. You\'re not the one it\'s whispering to.',
        'Pilot: Or we all get pulled back to... wherever it came from.'
      ]
    },
    exculpatoryByRole: {
      Navigator: 'Navigator was in storage. Inventory scan confirms presence.',
      Engineer: 'Engineer was in electrical. Circuit logs show activity.',
      Doctor: 'Doctor was in lab. Specimen logs timestamp match.',
      Pilot: 'Pilot was in hangar. Bay door was sealed.'
    }
  }
];

// PACKS 키: 한 글자(F) 또는 전체(F_NAV_CLOCK_DRIFT) - 한 글자면 해당 id로, 전체면 첫 글자로 pack 조회 // PATCH
function getPackById(packId) {
  const id = String(packId || '').trim();
  let p = INCIDENT_PACKS.find((pack) => pack.id === id);
  if (!p && id.length > 1) {
    const shortId = id.split('_')[0] || id[0];
    p = INCIDENT_PACKS.find((pack) => pack.id === shortId);
  }
  if (!p) throw new Error(`Unknown packId: ${packId}`);
  return p;
}

module.exports = {
  INCIDENT_PACKS, CREW, getPackById, TIME_POOL,
  INTERROGATE_CREW_BLOCKS, SYNC_CHANNEL_LINES, CCTV_CHANNEL_LINES,
  NAV_CHANNEL_LINES, ENGINE_CHANNEL_LINES, TIME_CHANNEL_LINES
};
