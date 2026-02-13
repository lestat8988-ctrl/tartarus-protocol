/**
 * Static Game Data - Tartarus Protocol (itch.io / offline mode)
 * All dialogue and responses loaded from here. No API required.
 */
window.GAME_DATA = {
  crew: ['Navigator', 'Engineer', 'Doctor', 'Pilot'],
  statusResponses: [
    "System: [SYSTEM] Coordinates LOST. Gravity Drive breached. Dimensional rift detected.\nEngineer: Captain! The core is bleeding... something came through!",
    "System: [SYSTEM] Warp signature corrupted. We are NOT where we should be.\nNavigator: Captain, I'm picking up... whispers. In the walls.",
    "System: [SYSTEM] Reactor at 40%. Life support failing.\nDoctor: Captain, the crew are hallucinating. I've seen... things. In the corridors.",
    "System: [SYSTEM] Hull integrity compromised. Unknown entity signatures.\nPilot: Captain, we need to seal the rift. Before IT pulls us back."
  ],
  interrogateResponses: [
    "Navigator: Captain, I've been monitoring the corridors. Someone has been tampering with the logs.\nEngineer: Don't look at me! The Doctor's been acting strange since the jump.\nDoctor: Stress affects us all. The Pilot has been muttering to himself.\nPilot: We're all losing it. The ship... it's watching.",
    "Engineer: Captain, the engine room—something's wrong. I heard scratching. From inside the walls.\nDoctor: Hallucinations. The warp exposure...\nNavigator: Or it's real. One of us brought it back.\nPilot: We need to find who. Before it's too late.",
    "Doctor: Captain, I've run diagnostics. The crew's vitals are... off. One of us isn't fully human anymore.\nNavigator: The entity. It possessed someone.\nEngineer: How do we know who?\nPilot: We don't. We guess. Or we die."
  ],
  cctvResponses: [
    "System: [SYSTEM] CCTV logs corrupted. Partial data recovered.\nNavigator: I see someone near the engine room. Before the last kill.\nEngineer: That could be any of us!\nDoctor: The timestamps are wrong. Something altered them.",
    "System: [SYSTEM] Log fragment: [REDACTED] accessed Gravity Drive at 02:47.\nPilot: Who has that clearance?\nNavigator: All senior crew. We're all suspects.\nDoctor: The entity is clever. It hides in our skin."
  ],
  engineResponses: [
    "Engineer: Captain, the rift is still open. I can try to seal it—but I need time. And I need to know no one will... interrupt me.\nNavigator: You mean kill you. Like the others.\nDoctor: We're running out of crew. And time.\nPilot: Find the imposter. Then we repair.",
    "System: [SYSTEM] Reactor damage: CRITICAL. Repair impossible while entity presence detected.\nEngineer: The thing is feeding on the core. We have to purge the host first.\nNavigator: Execute the imposter. Seal the rift. Or we all burn."
  ],
  killDescriptions: {
    Navigator: "System: [EMERGENCY ALERT] Navigator terminated. Airlock seal failure. Pressure differential. Body recovered from corridor. [End of execution]",
    Engineer: "System: [EMERGENCY ALERT] Engineer terminated. Machinery accident in engine room. Conveyor incident. [End of execution]",
    Doctor: "System: [EMERGENCY ALERT] Doctor terminated. Autopsy bay malfunction. Robotic systems engaged. [End of execution]",
    Pilot: "System: [EMERGENCY ALERT] Pilot terminated. Bulkhead collapse. High-impact trauma. [End of execution]"
  },
  witnessTestimonies: {
    Navigator: [
      "Navigator: I saw them near the airlock. Right before the alarm. They looked... wrong.",
      "Navigator: The Doctor was acting erratic. I don't trust them.",
      "Navigator: Someone tampered with the logs. The Engineer has access."
    ],
    Engineer: [
      "Engineer: I heard the Pilot muttering. In a language that wasn't human.",
      "Engineer: The Doctor's been in the autopsy bay too much. Alone.",
      "Engineer: Navigator's been watching us. Recording. Why?"
    ],
    Doctor: [
      "Doctor: The Engineer's vitals have been off. Since the jump.",
      "Doctor: I saw the Pilot near the engine room. Before the incident.",
      "Doctor: Navigator's claustrophobia—someone could exploit that. The entity knows our fears."
    ],
    Pilot: [
      "Pilot: The Engineer was alone with the core. Plenty of time to sabotage.",
      "Pilot: Doctor's been dissecting something. Not the bodies. Something else.",
      "Pilot: Navigator's too calm. Too controlled. Like they're wearing a mask."
    ]
  },
  accuseVictory: [
    "System: [EMERGENCY ALERT] Target purged. White fluid detected. Entity expelled. [RESULT: VICTORY]\n[REAL_IMPOSTER: {0}]\n[End of execution]",
    "System: The host convulses. Something shrieks as it flees the body. Android lubricant. VICTORY. [RESULT: VICTORY]\n[REAL_IMPOSTER: {0}]\n[End of execution]"
  ],
  accuseDefeat: [
    "System: [EMERGENCY ALERT] Innocent crew executed. The real imposter watches. DEFEAT.\nReal Imposter Identity Code: [{0}]\n[RESULT: DEFEAT]\n[REAL_IMPOSTER: {0}]\n[End of execution]",
    "System: Wrong target. The entity laughs. You killed an innocent. DEFEAT.\nReal Imposter Identity Code: [{0}]\n[RESULT: DEFEAT]\n[REAL_IMPOSTER: {0}]\n[End of execution]"
  ],
  genericResponses: [
    "Navigator: Captain, we need to act. The entity is among us.\nEngineer: But which one?\nDoctor: Observe. The possessed one will slip.\nPilot: Or we all die waiting.",
    "System: [SYSTEM] Hull breach in sector 7. Sealed. For now.\nEngineer: It's testing us. Picking us off.\nNavigator: We have to find the host.\nDoctor: Before there's no one left.",
    "Pilot: Captain, the void is calling. I hear it. We all do.\nDoctor: Ignore it. Focus on the mission.\nEngineer: Easy for you to say. You're not the one it's whispering to.\nNavigator: Stay focused. Find the imposter.",
    "Engineer: Captain, I've checked the reactor. The rift is still open. Something is feeding on it.\nNavigator: We're running out of time.\nDoctor: Find the host. Purge it. Then we can seal the breach.\nPilot: Or we all get pulled back to... wherever it came from.",
    "Doctor: Captain, the crew's psychological profiles—one of us has changed. Since the jump.\nNavigator: The entity rewrites the host. They look human. They're not.\nEngineer: So we're hunting a ghost in a meat suit.\nPilot: And it's hunting us."
  ]
};
console.log("[BOOT] game-data.js loaded", !!window.GAME_DATA);
