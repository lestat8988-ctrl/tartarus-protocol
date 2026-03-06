/**
 * ko_translate.js - window.__KO_T(line) 한 줄 번역
 * 우선순위: (1) __KO_MAP 정확 일치 (2) 정규식 패턴 (3) 원문
 */
(function () {
  var ROLE_KO = {
    navigator: '네비게이터',
    engineer: '엔지니어',
    doctor: '닥터',
    pilot: '파일럿'
  };

  function toRoleKo(role) {
    if (!role || typeof role !== 'string') return role;
    var k = role.trim().toLowerCase();
    return ROLE_KO[k] || role;
  }

  function translateLine(line) {
    if (!line || typeof line !== 'string') return line;
    var s = String(line).trim();
    if (!s) return line;

    // (0) System: / System: 접두어 → 시스템: + rest 번역 // PATCH
    var sysPrefix = '';
    if (s.indexOf('System: ') === 0) { sysPrefix = '시스템: '; s = s.slice(8).trim(); } // PATCH
    else if (s.indexOf('System:') === 0) { sysPrefix = '시스템: '; s = s.slice(7).trim(); } // PATCH
    if (sysPrefix && !s) return sysPrefix; // PATCH

    // (1) __KO_MAP 정확 일치
    if (window.__KO_MAP && window.__KO_MAP[s] !== undefined) {
      var out = window.__KO_MAP[s];
      return sysPrefix ? sysPrefix + out : out; // PATCH
    }

    // (1.5) __KO_PATTERNS 정규식 규칙 // PATCH
    if (window.__KO_PATTERNS && Array.isArray(window.__KO_PATTERNS)) { // PATCH
      for (var i = 0; i < window.__KO_PATTERNS.length; i++) { // PATCH
        var p = window.__KO_PATTERNS[i]; // PATCH
        var m = s.match(p.re); // PATCH
        if (m) { var out = p.fn(m); return sysPrefix ? sysPrefix + out : out; } // PATCH
      } // PATCH
    } // PATCH

    // (2) 정규식 패턴
    // A) [SYSTEM] Access log: <ROLE> — unauthorized <CMD> query at <HH:MM>
    var m1 = s.match(/^\[SYSTEM\] Access log:\s*(.+?)\s*—\s*unauthorized\s+(\S+)\s+query\s+at\s+(\d{2}:\d{2})$/i);
    if (m1) {
      var out = '[SYSTEM] 접속 로그: ' + toRoleKo(m1[1]) + ' — ' + m1[2] + ' 쿼리 무단 조회 ' + m1[3];
      return sysPrefix ? sysPrefix + out : out; // PATCH
    }

    // B) [SYSTEM] Checksum mismatch on <CMD> channel — source: <ROLE>
    var m2 = s.match(/^\[SYSTEM\] Checksum mismatch on\s+(\S+)\s+channel\s*—\s*source:\s*(.+)$/i);
    if (m2) {
      var ch = (m2[1] || '').trim().toLowerCase();
      var out = '[SYSTEM] ' + ch + ' 채널 체크섬 불일치 — 출처: ' + toRoleKo(m2[2].trim());
      return sysPrefix ? sysPrefix + out : out; // PATCH
    }

    // B2) [SYSTEM] Suspicious activity: <ROLE> near <CMD> terminal at <TIME>
    var m2b = s.match(/^\[SYSTEM\]\s*Suspicious activity:\s*(Navigator|Engineer|Doctor|Pilot)\s+near\s+(\S+)\s+terminal\s+at\s+(\d{2}:\d{2})$/i);
    if (m2b) {
      var roleKo = toRoleKo(m2b[1]);
      var josa = (window.__KO_JOSA_IGA && window.__KO_JOSA_IGA(roleKo)) || '가';
      var term = (m2b[2] || '').trim().toLowerCase();
      var out = '[SYSTEM] 수상한 활동: ' + roleKo + josa + ' ' + m2b[3] + '에 ' + term + ' 터미널 근처에 있었습니다.';
      return sysPrefix ? sysPrefix + out : out;
    }

    // B3) [SYSTEM] Log fragment: <ROLE> accessed <CMD> channel at <TIME>. Verified.
    var m2c = s.match(/^\[SYSTEM\]\s*Log fragment:\s*(Navigator|Engineer|Doctor|Pilot)\s+accessed\s+(\S+)\s+channel\s+at\s+(\d{2}:\d{2})\.\s*Verified\.$/i);
    if (m2c) {
      var ch2 = (m2c[2] || '').trim().toLowerCase();
      var out = '[SYSTEM] 로그 조각: ' + toRoleKo(m2c[1]) + ' ' + m2c[3] + '에 ' + ch2 + ' 채널 접근. 확인됨.';
      return sysPrefix ? sysPrefix + out : out;
    }

    // B4) [SYSTEM] Security flag: <ROLE> accessed <X> ... at <TIME>
    var m2d = s.match(/^\[SYSTEM\]\s*Security flag:\s*(Navigator|Engineer|Doctor|Pilot)\s+accessed\s+(\S+)\s+.*at\s+(\d{2}:\d{2})/i);
    if (m2d) {
      var out = '[SYSTEM] 보안 플래그: ' + toRoleKo(m2d[1]) + ' ' + m2d[3] + '에 ' + m2d[2] + ' 접근.';
      return sysPrefix ? sysPrefix + out : out;
    }

    // C) Real Imposter Identity Code: [<ROLE>]
    var m3 = s.match(/^Real Imposter Identity Code:\s*\[(.+?)\]$/i);
    if (m3) {
      var out = '실제 임포스터 신원 코드: [' + toRoleKo(m3[1].trim()) + ']';
      return sysPrefix ? sysPrefix + out : out; // PATCH
    }

    // D) >> Terminal keyword available: <CMD>
    var m4 = s.match(/^>>\s*Terminal keyword available:\s*(.+)$/i);
    if (m4) {
      var out = '>> 사용 가능한 터미널 키워드: ' + m4[1].trim();
      return sysPrefix ? sysPrefix + out : out; // PATCH
    }

    // E) [EMERGENCY ALERT] <ROLE> terminated... (rest 조각 번역 적용)
    var m5 = s.match(/^\[EMERGENCY ALERT\]\s+(Navigator|Engineer|Doctor|Pilot)\s+terminated\.?\s*(.*)$/i);
    if (m5) {
      var rest = (m5[2] || '').trim();
      rest = rest
        .replace(/Machinery accident in engine room\.?/gi, '기관실 기계 사고.')
        .replace(/Conveyor incident\.?/gi, '컨베이어 사고.')
        .replace(/Autopsy bay malfunction\.?/gi, '부검실 시스템 오작동.')
        .replace(/Robotic systems engaged\.?/gi, '로봇 시스템 가동.')
        .replace(/Airlock seal failure\.?/gi, '에어락 밀봉 실패.')
        .replace(/Pressure differential\.?/gi, '기압차.')
        .replace(/Body recovered from corridor\.?/gi, '회수 불가.')
        .replace(/Bulkhead collapse\.?/gi, '격벽 붕괴.')
        .replace(/High-impact trauma\.?/gi, '생체 신호: 0.')
        .replace(/\[End of execution\]/gi, '[처리 종료]');
      var out = '[긴급 경보] ' + toRoleKo(m5[1]) + ' 사망.' + (rest ? ' ' + rest : '');
      return sysPrefix ? sysPrefix + out : out;
    }

    // (3) 원문
    return sysPrefix ? sysPrefix + s : line; // PATCH: System 접두어 있으면 prefix + rest
  }

  window.__KO_T = translateLine;
  window.__KO_TRANSLATE = translateLine; // PATCH: alias
  window.__KO_ROLE = toRoleKo; // PATCH: 역할 영어→한글 helper (Engineer→엔지니어 등)
})();
