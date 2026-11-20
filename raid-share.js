// 진행중 레이드 화면 공유 - dev.html이 [화면 공유]를 처음 누를 때만 불러온다(평소 로딩에 영향 없음).
// 운영 승격 때는 이 파일을 raid-share.js로 복사한다(index.html은 raid-share.js를 불러옴).
// dev.html의 전역(함수, let 변수)을 그대로 쓴다 - 일반 <script>끼리는 최상위 let/const도 공유된다.
//
// 하는 일(게임 창을 공유받아 2초마다 일부만 읽는다. 화면은 이 PC 안에서만 처리하고 어디에도 보내지 않음):
//  1) 입장 창(가운데): 레이드/난이도/남은 골드 횟수를 읽어 내 캐릭터가 여기서 골드를 받아도 되는지 판단,
//     받지 말아야 하면 "삐" 소리 + 사이트 알림창. 관리자 모드면 직전에 읽은 파티창 인원으로 참여 캐릭터 자동 변경(정확 일치만).
//  2) 파티창(오른쪽): 파티원 이름. "모집 상세 정보" 글자 위치로 영역을 자동으로 찾는다.
//  3) 레이드 안 왼쪽 위 "골드 보상 설정": 골드 알림 자동 닫기 + 일정표 밖 레이드면 내 캐릭터 완료 체크(실제로 들어간 게 확인될 때).
//  4) [ESC 읽기] 버튼(수동): 게임 메뉴 레이드 목록으로 캐릭터 현황 완료 체크를 맞춘다("참여 완료" 체크, "참여 가능"이면 개별 체크 해제).
//  ESC 자동 요청은 2026-11-20에 뺐다(입장 창이 떠 있으면 ESC를 못 눌러 파티창 단계에서 미리 물어야 했고 대부분 필요 없었음).
(function () {
  'use strict';

  const TICK_MS = 2000;
  const PARTY_EVERY = 3;              // 파티창은 3박자마다
  const PARTY_RELOCATE_MIN_MS = 15000; // 파티창 다시 찾기 최소 간격(화면 전체 읽기는 1~3초 걸림)
  const PARTY_FRESH_MS = 3 * 60 * 1000;
  const CLEAR_WATCH_MS = 5 * 60 * 1000; // 입장 창 뒤 레이드 안 화면을 기다리는 시간(파티원 수락 대기 포함)
  const PARTY_REGION_KEY = 'loa_share_party_region';
  // 입장 창은 항상 가운데라 화면 비율로 충분하다(1337~1919px 창모드 스샷 4장 기준 + 여유).
  const DIALOG_REGION = { x: 0.385, y: 0.27, w: 0.23, h: 0.46 };
  const DEFAULT_PARTY_REGION = { x: 0.665, y: 0.15, w: 0.335, h: 0.45 }; // 16인(파티 4개)까지
  // 게임 화면 이름 → 레이드 계열(getRaidFamilyKey로 안 잡히는 것만). 입장 창은 보스 이름, 파티창은 지역 이름으로 나온다.
  const GAME_RAID_ALIASES = [
    ['코르부스', 'serka'], ['고통의 마녀', 'serka'], ['빙결의 성소', 'serka'],
    ['크라그마', 'belga'], ['계율자', 'belga'], ['안식의 묘원', 'belga'],
    ['카제로스', 'final'], ['최후의 날', 'final'],
    ['파멸의 성채', 'act4'], ['지평', 'cathedral'], ['구원의 종탑', 'cathedral'], ['종탑', 'cathedral']
  ];

  let stream = null, video = null, tickWorker = null, busy = false, tickNo = 0;
  let frame = null;                    // 재사용 캔버스(매 박자 전체 프레임)
  let partyRegion = loadPartyRegion(), partyMiss = 0, lastLocateAt = 0;
  let lastParty = null;                // { at, items, names }
  let dialogOpen = false;
  let clearWatch = null;               // { charName, famKey, until } 일정표 밖 레이드 완료 체크 대기
  const ESC_WAIT_MS = 45000;           // [ESC 읽기] 누른 뒤 게임 메뉴를 기다리는 시간
  let escRequest = null;               // { until }
  const logs = [];

  // ─── 시작/중지 ───────────────────────────────────────────
  async function start(mediaStream) {
    stop(true);
    stream = mediaStream;
    video = document.createElement('video');
    video.muted = true; video.srcObject = stream;
    await video.play();
    stream.getVideoTracks()[0].addEventListener('ended', () => stop());
    frame = document.createElement('canvas');
    renderBar();
    setHeaderActive(true);
    setStatus('인식 데이터 준비 중...');
    await loadScreenOcrWorker();
    const s = stream.getVideoTracks()[0].getSettings();
    log(`공유 시작 ${s.width}x${s.height}`);
    setStatus('화면 공유 중 - 입장 창/파티창을 읽고 있습니다');
    // 탭이 가려져도 박자가 늦춰지지 않게 워커 안 타이머를 쓴다.
    const src = `setInterval(() => postMessage(0), ${TICK_MS});`;
    tickWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    tickWorker.onmessage = onTick;
  }

  function stop(silent) {
    if (tickWorker) tickWorker.terminate();
    tickWorker = null;
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; video = null; clearWatch = null; escRequest = null; dialogOpen = false;
    setHeaderActive(false);
    const bar = document.getElementById('raidShareBar');
    if (bar) bar.remove();
    if (!silent) log('공유 중지');
  }

  function isActive() { return !!stream; }

  // ─── 박자 ───────────────────────────────────────────────
  async function onTick() {
    if (!stream || busy || !video || !video.videoWidth) return;
    busy = true;
    try {
      tickNo++;
      grabFrame();
      await processFrame(frame);
    } catch (e) {
      log('오류: ' + (e && e.message ? e.message : e));
    } finally {
      busy = false;
    }
  }

  function grabFrame() {
    if (frame.width !== video.videoWidth || frame.height !== video.videoHeight) {
      frame.width = video.videoWidth; frame.height = video.videoHeight;
    }
    frame.getContext('2d').drawImage(video, 0, 0);
  }

  // 한 프레임 처리(시험 때는 스샷 캔버스를 바로 넣을 수 있게 분리).
  async function processFrame(f) {
    if (escRequest) {
      if (Date.now() > escRequest.until) { escRequest = null; setStatus('게임 메뉴를 못 찾았습니다 - 본인 캐릭터로 ESC를 열고 다시 [ESC 읽기]'); }
      else { await scanEsc(f); return; }
    }
    const dialogText = await readRegion(f, DIALOG_REGION);
    const dialog = parseDialog(dialogText);
    if (dialog && !dialogOpen) await onEntryDialog(dialog);
    dialogOpen = !!dialog;
    if (!dialog && (goldWatch || clearWatch)) { await checkHud(f); return; }
    if (!dialog && tickNo % PARTY_EVERY === 0) await readParty(f);
  }

  // ─── 영역 읽기 ───────────────────────────────────────────
  // 어두운 바탕 밝은 글자 → 흰 바탕 검은 글자, 작은 영역은 키운다(긴 변 1200px 정도면 충분하고 빠르다).
  async function readRegion(f, r, withData) {
    const sx = Math.round(r.x * f.width), sy = Math.round(r.y * f.height);
    const sw = Math.round(r.w * f.width), sh = Math.round(r.h * f.height);
    if (sw < 10 || sh < 10) return withData ? { text: '', data: null } : '';
    const scale = Math.max(1, Math.min(3, 1200 / Math.max(sw, sh)));
    const c = invertedCanvas(f, sx, sy, sw, sh, scale);
    const worker = await loadScreenOcrWorker();
    const { data } = await worker.recognize(c);
    const text = (data.lines || []).map(l => l.text.trim()).filter(Boolean).join('\n');
    return withData ? { text, data, sx, sy, scale } : text;
  }

  function invertedCanvas(f, sx, sy, sw, sh, scale) {
    const c = document.createElement('canvas');
    c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(f, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height), p = d.data;
    for (let i = 0; i < p.length; i += 4) { const v = 255 - Math.max(p[i], p[i + 1], p[i + 2]); p[i] = p[i + 1] = p[i + 2] = v; }
    g.putImageData(d, 0, 0);
    return c;
  }

  // 화면 전체(긴 변 2000px로 줄여서) 읽기 - 파티창 위치 찾기에만 쓴다.
  async function readFull(f) {
    const scale = Math.min(1, 2000 / Math.max(f.width, f.height));
    const c = invertedCanvas(f, 0, 0, f.width, f.height, scale);
    const worker = await loadScreenOcrWorker();
    const { data } = await worker.recognize(c);
    return { data, scale };
  }

  // 한 줄에서 연속 글자(공백 무시) phrase가 차지하는 위치. 한글은 words가 글자 하나씩이라 이어 붙여 찾는다.
  function phraseBox(line, phrase) {
    const ws = (line.words || []).filter(w => (w.text || '').trim());
    const joined = ws.map(w => w.text.trim()).join('');
    const at = joined.indexOf(phrase);
    if (at < 0) return null;
    let pos = 0; const span = [];
    for (const w of ws) {
      const t = w.text.trim();
      if (pos + t.length > at && pos < at + phrase.length) span.push(w.bbox);
      pos += t.length;
    }
    if (!span.length) return null;
    return { x0: Math.min(...span.map(b => b.x0)), x1: Math.max(...span.map(b => b.x1)), y0: Math.min(...span.map(b => b.y0)), y1: Math.max(...span.map(b => b.y1)) };
  }

  // ─── 입장 창 ─────────────────────────────────────────────
  // 골드 남음: "(엔드 콘텐츠 골드 보상 3회 남음)", 다 받음: "엔드 콘텐츠 골드 보상 횟수 모두 소진".
  // 레이드 줄: "4막 : 파멸의 성채 - [싱글 모드]", "죽음의 계율자, 벨가르딘 - [나이트메어]".
  function parseDialog(text) {
    if (!/입장/.test(text) || !/골드\s*보상/.test(text)) return null;
    const exhausted = /모두\s*소진/.test(text);
    const lm = text.match(/골드\s*보상\s*([0-9])\s*회\s*남/);
    const rm = text.match(/^(.*\S)\s*-\s*\[([^\]]+)\]/m);
    // 이름 앞에 배경 글자가 섞여 읽히는 경우("}드 빈      죽음의 계율자, …")가 있어 큰 공백 뒤 마지막 덩어리만 쓴다.
    const raidName = rm ? rm[1].split(/\s{3,}/).pop().replace(/^[^0-9A-Za-z가-힣]+/, '').trim() : '';
    const diffText = rm ? rm[2].trim() : '';
    // 성당은 단계마다 게임 안 이름이 다르다(예: 구원의 종탑). 이름을 못 알아보면 "N단계"로 성당을 추정한다.
    const famKey = gameRaidKey(raidName) || (/\d\s*단계/.test(diffText) ? 'cathedral' : null);
    return {
      raidName,
      famKey,
      diffKey: gameDiffKey(diffText),
      diffText,
      left: exhausted ? 0 : (lm ? +lm[1] : null)
    };
  }

  function gameRaidKey(name) {
    if (!name) return null;
    const k = getRaidFamilyKey(name);
    if (k) return k;
    const hit = GAME_RAID_ALIASES.find(([word]) => name.includes(word));
    return hit ? hit[1] : null;
  }

  // 난이도 글자 오타 대비(나이트메이 등) 앞부분으로 맞춘 뒤 normalizeDiff.
  function gameDiffKey(t) {
    t = (t || '').trim();
    if (/나이트|나메/.test(t)) return 'NM';
    if (/싱글/.test(t)) return 'NORMAL';
    return normalizeDiff(t);
  }

  async function onEntryDialog(d) {
    const raidLabel = `${d.raidName || '?'} [${d.diffText || '?'}]`;
    log(`입장 창: ${raidLabel}, 남은 골드 ${d.left === null ? '?' : d.left + '회'}`);
    if (isAdminModeActive()) await applyPartyToRoster(d.famKey);
    const charName = d.famKey ? findMyChar(d.famKey) : null;
    if (charName) watchClear(charName, d.famKey);
    if (d.left === 0) { setStatus(`${raidLabel} - 골드 횟수 소진`); return; }
    if (!d.famKey) { setStatus(`${raidLabel} - 골드 판단 대상 레이드 아님`); return; }
    if (!charName) { setStatus(`${raidLabel} - 내 캐릭터를 못 찾음(상단 강조에서 본인 선택)`); return; }
    const j = judgeGold(charName, d.famKey, d.diffKey, d.left);
    const head = `${charName} · ${raidLabel}`;
    if (j.verdict === 'skip') {
      setStatus(`⚠ ${head}: 골드 받지 마세요 - ${j.why}`, 'warn');
      showGoldAlert('skip', head, j.body || `${j.why || j.reason}\n\n→ 입장 창의 [골드 보상 획득] 체크를 끄고 들어가세요.`);
    } else if (j.verdict === 'unsure') {
      setStatus(`? ${head}: 골드 확인 필요 - ${j.why}`, 'warn');
      showGoldAlert('unsure', head, j.body || j.why || j.reason);
    }
    else if (j.verdict === 'take') setStatus(`✓ ${head}: 골드 받기 - ${j.why}`);
    else setStatus(`${head}: ${j.reason}`);
    log(`판단 ${j.verdict}: ${j.reason}`);
  }

  // ─── 골드 알림창 + 레이드 안 골드 보상 설정 확인 ─────────────
  // 골드 알림은 한 창으로: 명백히 받지 말아야 하면 빨강(skip), 애매하면 노랑(unsure, 본인 판단).
  // 입장 후 왼쪽 위 "골드 보상 설정"(앞 아이콘 빨간 X = 끔, 금화만 = 켬, 1762x1016 실측)을 지켜본다.
  //  - 빨강: 시작 전 꺼진(X) 걸 보면 닫고, 켜져 있으면 한 번 더 알린다.
  //  - 레이드를 시작하면 이 줄이 사라지는데(더는 못 바꿈), 그걸 보면 빨강/노랑 모두 닫고 끝낸다.
  //  - 즉 입장 창 때 1번 + 시작 전 1번까지만 알리고, 시작 뒤엔 창을 정리한다. 3분 지나면 그냥 끝.
  const GOLD_ALERT_TITLES = { skip: '⚠ 골드 받지 마세요', unsure: '골드 받을지 확인해 주세요' };
  const GOLD_WATCH_MS = 3 * 60 * 1000;
  const HUD_GONE_MISSES = 2;          // 설정 줄이 2번 연속 안 보이면 레이드 시작으로 본다(글자 인식 실수 대비)
  const RAID_HUD_REGION = { x: 0, y: 0.04, w: 0.17, h: 0.22 };
  let goldWatch = null;               // { kind, head, until, seenHud, misses, realerted }

  function showGoldAlert(kind, head, body) {
    closeGoldAlert();
    notify(kind === 'skip' ? 'warn' : 'caution', `${head}\n\n${body}\n\n※ 레이드 안 왼쪽 위 골드 보상 설정을 확인하면 이 창은 자동으로 닫힙니다.`, GOLD_ALERT_TITLES[kind]);
    goldWatch = { kind, head, until: Date.now() + GOLD_WATCH_MS, seenHud: false, misses: 0, realerted: false };
  }

  // 레이드 안 화면을 한 번 읽어 두 감시(골드 알림 / 일정표 밖 완료 체크)에 같이 쓴다.
  async function checkHud(f) {
    const hud = await readGoldHud(f);
    if (clearWatch) await checkClearWatch(hud);
    if (goldWatch) checkGoldSetting(hud);
  }

  // ─── 일정표 밖 레이드 자동 완료 체크 ────────────────────────
  // 입장 창이 뜬 뒤 레이드 안 왼쪽 위 "골드 보상 설정"이 보이면(= 실제로 들어감) 캐릭터 현황의 개별 완료로 체크한다.
  // 입장 창에서 거절하면 이 화면이 안 나오니 체크도 안 된다. 이미 체크됐거나 일정표/진행중 레이드에 들어 있으면
  // (그 레이드의 완료 처리로 체크된다) 하지 않는다. 저장 규칙은 캐릭터 현황에서 직접 누를 때(toggleWildClear)와 같다.
  function watchClear(charName, famKey) {
    clearWatch = null;
    if (getCharRaidStatus(charName, famKey)) return;
    if (isRaidCheckLocked(charName, famKey) || scheduledPendingRow(charName, famKey)) return;
    if (inProgressTargets().some(t => t.famKey === famKey && t.slots.some(s => s.name === charName))) return;
    const c = characterPoolData.find(x => x.name === charName);
    if (!c || c.level < getRaidMinLevel(famKey)) return;
    clearWatch = { charName, famKey, until: Date.now() + CLEAR_WATCH_MS };
  }

  async function checkClearWatch(hud) {
    const { charName, famKey } = clearWatch;
    const name = RAID_SHORT_NAME[famKey] || famKey;
    if (Date.now() > clearWatch.until) { clearWatch = null; log(`완료 체크 안 함: ${charName} ${name} - 레이드 안 화면을 못 봄`); return; }
    if (!hud) return;
    clearWatch = null;
    if (getCharRaidStatus(charName, famKey)) return;
    if (!await setManualClear(charName, famKey, true)) return;
    log(`완료 체크: ${charName} ${name} (일정표 밖 레이드)`);
    if (!goldWatch) setStatus(`✓ ${charName} ${name} 완료 체크함 (안 갔으면 캐릭터 현황에서 해제)`);
  }

  // 캐릭터 현황 개별 완료 체크(on=true)/해제(false) - 캐릭터 현황에서 칸을 누를 때와 같은 저장(toggleWildClear는 뒤집기라
  // 부르는 쪽에서 지금 상태가 반대인지 먼저 확인한다).
  async function setManualClear(charName, famKey, on) {
    const result = await saveAction('toggleWildClear', { charName, raidKey: famKey }, {
      errorLabel: on ? '완료 체크' : '완료 체크 해제', loadingText: on ? '완료 체크 중...' : '완료 체크 해제 중...'
    });
    if (!result || result.status !== 'success') { log(`${on ? '완료 체크' : '체크 해제'} 실패: ${charName} ${RAID_SHORT_NAME[famKey] || famKey}`); return false; }
    const k = `${charName}|${famKey}`;
    if (on) wildClearsData.set(k, '개별수동'); else wildClearsData.delete(k);
    renderActiveTabContent();
    return true;
  }

  function checkGoldSetting(hud) {
    if (Date.now() > goldWatch.until) { goldWatch = null; return; }
    const state = hud ? hud.state : null;
    if (!hud) {
      if (goldWatch.seenHud && ++goldWatch.misses >= HUD_GONE_MISSES) {
        log('레이드 시작(골드 보상 설정 사라짐) - 골드 알림 정리');
        closeGoldAlert();
        setStatus(`${goldWatch.head}: 레이드 시작`);
        goldWatch = null;
      }
      return;
    }
    goldWatch.seenHud = true; goldWatch.misses = 0;
    if (goldWatch.kind === 'skip' && state === 'off') {
      closeGoldAlert();
      setStatus(`✓ ${goldWatch.head}: 골드 꺼진 것 확인`);
      log('레이드 안 골드 보상 설정: 꺼짐 확인');
      notify('info');
      goldWatch = null;
    } else if (goldWatch.kind === 'skip' && state === 'on' && !goldWatch.realerted) {
      goldWatch.realerted = true;
      log('레이드 안 골드 보상 설정: 아직 켜져 있음');
      closeGoldAlert();
      notify('warn', `${goldWatch.head}\n\n골드가 아직 켜져 있습니다.\n레이드 왼쪽 위 [골드 보상 설정]에서 꺼 주세요.\n\n※ 레이드를 시작하거나 꺼진(X) 걸 확인하면 이 창은 자동으로 닫힙니다.`, GOLD_ALERT_TITLES.skip);
    }
  }

  // "골드 보상 설정" 줄이 없으면 null(레이드 밖이거나 시작함), 있으면 { state: 'off' | 'on' | null(아이콘 판별 못 함) }.
  // 줄만 보여도 "레이드 안에 들어옴"은 확실하다(켜짐 금화 아이콘은 아직 실측 전이라 state가 null일 수 있음).
  async function readGoldHud(f) {
    const hud = await readRegion(f, RAID_HUD_REGION, true);
    const line = (hud.data.lines || []).find(l => /골드\s*보상/.test(l.text));
    const b = line && phraseBox(line, '골드보상');
    if (!b) return null;
    return { state: goldIconState(f, hud, b) };
  }

  async function readGoldSetting(f) { const h = await readGoldHud(f); return h ? h.state : null; }

  // 'off' | 'on' | null
  function goldIconState(f, hud, b) {
    const x0 = hud.sx + b.x0 / hud.scale, y0 = hud.sy + b.y0 / hud.scale, y1 = hud.sy + b.y1 / hud.scale;
    const h = y1 - y0;
    const x = Math.round(x0 - 2.4 * h), y = Math.round(y0 - 0.4 * h), w = Math.round(2.2 * h), hh = Math.round(1.8 * h);
    if (x < 0 || y < 0 || w < 4 || hh < 4) return null;
    const d = f.getContext('2d', { willReadFrequently: true }).getImageData(x, y, w, hh).data;
    let red = 0, gold = 0;
    for (let i = 0; i < d.length; i += 4) {
      const R = d[i], G = d[i + 1], B = d[i + 2];
      if (R > 170 && G < 100 && B < 100) red++;
      else if (R > 170 && G > 130 && B < 100 && R - B > 90) gold++;
    }
    const area = w * hh;
    if (red / area > 0.05 && red > gold) return 'off';
    if (gold / area > 0.05 && red < gold * 0.3) return 'on';
    return null;
  }

  function closeGoldAlert() {
    const modal = document.getElementById('customAlertModal');
    const title = document.getElementById('customAlertTitle');
    if (modal && !modal.classList.contains('hidden') && title && Object.values(GOLD_ALERT_TITLES).includes(title.textContent)) {
      document.getElementById('customAlertOkBtn').click();
    }
  }

  // ─── 골드 판단 ───────────────────────────────────────────
  // 이번 레이드보다 골드(총골드)가 많은 레이드(H) 중 "이번 주에 앞으로 갈" 것의 수가 남은 횟수보다 적으면 받기.
  // H 상태: 이번 주 완료(일정완료/개별 체크) → 끝, 일정표에 편성·미완료 → 앞으로 감, 그 외 → 모름.
  // 모름이 있으면 갔다/안 갔다 양쪽으로 계산해 결과가 같을 때만 단정한다.
  function judgeGold(charName, famKey, diffKey, left) {
    const c = characterPoolData.find(x => x.name === charName);
    if (!c) return { verdict: 'unsure', reason: '캐릭터 정보 없음' };
    if (!goldEligibleCharNames.has(charName)) return { verdict: 'skip', reason: '골드 대상 캐릭터(계정 상위 6) 아님', why: '골드 대상 캐릭터(계정 레벨 상위 6)가 아닙니다' };
    const cur = raidEntry(famKey, diffKey, c.level);
    const curPayout = cur ? cur.payout : 0;
    // 다른 레이드: 일정표에 편성(미완료)돼 있으면 그 블록의 실제 난이도, 아니면 갈 수 있는 난이도 후보
    // (최고 난이도 + 난이도 3개짜리 레이드는 최상위를 갈 수 있을 때 2번째 난이도까지)로 본다.
    // 후보 중 가장 비싼 게 이번 레이드보다 비싸면 "더 비싼 레이드"이고, 2번째 난이도가 이번보다 싸면 alt로 같이 알려 준다.
    const higher = [];
    RAID_DEFINITIONS.forEach(def => {
      if (def.key === famKey) return;
      const s = scheduledPendingRow(charName, def.key);
      const opts = s ? [s] : candidateDiffs(def.key, c.level);
      if (!opts.length || opts[0].payout <= curPayout) return;
      const alt = opts[1] && opts[1].payout <= curPayout ? opts[1] : null;
      higher.push({ ...opts[0], scheduled: !!s, alt });
    });
    // 선택 구간 짝(예: 1750+ 성당 3단 귀속 ↔ 종막 하드 유통)은 귀속을 어떻게 보느냐에 따라 갈리므로 확정하지 않는다.
    const tiers = getGoldTierMapForLevel(c.level);
    const isMaybePair = key => tiers[famKey] === 'MAYBE' && tiers[key] === 'MAYBE';
    if (left == null) return { verdict: 'unsure', reason: '남은 골드 횟수를 못 읽음', why: '남은 골드 횟수를 읽지 못했습니다' };
    if (left === 0) return { verdict: 'none', reason: '골드 횟수 소진' };
    const pending = [], unknown = [], done = [], desc = [];
    higher.forEach(h => {
      let st;
      if (isDoneThisWeek(charName, h.key)) st = 'done';
      else if (isMaybePair(h.key)) { st = 'unknown'; h.maybePair = true; }
      else if (h.scheduled) st = 'pending';
      else st = 'unknown';
      if (st === 'pending') pending.push(h);
      if (st === 'unknown') unknown.push(h);
      if (st === 'done') done.push(h);
      desc.push(`${raidLabelOf(h)}(${st === 'done' ? '완료' : st === 'pending' ? '남음' : '모름'})`);
    });
    // reason = 기록용 한 줄, why = 상태 바용 짧은 설명, body = 알림창 본문(창은 자동으로 닫히니 길어도 됨)
    const reason = `남은 ${left}회, 이번 ${cur ? raidLabelOf(cur) : '?'}, 더 비싼 레이드: ${desc.join(' ') || '없음'}`;
    const curLine = `이번 레이드: ${cur ? raidLineOf(cur) : '?'}\n남은 골드: ${left}회`
      + (done.length ? `\n이번 주 완료한 더 비싼 레이드: ${done.map(h => RAID_SHORT_NAME[h.key] || h.key).join(', ')}` : '');
    if (left > pending.length + unknown.length) return { verdict: 'take', reason, why: `남은 골드 ${left}회로 충분합니다` };
    if (left <= pending.length) {
      return { verdict: 'skip', reason,
        why: `남은 골드 ${left}회 · 더 비싼 레이드 예정: ${pending.map(raidLabelOf).join(', ')}`,
        body: `${curLine}\n\n일정표에 남은 더 비싼 레이드:\n${pending.map(h => '· ' + raidLineOf(h)).join('\n')}\n\n→ 입장 창의 [골드 보상 획득] 체크를 끄고 들어가세요.` };
    }
    // 애매할 때는 판단 기준을 그대로 알려 준다: 모르는 레이드 중 앞으로 골드 받을 곳이 (남은 횟수 - 예정 수) 이상이면 끄기.
    const need = left - pending.length;
    const cond = unknown.length === 1 ? '위 레이드에서 골드 받을 예정이면'
      : need >= unknown.length ? '위 레이드 모두에서 골드 받을 예정이면'
      : `위 레이드 중 ${need}곳 이상에서 골드 받을 예정이면`;
    const notes = h => [
      h.alt ? `${diffName(h.alt)} 난이도(${man(h.alt.payout)})면 이번 레이드가 더 비쌈` : '',
      h.maybePair ? '선택 구간 - 귀속을 낮게 보면 이번 레이드가 나음' : ''
    ].filter(Boolean).join(', ');
    const unknownLines = unknown.map(h => { const n = notes(h); return `· ${raidLineOf(h)}${n ? '\n   └ ' + n : ''}`; }).join('\n');
    return { verdict: 'unsure', reason,
      why: `남은 골드 ${left}회 · ${unknown.map(raidLabelOf).join(', ')} 확인 필요`,
      body: `${curLine}${pending.length ? `\n일정표에 남은 더 비싼 레이드: ${pending.map(raidLabelOf).join(', ')}` : ''}\n\n이번 주 기록이 없는 더 비싼 레이드:\n${unknownLines}\n\n→ ${cond} 끄기, 아니면 받기` };
  }

  // ─── 레이드 금액 도우미 (Raid_Info) ─────────────────────────
  function rowEntry(r) {
    return { key: getRaidFamilyKey(r.name), diff: (r.diff || '').trim(), level: parseGoldNum(r.level),
      payout: parseGoldNum(r.goldTotal), trade: parseGoldNum(r.goldTrade), bound: parseGoldNum(r.goldBound) };
  }
  function familyRows(key) {
    return raidInfoData.filter(r => getRaidFamilyKey(r.name) === key).map(rowEntry).sort((a, b) => (a.level - b.level) || (a.payout - b.payout));
  }
  // 그 레벨에서 고려할 난이도(비싼 순): 갈 수 있는 최고 난이도, 그리고 난이도가 3개인 레이드는 최상위 난이도를
  // 갈 수 있을 때 2번째 난이도까지(빡세서 한 단계 낮춰 가는 경우 - 2026-11-15 사용자 규칙).
  function candidateDiffs(key, level) {
    const rows = familyRows(key);
    const ok = rows.filter(r => level >= r.level);
    if (!ok.length) return [];
    const top = ok[ok.length - 1];
    if (rows.length >= 3 && top === rows[rows.length - 1] && ok.length >= 2) return [top, ok[ok.length - 2]];
    return [top];
  }
  // 입장한 레이드+난이도. 난이도를 못 읽었으면 그 레벨 최고 난이도로 본다.
  function raidEntry(key, diffKey, level) {
    return familyRows(key).find(r => normalizeDiff(r.diff) === diffKey) || candidateDiffs(key, level)[0] || null;
  }
  function man(v) { return `${(v / 10000).toFixed(1).replace(/\.0$/, '')}만`; }
  function diffName(e) { return e.diff.replace('나이트메어', '나메').replace('단계', '단'); }
  function raidLabelOf(e) { return `${RAID_SHORT_NAME[e.key] || e.key} ${diffName(e)}`; }
  function raidLineOf(e) {
    const kind = e.bound > 0 ? (e.trade > 0 ? '유통+귀속' : '귀속') : '유통';
    return `${raidLabelOf(e)} ${man(e.payout)} (${kind})`;
  }

  function isDoneThisWeek(charName, key) {
    const st = getCharRaidStatus(charName, key);
    return st === 'V' || st === 'W';
  }

  // 일정표에 이 캐릭터가 편성돼 있고 아직 완료 안 된 그 계열 블록의 레이드+난이도(여럿이면 비싼 것). 없으면 null.
  function scheduledPendingRow(charName, key) {
    let best = null;
    (window.allRaidInstancesStore || []).forEach(i => {
      if (i.charName !== charName || getRaidFamilyKey(i.raidTitle) !== key) return;
      const s = getRaidStatusFor(i.sheetId, i.blockIndex, i.rawRaidTitle);
      if (s && s.status === '완료') return;
      const row = familyRows(key).find(r => normalizeDiff(r.diff) === normalizeDiff(i.raidTitle));
      if (row && (!best || row.payout > best.payout)) best = row;
    });
    return best;
  }

  // 내 캐릭터 = 상단 "강조"로 고른 유저의 캐릭터. 진행중 레이드(같은 계열) → 최근 파티창 순으로 찾는다.
  function findMyChar(famKey) {
    if (!selectedUser) return null;
    const isMine = name => { const c = characterPoolData.find(x => x.name === name); return !!(c && (c.user || '').startsWith(selectedUser)); };
    for (const t of inProgressTargets()) {
      if (famKey && t.famKey !== famKey) continue;
      const me = t.slots.find(s => (s.user || '').startsWith(selectedUser));
      if (me) return me.name;
    }
    if (lastParty && Date.now() - lastParty.at < PARTY_FRESH_MS) {
      const n = lastParty.names.find(isMine);
      if (n) return n;
    }
    return null;
  }

  function inProgressTargets() {
    return raidStatusData.filter(s => s.status === '진행중').map(s => {
      const block = sheetsDataStore[s.sheetId] && sheetsDataStore[s.sheetId].blocks[s.blockIndex];
      if (!block) return null;
      return {
        sheetId: s.sheetId, blockIndex: s.blockIndex, rawRaidTitle: s.rawRaidTitle, block,
        famKey: getRaidFamilyKey(block.title),
        slots: getEffectiveBlockSlots(s.sheetId, s.blockIndex, s.rawRaidTitle).slots
      };
    }).filter(Boolean);
  }

  // ─── 파티창 ──────────────────────────────────────────────
  async function readParty(f) {
    const text = await readRegion(f, partyRegion);
    if (!/모집|파티/.test(text)) {
      partyMiss++;
      if (partyMiss >= 3 && Date.now() - lastLocateAt > PARTY_RELOCATE_MIN_MS) await locateParty(f);
      return;
    }
    partyMiss = 0;
    const targets = inProgressTargets();
    const rosterNames = targets.flatMap(t => t.slots.map(s => s.name).concat(t.block.slots.map(s => s.name))).filter(Boolean);
    const tokens = trimTokensToPoolNames(splitScreenOcrTokens(text.split('\n').map(t => ({ text: t, words: [] }))));
    const items = matchScreenOcrTokens(tokens, rosterNames);
    if (!items.length) return;
    resolveAmbiguousByRoster(items, rosterNames);
    const names = items.filter(it => it.choice !== null && it.choice !== SCREEN_OCR_SKIP).map(it => it.candidates[it.choice]);
    lastParty = { at: Date.now(), items, names };
  }

  // OCR이 한 글자 틀려("믕"→"몽") 비슷한 후보가 여럿이면 정해지지 않는다. 그 레이드의 참여 캐릭터/일정표 편성 안에 있는
  // 후보가 딱 하나뿐일 때만 그쪽으로 확정한다(둘 이상이거나 하나도 없으면 그대로 두고 사람이 고른다).
  function resolveAmbiguousByRoster(items, rosterNames) {
    const roster = new Set(rosterNames);
    items.forEach(it => {
      if (it.choice !== null) return;
      const hits = it.candidates.map((n, i) => ({ n, i })).filter(x => roster.has(x.n));
      if (hits.length === 1) it.choice = hits[0].i;
    });
  }

  // 아이콘이 이름 앞에 붙어 "봄줄은지야기상"처럼 읽히는 경우 - 캐릭터 이름으로 끝나면 그 이름만 남긴다(긴 이름 우선).
  // splitScreenOcrTokens는 words가 없으면 신뢰도 100으로 두므로, 정확 일치 여부만 자동 선택 기준이 된다.
  function trimTokensToPoolNames(tokens) {
    const names = Array.from(new Set(characterPoolData.map(c => c.name))).sort((a, b) => b.length - a.length);
    return tokens.map(t => {
      const clean = (t.text || '').replace(/[^0-9A-Za-z가-힣]/g, '');
      const hit = names.find(n => n.length >= 3 && clean.length > n.length && clean.endsWith(n));
      return hit ? { ...t, text: hit } : t;
    });
  }

  // 화면 전체에서 "모집 상세 정보" 글자를 찾아 파티창 영역을 맞춘다(1756x1017 실측: 패널 폭 ≈ 글자 폭 4.4배,
  // 16인 파티 4개 2줄까지 ≈ 글자 아래 26줄 높이).
  async function locateParty(f) {
    lastLocateAt = Date.now();
    const { data, scale } = await readFull(f);
    let hit = null;
    for (const l of (data.lines || [])) {
      if (!/모집\s*상세/.test(l.text)) continue;
      hit = phraseBox(l, '모집상세');
      if (hit) break;
    }
    if (!hit) return false;
    const W = f.width * scale, H = f.height * scale;
    // pw는 "모집상세" 4글자 폭이라 실측 기준("모집상세정보" 6글자)에 맞게 1.5배 해서 쓴다.
    const pw = (hit.x1 - hit.x0) * 1.5, ph = hit.y1 - hit.y0;
    const x0 = Math.max(0, hit.x1 - pw * 4.6), x1 = Math.min(W, hit.x1 + pw * 1.3);
    const y0 = Math.max(0, hit.y0 - ph * 1.5), y1 = Math.min(H, hit.y1 + ph * 26);
    partyRegion = { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H };
    try { localStorage.setItem(PARTY_REGION_KEY, JSON.stringify(partyRegion)); } catch (e) {}
    partyMiss = 0;
    log('파티창 위치를 다시 찾았습니다');
    return true;
  }

  function loadPartyRegion() {
    try { const r = JSON.parse(localStorage.getItem(PARTY_REGION_KEY)); if (r && r.w > 0) return r; } catch (e) {}
    return { ...DEFAULT_PARTY_REGION };
  }

  // 입장 직전(입장 창이 뜬 순간) 마지막으로 읽은 파티 인원으로 진행중 레이드 참여 캐릭터를 바꾼다(관리자 모드).
  // 모든 이름이 정확히 일치할 때만 저장하고, 비슷한 이름이 섞이면 알리기만 한다. 규칙은 [인원 변경]과 같다.
  async function applyPartyToRoster(famKey) {
    if (!lastParty || Date.now() - lastParty.at > PARTY_FRESH_MS) { log('인원 자동 변경 안 함: 최근 3분 안에 읽은 파티 정보가 없음'); return; }
    if (lastParty.items.some(it => it.choice === null)) { openPartyConfirm(famKey); return; }
    const names = Array.from(new Set(lastParty.names));
    if (names.length < ADD_BLOCK_MIN_CHARS) { log(`인원 자동 변경 안 함: 읽은 파티 인원이 ${names.length}명`); return; }
    const candidates = inProgressTargets().filter(t => !famKey || t.famKey === famKey);
    if (!candidates.length) { log('인원 자동 변경 안 함: 이 레이드에 해당하는 진행중 레이드가 없음'); return; }
    const score = t => t.slots.filter(s => names.includes(s.name)).length;
    const target = candidates.sort((a, b) => score(b) - score(a))[0];
    if (candidates.length > 1 && score(target) === 0) { log('인원 자동 변경 안 함: 진행중 레이드가 여럿인데 어느 쪽인지 모름'); return; }
    const current = target.slots.map(s => s.name);
    if (current.length === names.length && current.every(n => names.includes(n))) { log('인원 변경 없음: 파티가 지금 참여 캐릭터와 같음'); return; }
    // 파티가 정원보다 적게 읽혔는데 지금 참여 캐릭터 중 빠진 사람이 있으면, 진짜 불참인지 글자를 못 읽은 건지 알 수 없다
    // (2026-11-20 무한대로흑화가 안 읽혀 2명으로 바뀐 일) - 저장하지 않고 [화면 인식] 창으로 확인받는다.
    const missing = current.filter(n => !names.includes(n));
    if (missing.length && names.length < getBlockCapacity(target.block)) { openPartyConfirm(famKey, `파티창에서 안 읽힌 사람: ${missing.join(', ')}`); return; }

    const base = u => (u || '').split('(')[0].trim();
    const chars = names.map(name => {
      const c = characterPoolData.find(x => x.name === name);
      return { user: c ? c.user : '', name };
    });
    const users = chars.map(c => base(c.user));
    if (users.some(u => !u) || new Set(users).size !== users.length) { log('인원 자동 변경 안 함: 같은 유저의 캐릭터가 둘 이상이거나 유저를 모름'); setStatus('파티 인원에 같은 유저 캐릭터가 둘 이상이라 자동 변경 안 함', 'warn'); return; }
    if (chars.length > getBlockCapacity(target.block)) { log(`인원 자동 변경 안 함: 읽은 인원 ${chars.length}명이 정원보다 많음`); return; }
    const busyElsewhere = inProgressTargets().some(t => t !== target && !(t.sheetId === target.sheetId && t.blockIndex === target.blockIndex)
      && t.slots.some(s => users.includes(base(s.user))));
    if (busyElsewhere) { log('인원 자동 변경 안 함: 다른 진행중 레이드에 있는 사람이 파티에 있음'); setStatus('파티 인원 중 다른 진행중 레이드에 있는 사람이 있어 자동 변경 안 함', 'warn'); return; }

    const result = await saveAction('setRaidActualRoster', { sheetId: target.sheetId, blockIndex: target.blockIndex, rawRaidTitle: target.rawRaidTitle, characters: chars }, {
      errorLabel: '참여 캐릭터 자동 변경', loadingText: '파티 인원으로 참여 캐릭터 변경 중...'
    });
    if (result.status !== 'success') return;
    const info = getRaidStatusFor(target.sheetId, target.blockIndex, target.rawRaidTitle);
    if (info) info.actualRoster = chars;
    renderActiveTabContent();
    refreshOpenRaidProgressModal();
    log(`참여 캐릭터 자동 변경: ${names.join(', ')}`);
    setStatus(`파티 인원으로 [${sanitizeTitle(target.rawRaidTitle)}] 참여 캐릭터를 바꿨습니다`);
    notify('info');
  }

  // 비슷한 이름이 있어 확정하지 못하면 알림창 대신 [화면 인식] 창을 캡처 없이 바로 연다(읽은 결과를 그대로 채워서).
  // 사람이 고른 뒤 [인원 변경 창에서 확인]으로 이어지고, 저장은 거기서 확인해야만 된다. 사이트가 아직 이 기능을 모르면
  // (index.html이 예전 버전) 예전처럼 알림창으로 알린다.
  function openPartyConfirm(famKey, reason) {
    const unsure = lastParty.items.filter(it => it.choice === null).map(it => it.text).join(', ');
    log(reason ? `인원 확인 필요: ${reason}` : `비슷한 이름이 있어 확정하지 못함: ${unsure}`);
    const names = lastParty.items.flatMap(it => it.candidates);
    const targets = inProgressTargets().filter(t => !famKey || t.famKey === famKey);
    const score = t => t.slots.concat(t.block.slots).filter(s => names.includes(s.name)).length;
    const target = targets.sort((a, b) => score(b) - score(a))[0];
    const canOpen = target && (targets.length === 1 || score(target) > 0) && typeof openScreenOcrFromShare === 'function';
    if (canOpen && typeof isScreenOcrModalOpen === 'function' && isScreenOcrModalOpen()) return; // 이미 열려 있음
    if (canOpen) {
      openScreenOcrFromShare(lastParty.items, target);
      setStatus(reason ? `${reason} - [화면 인식] 창에서 확인해 주세요` : '파티 인원 확인이 필요해 [화면 인식] 창을 열었습니다', 'warn');
      beep();
      return;
    }
    const why = reason || '파티 인원 중 비슷한 이름(조/죠 등)이 있음';
    setStatus(`${why} - 자동으로 바꾸지 않았습니다. [화면 인식]으로 확인하세요`, 'warn');
    notify('info', `${why}\n참여 캐릭터를 자동으로 바꾸지 않았습니다.\n\n필요하면 진행중 창의 [화면 인식]으로 확인해 주세요.`, '참여 캐릭터 확인');
  }

  // ─── ESC 게임 메뉴 읽기([ESC 읽기] 버튼으로만) ─────────────────
  // 게임 메뉴 오른쪽 레이드 목록(각자 직접 넣어 둔 레이드만 나옴)으로 캐릭터 현황 완료 체크를 맞춘다.
  //  - "참여 완료": 체크 안 돼 있으면 개별 완료로 체크
  //  - "참여 가능"(안 감): 개별 완료로 체크돼 있으면 해제(입장만 하고 나온 자동 체크 등 바로잡기)
  // 골드를 받았는지(초록 체크)는 안 본다 - 판단에는 이번 주에 갔는지만 필요하고 남은 횟수는 입장 창에서 읽는다.
  // 일정표 완료 체크와 일정표에 편성돼 잠긴 칸은 건드리지 않는다. 메뉴의 캐릭터가 본인(상단 "강조") 캐릭터일 때만 저장.
  function requestEsc() {
    if (!selectedUser) { setStatus('상단 "강조"에서 본인을 먼저 골라 주세요', 'warn'); return; }
    escRequest = { until: Date.now() + ESC_WAIT_MS };
    setStatus('게임에서 ESC를 눌러 게임 메뉴를 열어 주세요 (이번 주 완료 레이드 확인)', 'warn');
  }

  // 화면 전체 읽기는 줄이 섞이거나 빠져서, "엔드 콘텐츠" 위치만 찾고 그 패널만 크게 다시 읽는다.
  async function scanEsc(f) {
    const full = await readFull(f);
    const endFull = (full.data.lines || []).find(l => /엔드\s*콘텐츠/.test(l.text));
    const eb = endFull && phraseBox(endFull, '엔드콘텐츠');
    if (!eb) return;
    // 1758x1015 실측("엔드콘텐츠" x 1308~1372, 글자 높이 11): 패널 x 1270~1605, 캐릭터명 y ~305,
    // 마지막 레이드 줄 y ~670 → 폭(ew) 기준 왼쪽 -0.6ew·폭 5.4ew, 높이(eh) 기준 위 11줄·전체 36줄.
    const ex0 = eb.x0 / full.scale, ew = (eb.x1 - eb.x0) / full.scale;
    const ey0 = eb.y0 / full.scale, eh = (eb.y1 - eb.y0) / full.scale;
    const rx = Math.max(0, ex0 - ew * 0.6), ry = Math.max(0, ey0 - eh * 11);
    const rw = Math.min(f.width - rx, ew * 5.4), rh = Math.min(f.height - ry, eh * 36);
    const panel = await readRegion(f, { x: rx / f.width, y: ry / f.height, w: rw / f.width, h: rh / f.height }, true);
    const lines = panel.data.lines || [];
    const done = [], open = [];
    lines.forEach(l => {
      const isDone = /참여\s*완료/.test(l.text), isOpen = /참여\s*가능/.test(l.text);
      if (!isDone && !isOpen) return;
      const key = gameRaidKey(l.text);
      if (!key) return;
      const list = isDone ? done : open;
      if (!list.includes(key)) list.push(key);
    });
    const openOnly = open.filter(k => !done.includes(k));
    // 메뉴 위쪽 캐릭터 이름 - 본인 캐릭터 중 긴 이름 우선("은지"가 "악마같은지" 안에 걸리지 않게).
    const fullText = panel.text + '\n' + (full.data.lines || []).map(l => l.text).join('\n');
    const me = characterPoolData
      .filter(c => (c.user || '').startsWith(selectedUser || '\u0000') && fullText.includes(c.name))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!me) return; // 아직 메뉴가 덜 보였거나 본인 캐릭터가 아님 - 시간 끝날 때까지 다시 본다
    escRequest = null;
    const charName = me.name;
    const short = k => RAID_SHORT_NAME[k] || k;
    const changed = [], locked = [];
    for (const key of done) {
      if (getCharRaidStatus(charName, key)) continue;
      if (isRaidCheckLocked(charName, key)) { locked.push(short(key)); continue; }
      if (await setManualClear(charName, key, true)) changed.push(`${short(key)} 체크`);
    }
    for (const key of openOnly) {
      if (getCharRaidStatus(charName, key) !== 'W') continue;
      if (await setManualClear(charName, key, false)) changed.push(`${short(key)} 해제`);
    }
    const seen = done.length || openOnly.length
      ? `참여 완료 ${done.map(short).join(', ') || '없음'} / 참여 가능 ${openOnly.map(short).join(', ') || '없음'}`
      : '레이드 목록 없음(게임 메뉴 목록에 레이드를 넣어 두면 읽을 수 있음)';
    log(`ESC 읽음: ${charName} - ${seen}${changed.length ? ' → ' + changed.join(', ') : ''}${locked.length ? ` (일정표 편성이라 그대로: ${locked.join(', ')})` : ''}`);
    setStatus(`ESC 확인: ${charName} - ${changed.length ? changed.join(', ') : '바꿀 것 없음'}`);
    notify('info');
  }

  // ─── 화면 표시 / 소리 ─────────────────────────────────────
  function renderBar() {
    if (document.getElementById('raidShareBar')) return;
    const bar = document.createElement('div');
    bar.id = 'raidShareBar';
    bar.style.zIndex = '65'; // 모달(z-50/60) 배경 위, 저장 중 오버레이(z-70) 아래 - 어느 창이 열려 있어도 흐려지지 않게
    bar.className = 'fixed bottom-3 right-3 w-80 max-w-[calc(100vw-24px)] bg-[#161b22] border border-cyan-700/60 rounded-lg shadow-lg text-xs';
    bar.innerHTML = `
      <div class="flex items-start gap-2 px-3 py-2">
        <span class="mt-1 w-2 h-2 shrink-0 rounded-full bg-cyan-400 animate-pulse"></span>
        <span id="raidShareStatus" class="flex-1 text-gray-300 break-keep">화면 공유 중</span>
      </div>
      <div class="flex justify-end gap-1.5 px-3 pb-2">
        <button type="button" onclick="RaidShare.toggleLog()" class="px-2 py-0.5 rounded border border-gray-700 bg-gray-800 hover:bg-gray-700 text-gray-300">기록</button>
        <button type="button" onclick="RaidShare.requestEsc()" title="게임 메뉴(ESC) 레이드 목록으로 이번 주 완료 체크를 맞춥니다" class="px-2 py-0.5 rounded border border-gray-700 bg-gray-800 hover:bg-gray-700 text-gray-300">ESC 읽기</button>
        <button type="button" onclick="RaidShare.stop()" class="px-2 py-0.5 rounded border border-red-800/60 bg-red-950/30 hover:bg-red-900/40 text-red-300">중지</button>
      </div>
      <div id="raidShareLog" class="hidden max-h-48 overflow-auto px-3 pb-2 font-mono text-[11px] text-gray-400 whitespace-pre-wrap"></div>`;
    document.body.appendChild(bar);
  }

  function setStatus(text, tone) {
    const el = document.getElementById('raidShareStatus');
    if (!el) return;
    el.textContent = text;
    el.className = `flex-1 break-keep ${tone === 'warn' ? 'text-amber-300' : 'text-gray-300'}`;
  }

  function log(msg) {
    const t = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    logs.unshift(`[${t}] ${msg}`);
    if (logs.length > 40) logs.pop();
    const el = document.getElementById('raidShareLog');
    if (el) el.textContent = logs.join('\n');
  }

  function toggleLog() {
    const el = document.getElementById('raidShareLog');
    if (!el) return;
    el.textContent = logs.join('\n');
    el.classList.toggle('hidden');
  }

  function setHeaderActive(on) {
    const btn = document.getElementById('raidShareBtn');
    if (!btn) return;
    btn.classList.toggle('border-cyan-500', on);
    btn.classList.toggle('text-cyan-300', on);
    btn.classList.toggle('border-gray-700', !on);
  }

  // 소리는 "삐삐" 하나로 통일(디스코드·유튜브 소리 위로도 잘 들림, 2026-11-15 사용자 확인). 내용은 사이트 알림창.
  // 골드 받지 말아야 할 때만 알림창을 빨간 테두리로 띄운다(음성은 어색하다고 해서 뺌, v2.19.16).
  function notify(kind, message, title) {
    beep();
    if (message) customAlert(message, title, kind === 'warn' ? 'danger' : kind === 'caution' ? 'caution' : undefined);
  }

  let audioCtx = null;
  function getAudio() {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  // 평소 알림은 시험 페이지에서 들어 본 그 소리 그대로(880Hz, 일정한 크기 0.18초) - 소리가 줄어드는 처리를 넣었더니
  // 너무 작게 들린다고 해서 되돌림(v2.19.13). 한 번은 놓치기 쉬워 두 번 울린다(v2.19.14).
  function beep() {
    try {
      const ctx = getAudio(), t0 = ctx.currentTime;
      for (let i = 0; i < 2; i++) {
        const t = t0 + i * 0.28;
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 880; g.gain.value = 0.15;
        o.connect(g).connect(ctx.destination);
        o.start(t); o.stop(t + 0.18);
      }
    } catch (e) {}
  }

  window.RaidShare = {
    start, stop, isActive, toggleLog,
    testSound: kind => notify(kind === 'warn' ? 'warn' : 'info'),
    requestEsc,
    // 시험용(스샷 캔버스를 바로 넣어 보기)
    _test: { applyPartyToRoster, resolveAmbiguousByRoster, getLogs: () => logs.slice(), processFrame, readGoldSetting, readGoldHud, checkHud, watchClear, setClearWatch: w => { clearWatch = w; }, get clearWatch() { return clearWatch; }, setGoldWatch: w => { goldWatch = w; }, get goldWatch() { return goldWatch; }, parseDialog, judgeGold, locateParty, readParty, setLastParty: p => { lastParty = p; }, get lastParty() { return lastParty; }, get partyRegion() { return partyRegion; }, scanEsc, setManualClear, setEscRequest: r => { escRequest = r; }, get escRequest() { return escRequest; } }
  };
})();
