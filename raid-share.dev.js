// 진행중 레이드 화면 공유 - dev.html이 [화면 공유]를 처음 누를 때만 불러온다(평소 로딩에 영향 없음).
// 운영 승격 때는 이 파일을 raid-share.js로 복사한다(index.html은 raid-share.js를 불러옴).
// dev.html의 전역(함수, let 변수)을 그대로 쓴다 - 일반 <script>끼리는 최상위 let/const도 공유된다.
//
// 하는 일(게임 창을 공유받아 2초마다 일부만 읽는다. 화면은 이 PC 안에서만 처리하고 어디에도 보내지 않음):
//  1) 입장 창(가운데): 레이드/난이도/남은 골드 횟수를 읽어 내 캐릭터가 여기서 골드를 받아도 되는지 판단,
//     받지 말아야 하면 "삐삐" 소리 + 사이트 알림창, 괜찮으면(골드 받기/소진) 읽었다는 표시로 "삐" 한 번 - 다른 소리가 났으면 생략(2026-11-27). 관리자 모드면 직전에 읽은 파티창 인원으로 참여 캐릭터 자동 변경(정확 일치만).
//  2) 파티창(오른쪽): 파티원 이름. "모집 상세 정보" 글자 위치로 영역을 자동으로 찾는다.
//  3) 레이드 안 왼쪽 위: "골드 보상 설정"으로 골드 알림 자동 닫기, 마지막 관문 뒤 "나가기" 버튼으로 레이드 끝 판정
//     (일정표 밖이면 내 캐릭터 완료 체크, 일정표 레이드면 관리자 모드에서 [완료 처리] 누른 것처럼 처리).
//  4) [ESC 읽기] 버튼(수동): 게임 메뉴 레이드 목록으로 캐릭터 현황 완료 체크를 맞춘다("참여 완료" 체크, "참여 가능"이면 개별 체크 해제).
//  5) 입장 창에서 내 캐릭터를 못 찾으면(싱글/매칭, 공대장이 아니라 파티창이 안 보임 등) 노란 알림창+소리로 "입장한 뒤 ESC 한 번"을
//     요청하고, 게임 메뉴의 캐릭터 이름을 읽어 1)의 골드 판단과 3)의 레이드 끝 감시를 이어서 한다(2026-11-22).
//     입장 창이 떠 있는 동안은 ESC를 못 누르므로 입장 뒤에 본다(입장 전 미리 묻던 방식은 2026-11-20에 뺐음).
(function () {
  'use strict';

  const TICK_MS = 2000;
  const PARTY_EVERY = 3;              // 파티창은 3박자마다
  const PARTY_RELOCATE_MIN_MS = 15000; // 파티창 다시 찾기 최소 간격(화면 전체 읽기는 1~3초 걸림)
  const PARTY_FRESH_MS = 3 * 60 * 1000;
  const END_WATCH_MS = 90 * 60 * 1000; // 입장 창 뒤 레이드 끝("나가기")을 기다리는 최대 시간
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
  let dialogOpen = false, dialogClosedAt = 0;
  let endWatch = null;                 // { famKey, diffKey, charName, wild, until } 레이드 끝("나가기") 대기
  const ESC_WAIT_MS = 45000;           // [ESC 읽기] 누른 뒤 게임 메뉴를 기다리는 시간
  const ENTRY_ESC_WAIT_MS = 3 * 60 * 1000; // 입장 창에서 내 캐릭터를 못 찾았을 때 입장 뒤 ESC를 기다리는 시간
  let escRequest = null;               // { until, entry } entry = 내 캐릭터를 못 찾은 입장 창(ESC에서 이름을 읽으면 이어서 판단)
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
    if (recOn()) recPrune();
    renderRecBtn();
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
    stream = null; video = null; endWatch = null; escRequest = null; dialogOpen = false;
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
    if (escRequest && Date.now() > escRequest.until) escTimeout();
    if (escRequest && !escRequest.entry) { await scanEsc(f); return; } // [ESC 읽기] 버튼 - 게임 메뉴만 본다
    const dialogText = await readRegion(f, DIALOG_REGION);
    const dialog = parseDialog(dialogText);
    if (dialog && !dialogOpen) await onEntryDialog(dialog, f);
    if (!dialog && dialogOpen) dialogClosedAt = Date.now();
    dialogOpen = !!dialog;
    // 입장 창에서 내 캐릭터를 못 찾았으면 입장 뒤 게임 메뉴(ESC)에서 이름을 읽는다(입장 창이 닫힌 뒤에만)
    if (!dialog && escRequest) { await scanEsc(f); return; }
    // 레이드 끝 감시는 길어서(입장 창에서 거절했을 수도 있음) 레이드 안 화면이 안 보이면 파티창 읽기도 계속한다.
    if (!dialog && (goldWatch || endWatch)) {
      const inRaid = await checkHud(f);
      if (inRaid || goldWatch) return;
    }
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

  function entryLabel(d) { return `${d.raidName || '?'} [${d.diffText || '?'}]`; }

  async function onEntryDialog(d, f) {
    const raidLabel = entryLabel(d);
    entrySoundFrom = Date.now();
    // 관리자 기록: 입장 창 화면 + 직전 파티창 화면들(인원을 잘못 읽었을 때 원인 확인용)
    if (f && recOn()) rec('entry', { dialog: d, img: shot(f, FULL_REGION, 1200), party: partyShots.slice() });
    log(`입장 창: ${raidLabel}, 남은 골드 ${d.left === null ? '?' : d.left + '회'}`);
    // 관리자 모드로 화면 공유 중이면 입장 창마다 관리자 유휴 시간(1시간)을 갱신한다 - 레이드가 길거나 이어져도 안 풀리게.
    if (isAdminModeActive()) { markAdminAction(); await applyPartyToRoster(d.famKey); }
    const charName = d.famKey ? findMyChar(d.famKey) : null;
    endWatch = null;
    // 앞 입장 창의 ESC 기다림은 새 입장 창으로 대신한다(싱글 모드에서 레이드를 고르며 같은 창이 여러 번 뜨면 다시 울리지 않음)
    const prev = escRequest && escRequest.entry;
    if (prev) escRequest = null;
    if (d.famKey && !charName && selectedUser) {
      escRequest = { until: Date.now() + ENTRY_ESC_WAIT_MS, entry: d };
      log('내 캐릭터를 못 찾음 - 입장 뒤 ESC(게임 메뉴)를 기다림');
      setStatus(`${raidLabel} - 내 캐릭터를 모릅니다. 입장한 뒤 ESC(게임 메뉴)를 한 번 열어 주세요`, 'warn');
      if (!(prev && prev.famKey === d.famKey && prev.diffKey === d.diffKey && isEscAlertOpen())) {
        closeGoldAlert();
        notify('caution', `${raidLabel}\n\n파티창이 안 보여 내 캐릭터를 알 수 없습니다.\n입장한 뒤 게임에서 ESC(게임 메뉴)를 한 번 열어 주세요.\n\n※ 캐릭터 이름을 읽으면 이 창은 자동으로 닫히고 골드 판단을 이어서 합니다.`, ESC_ALERT_TITLE);
      }
      return;
    }
    if (prev) closeGoldAlert([ESC_ALERT_TITLE]);
    judgeEntry(d, charName);
  }

  // 내 캐릭터를 못 찾았을 때 ESC 요청 알림창(골드 주의와 같은 노란 창 + 소리)
  const ESC_ALERT_TITLE = 'ESC를 한 번 열어 주세요';
  function isEscAlertOpen() {
    const modal = document.getElementById('customAlertModal');
    const title = document.getElementById('customAlertTitle');
    return !!(modal && !modal.classList.contains('hidden') && title && title.textContent === ESC_ALERT_TITLE);
  }

  // 입장 창 판단(골드 + 레이드 끝 감시). 입장 창에서 바로, 또는 입장 뒤 ESC로 캐릭터 이름을 읽은 다음에 부른다.
  // 입장 창을 제대로 읽었다는 표시로 성공(골드 받기, 골드 소진)일 때만 "삐" 한 번(주의 알림은 "삐삐" 두 번).
  // 이 입장 창에서 이미 다른 소리(인원 확인/자동 변경 "삐삐" 등)가 났으면 안 울린다 - "삐삐"가 들리면 "삐"는 필요 없음(2026-11-27 사용자).
  // 글자 인식이 한두 박자 빠졌다 다시 잡힌 같은 입장 창(닫힌 지 7초 안)만 다시 안 울린다. 누가 거절해서 다시 신청한 입장 창은
  // 닫혀 있던 시간이 그보다 길어 다시 울린다(처음엔 2분 막았는데 재신청 때 안 울리면 인식했는지 모름 - 2026-11-28 사용자).
  const ENTRY_FLICKER_MS = 7000;
  let entrySoundFrom = 0;             // 이번 입장 창(또는 ESC로 이어 판단) 시작 시각 - 이 뒤에 난 소리가 있으면 "삐" 생략
  let lastEntryBeepKey = null;
  function entryBeep(d, charName) {
    if (lastBeepAt >= entrySoundFrom) return;
    const key = [d.famKey, d.diffKey, d.left, charName].join('|');
    if (key === lastEntryBeepKey && Date.now() - dialogClosedAt < ENTRY_FLICKER_MS) return;
    lastEntryBeepKey = key;
    beep(1);
  }

  function judgeEntry(d, charName) {
    const raidLabel = entryLabel(d);
    if (charName) startEndWatch(d, charName);
    if (d.left === 0) { setStatus(`${raidLabel} - 골드 횟수 소진`); entryBeep(d, charName); return; }
    if (!d.famKey) { setStatus(`${raidLabel} - 골드 판단 대상 레이드 아님`); return; }
    if (!charName) { setStatus(`${raidLabel} - 내 캐릭터를 못 찾음(상단 강조에서 본인 선택)`); return; }
    const j = judgeGold(charName, d.famKey, d.diffKey, d.left);
    if (j.verdict === 'take') entryBeep(d, charName);
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

  // 레이드 안 왼쪽 위를 한 번 읽어 두 감시(골드 알림 / 레이드 끝)에 같이 쓴다. 레이드 안 화면(골드 줄이나 레이드 이름)이 보이면 true.
  async function checkHud(f) {
    const hud = await readRegion(f, RAID_HUD_REGION, true);
    const lines = (hud.data && hud.data.lines) || [];
    const gold = goldFromHud(f, hud);
    if (goldWatch) checkGoldSetting(gold);
    const titleKey = lines.map(l => gameRaidKey(l.text)).find(Boolean) || null;
    if (endWatch) await checkEnd(f, lines, titleKey);
    return !!gold || !!titleKey;
  }

  // 레이드 이름 아래 버튼만(중단하기/재시작/던전 진행/나가기). 큰 화면에서 막 클리어한 직후의 회색 "나가기"는
  // 왼쪽 위 전체를 읽을 때 뭉개지고 이 부분만 읽으면 잡힌다(1919x1079 스샷 실측).
  const RAID_BUTTON_REGION = { x: 0.035, y: 0.157, w: 0.09, h: 0.03 };
  function hasExitText(text) { return /가기/.test((text || '').replace(/\s/g, '')); }

  function raidShort(k) { return RAID_SHORT_NAME[k] || k; }

  // ─── 레이드 끝 감시 ──────────────────────────────────────
  // 마지막 관문을 깨면 왼쪽 위 버튼이 "나가기"로 바뀌고 이때 보상도 들어온다(중단하기/재시작/던전 진행에는 "가기"가 없음).
  // 바로 뒤 컷신(길이는 로딩·자동 스킵에 따라 사람마다 다름) 동안은 안 보이다가 다시 보이고, 컷신 전에도 4초쯤 보여
  // 2초 박자로 1~2번은 잡힌다(2026-11-21 벨가 나메 종료 영상 실측, "낙가기/내가기"로도 읽혀 "가기"만 본다).
  // 위 레이드 이름도 입장 창과 같은 계열일 때만 인정한다. 입장 창에서 시작해 나가기를 보거나, 다음 입장 창이 뜨거나,
  // 1시간 반이 지나면 끝낸다. 중간 관문만 깨고 나가면 버튼이 "던전 진행"이라 끝으로 안 본다.
  function startEndWatch(d, charName) {
    endWatch = { famKey: d.famKey, diffKey: d.diffKey, charName, wild: isWildTarget(charName, d.famKey), until: Date.now() + END_WATCH_MS };
  }

  async function checkEnd(f, lines, titleKey) {
    if (Date.now() > endWatch.until) { log(`레이드 끝 감시 그만: ${endWatch.charName} ${raidShort(endWatch.famKey)} - 시간 지남`); endWatch = null; return; }
    if (titleKey !== endWatch.famKey) return;
    if (!lines.some(l => hasExitText(l.text)) && !hasExitText(await readRegion(f, RAID_BUTTON_REGION))) return;
    if (!endWatch) return; // 버튼을 읽는 사이 다음 입장 창 등으로 감시가 바뀌었으면 그만
    const w = endWatch;
    endWatch = null;
    log(`레이드 끝(나가기): ${w.charName} ${raidShort(w.famKey)}`);
    if (w.wild && isWildTarget(w.charName, w.famKey)) await finishWild(w);
    // 완료 확인창은 사람이 고를 때까지 기다리므로 박자를 막지 않게 기다리지 않는다
    else finishScheduled(w).catch(e => log('완료 처리 오류: ' + (e && e.message ? e.message : e)));
  }

  // 일정표 밖 레이드 = 이미 체크됐거나, 잠겼거나, 일정표(남은 칸)/진행중 레이드에 들어 있으면 아님(그 레이드 완료 처리로 체크된다).
  function isWildTarget(charName, famKey) {
    if (getCharRaidStatus(charName, famKey)) return false;
    if (isRaidCheckLocked(charName, famKey) || scheduledPendingRow(charName, famKey)) return false;
    if (inProgressTargets().some(t => t.famKey === famKey && t.slots.some(s => s.name === charName))) return false;
    const c = characterPoolData.find(x => x.name === charName);
    return !!(c && c.level >= getRaidMinLevel(famKey));
  }

  // 일정표 밖: 캐릭터 현황 개별 완료로 체크(캐릭터 현황에서 직접 누를 때와 같은 저장).
  async function finishWild(w) {
    const name = raidShort(w.famKey);
    beep();
    if (!await setManualClear(w.charName, w.famKey, true)) return;
    log(`완료 체크: ${w.charName} ${name} (일정표 밖 레이드)`);
    setStatus(`✓ ${w.charName} ${name} 완료 체크함 (안 갔으면 캐릭터 현황에서 해제)`);
  }

  // 일정표 레이드(관리자 모드만): 내가 든 진행중 레이드(사람당 하나뿐)가 이 레이드면 [완료 처리]를 누른 것처럼 한다.
  //  - 같은 조에 다음 레이드가 있으면 "완료 처리 / 다음 레이드 진행" 확인창만 띄운다(고르는 건 사람).
  //  - 다음 레이드가 없으면 확인창 없이 바로 완료 처리한다.
  // 관리자 모드가 아니면 아무것도 안 한다(공유하는 사람마다 안내가 뜨면 헷갈림 - 2026-11-22 사용자 결정, [기록]에만 남김).
  // 누른 시점에 Raid_Status를 다시 받아 이미 완료/취소됐으면 아무것도 안 한다.
  async function finishScheduled(w) {
    const name = raidShort(w.famKey);
    if (!isAdminModeActive()) { log(`레이드 끝: ${w.charName} ${name} - 관리자 모드가 아니라 그대로 둠`); return; }
    markAdminAction();
    const t = inProgressTargets().find(x => x.famKey === w.famKey && x.slots.some(s => (s.user || '').startsWith(selectedUser)));
    if (!t) { log(`레이드 끝: ${w.charName} ${name} - 내가 든 진행중 레이드가 없음`); return; }
    const head = t.block.title;
    const blockDiff = normalizeDiff(t.rawRaidTitle);
    if (w.diffKey && blockDiff && blockDiff !== w.diffKey) {
      log(`완료 처리 안 함: 진행중 레이드(${head})와 난이도가 다름`);
      setStatus(`${w.charName} ${name} 레이드 끝 - 진행중 레이드(${head})와 난이도가 달라 그대로 둠`, 'warn');
      return;
    }
    await refreshSheets(['Raid_Status'], true);
    const fresh = getRaidStatusFor(t.sheetId, t.blockIndex, t.rawRaidTitle);
    if (!fresh || fresh.status !== '진행중') {
      const why = fresh && fresh.status === '완료' ? '이미 완료됨' : '진행중 아님';
      log(`완료 처리 안 함: ${head} - ${why}`);
      setStatus(`${head} 끝 - ${why}`);
      return;
    }
    const nextBlock = (sheetsDataStore[t.sheetId] && sheetsDataStore[t.sheetId].blocks[t.blockIndex + 1]) || null;
    const nextInfo = nextBlock ? getRaidStatusFor(t.sheetId, t.blockIndex + 1, nextBlock.rawTitle) : null;
    const hasNext = !!nextBlock && !(nextInfo && nextInfo.status === '완료');
    notify('info');
    if (hasNext) {
      log(`완료 처리 창 띄움: ${head} (다음 레이드 있음)`);
      setStatus(`✓ ${head} 끝 - 완료 처리 / 다음 레이드 진행을 골라 주세요`);
      // 진행중 창을 열고 그 [완료 처리]를 누른 것과 똑같이(같은 확인창, 취소하면 진행중 창이 남는다).
      openRaidProgressModal(t.sheetId, t.blockIndex, t.rawRaidTitle, head);
      await completeRaidBlock();
      return;
    }
    if (isRaidProgressModalOpen()) closeRaidProgressModal();
    showSavingOverlay('레이드 완료 처리 중...');
    try {
      await doCompleteRaidBlock(t.sheetId, t.blockIndex, t.rawRaidTitle);
    } finally {
      hideSavingOverlay();
    }
    const done = getRaidStatusFor(t.sheetId, t.blockIndex, t.rawRaidTitle);
    if (done && done.status === '완료') {
      log(`자동 완료 처리: ${head} (다음 레이드 없음)`);
      setStatus(`✓ ${head} 완료 처리함 (다음 레이드 없음)`);
    } else {
      log(`자동 완료 처리 실패: ${head}`);
      setStatus(`${head} 완료 처리 실패 - 직접 [완료 처리]를 눌러 주세요`, 'warn');
    }
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
  // 켜짐(금화) 아이콘은 2026-11-21 1919x1079 벨가 나메 스샷으로 'on' 판별 확인.
  async function readGoldHud(f) { return goldFromHud(f, await readRegion(f, RAID_HUD_REGION, true)); }

  function goldFromHud(f, hud) {
    const line = ((hud.data && hud.data.lines) || []).find(l => /골드\s*보상/.test(l.text));
    const b = line && phraseBox(line, '골드보상');
    return b ? { state: goldIconState(f, hud, b) } : null;
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

  function closeGoldAlert(titles) {
    const modal = document.getElementById('customAlertModal');
    const title = document.getElementById('customAlertTitle');
    if (modal && !modal.classList.contains('hidden') && title && (titles || Object.values(GOLD_ALERT_TITLES)).includes(title.textContent)) {
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
    if (recOn()) {
      partyShots.push({
        t: new Date().toLocaleTimeString('ko-KR', { hour12: false }),
        text,
        items: items.map(it => `${it.text} → ${it.choice === null ? '?' : it.choice === SCREEN_OCR_SKIP ? '(제외)' : it.candidates[it.choice]}`),
        img: shot(f, partyRegion, 600)
      });
      if (partyShots.length > PARTY_SHOTS_MAX) partyShots.shift();
    }
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
    // 입장 창 뒤 ESC를 기다리던 중이면 그 입장 창도 이어서 판단한다
    const entry = escRequest && escRequest.entry;
    escRequest = { until: Date.now() + (entry ? ENTRY_ESC_WAIT_MS : ESC_WAIT_MS), entry };
    setStatus('게임에서 ESC를 눌러 게임 메뉴를 열어 주세요 (이번 주 완료 레이드 확인)', 'warn');
  }

  function escTimeout() {
    const e = escRequest;
    escRequest = null;
    if (!e.entry) { setStatus('게임 메뉴를 못 찾았습니다 - 본인 캐릭터로 ESC를 열고 다시 [ESC 읽기]'); return; }
    closeGoldAlert([ESC_ALERT_TITLE]);
    log(`ESC 기다림 그만: ${entryLabel(e.entry)} - 시간 지남`);
    setStatus(`${entryLabel(e.entry)} - 내 캐릭터를 못 찾음(ESC를 못 읽음)`);
  }

  function findPhrase(lines, re, phrase) {
    for (const l of lines) {
      if (!re.test(l.text)) continue;
      const b = phraseBox(l, phrase);
      if (b) return b;
    }
    return null;
  }

  // 화면 전체 읽기는 줄이 섞이거나 빠져서, 기준 글자 위치만 찾고 그 패널만 크게 다시 읽는다.
  // 기준: "엔드 콘텐츠 골드 획득" 줄(골드 획득 지정 캐릭터만 있음) 또는 캐릭터 이름 바로 아래 "전체 현황 보기" 버튼.
  async function scanEsc(f) {
    const full = await readFull(f);
    const fullLines = full.data.lines || [];
    const eb = findPhrase(fullLines, /엔드\s*콘텐츠/, '엔드콘텐츠');
    const ab = !eb && findPhrase(fullLines, /전체\s*현황/, '전체현황');
    const b = eb || ab;
    if (!b) return;
    const bx0 = b.x0 / full.scale, bw = (b.x1 - b.x0) / full.scale;
    const by0 = b.y0 / full.scale, bh = (b.y1 - b.y0) / full.scale;
    // 패널 x 1270~1605, 캐릭터명 y ~306, 마지막 레이드 줄 y ~640(1758x1015, 1756x1017 실측).
    //  "엔드콘텐츠" x 1308~1372·높이 11 → 폭(bw) 기준 왼쪽 -0.6·폭 5.4, 높이(bh) 기준 위 11줄·전체 36줄.
    //  "전체현황" x 1414~1464·y 331~343 → 왼쪽 -2.9·폭 6.8, 위 3줄·전체 32줄.
    const g = eb ? { l: 0.6, w: 5.4, u: 11, h: 36 } : { l: 2.9, w: 6.8, u: 3, h: 32 };
    const rx = Math.max(0, bx0 - bw * g.l), ry = Math.max(0, by0 - bh * g.u);
    const rw = Math.min(f.width - rx, bw * g.w), rh = Math.min(f.height - ry, bh * g.h);
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
    const fullText = panel.text + '\n' + fullLines.map(l => l.text).join('\n');
    const me = characterPoolData
      .filter(c => (c.user || '').startsWith(selectedUser || '\u0000') && fullText.includes(c.name))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!me) return; // 아직 메뉴가 덜 보였거나 본인 캐릭터가 아님 - 시간 끝날 때까지 다시 본다
    const entry = escRequest && escRequest.entry;
    escRequest = null;
    const charName = me.name;
    if (recOn()) rec('esc', { charName, done, open: openOnly, img: shot(f, FULL_REGION, 1200) });
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
    // 입장 창 뒤라면 방금 맞춘 완료 체크까지 반영해서 그 입장 창 판단을 이어서 한다(상태 바/알림은 판단 쪽이 띄움)
    if (entry) { closeGoldAlert([ESC_ALERT_TITLE]); entrySoundFrom = Date.now(); judgeEntry(entry, charName); return; }
    setStatus(`ESC 확인: ${charName} - ${changed.length ? changed.join(', ') : '바꿀 것 없음'}`);
    notify('info');
  }

  // ─── 관리자 기록(점검용) ───────────────────────────────────
  // 관리자 모드로 공유하는 동안만 이 브라우저(IndexedDB)에 기록을 쌓고, [화면 공유] 옆 [기록 저장]으로 파일 하나(JSON)로 받는다
  // (2026-11-28 사용자 요청 - 매번 Claude가 감시를 심는 대신 하루 끝에 파일을 읽음). 관리자 모드가 아니면 아무것도 안 쌓는다.
  // 쌓는 것: 공유 기록 줄, 상태 줄, 알림(소리), 입장 창 화면(축소) + 직전 파티창 화면 6장과 읽은 글자, ESC를 읽은 화면.
  // 화면은 이 PC 안에만 저장된다(다운로드도 이 PC). 2일 지난 기록은 공유를 시작할 때 지운다.
  const REC_DB = 'loa_share_rec', REC_STORE = 'rec', REC_KEEP_MS = 2 * 24 * 60 * 60 * 1000;
  const FULL_REGION = { x: 0, y: 0, w: 1, h: 1 };
  const PARTY_SHOTS_MAX = 6;
  const partyShots = [];               // 최근 파티창 읽기 { t, text, items, img }
  let recDbP = null;

  function recOn() { return typeof isAdminModeActive === 'function' && isAdminModeActive(); }

  function recDb() {
    if (!recDbP) recDbP = new Promise((res, rej) => {
      const r = indexedDB.open(REC_DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(REC_STORE, { autoIncrement: true });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return recDbP;
  }

  function rec(type, data) {
    if (!recOn()) return;
    const item = { at: Date.now(), t: new Date().toLocaleString('ko-KR', { hour12: false }), type, ...data };
    recDb().then(db => { db.transaction(REC_STORE, 'readwrite').objectStore(REC_STORE).add(item); }).catch(() => {});
  }

  // 프레임의 비율 영역을 폭 maxW 이하로 줄인 JPEG(data URL)
  function shot(f, r, maxW) {
    try {
      const sx = f.width * r.x, sy = f.height * r.y, sw = f.width * r.w, sh = f.height * r.h;
      const s = Math.min(1, maxW / sw);
      const c = document.createElement('canvas');
      c.width = Math.round(sw * s); c.height = Math.round(sh * s);
      c.getContext('2d').drawImage(f, sx, sy, sw, sh, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.7);
    } catch (e) { return null; }
  }

  async function recPrune() {
    try {
      const db = await recDb();
      const store = db.transaction(REC_STORE, 'readwrite').objectStore(REC_STORE);
      const cut = Date.now() - REC_KEEP_MS;
      store.openCursor().onsuccess = e => {
        const cur = e.target.result;
        if (!cur) return;
        if (cur.value.at < cut) { cur.delete(); cur.continue(); }
      };
    } catch (e) {}
  }

  async function downloadRec() {
    let items = [];
    try {
      const db = await recDb();
      items = await new Promise((res, rej) => {
        const q = db.transaction(REC_STORE).objectStore(REC_STORE).getAll();
        q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
      });
    } catch (e) { customAlert('기록을 읽지 못했습니다: ' + (e && e.message ? e.message : e)); return; }
    if (!items.length) { customAlert('저장된 기록이 없습니다.\n관리자 모드로 화면 공유를 하는 동안만 기록이 쌓입니다.', '기록 저장'); return; }
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
    const blob = new Blob([JSON.stringify({ savedAt: d.toLocaleString('ko-KR', { hour12: false }), count: items.length, items })], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `raid-share-rec-${stamp}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // [화면 공유] 버튼 옆 [기록 저장] - 관리자 모드일 때만 보인다(이 파일은 처음 [화면 공유]를 누를 때 불러오므로 그 뒤부터).
  function renderRecBtn() {
    const btn = document.getElementById('raidShareRecBtn');
    if (!recOn()) { if (btn) btn.remove(); return; }
    const share = document.getElementById('raidShareBtn');
    if (btn || !share) return;
    const b = document.createElement('button');
    b.id = 'raidShareRecBtn';
    b.type = 'button';
    b.className = 'flex items-center gap-1 h-8 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white border border-gray-700 text-xs font-semibold px-2.5 rounded-lg transition';
    b.title = '관리자 모드로 화면 공유한 기록(최근 2일, 화면 캡처 포함)을 파일 하나로 받습니다';
    b.textContent = '기록 저장';
    b.onclick = () => downloadRec();
    share.after(b);
  }
  // 공유를 다시 시작하면 이 파일을 새로 불러오므로 앞 타이머는 끈다
  clearInterval(window.__raidShareRecTimer);
  window.__raidShareRecTimer = setInterval(renderRecBtn, 3000);

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
    if (el.textContent !== text) rec('status', { text });
    el.textContent = text;
    el.className = `flex-1 break-keep ${tone === 'warn' ? 'text-amber-300' : 'text-gray-300'}`;
  }

  function log(msg) {
    const t = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    rec('log', { msg });
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
    rec('alert', { kind, title: title || '', msg: message || '(소리만)' });
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
  let lastBeepAt = 0;
  function beep(times = 2) {
    lastBeepAt = Date.now();
    try {
      const ctx = getAudio(), t0 = ctx.currentTime;
      for (let i = 0; i < times; i++) {
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
    requestEsc, downloadRec,
    // 시험용(스샷 캔버스를 바로 넣어 보기)
    _test: { onEntryDialog, applyPartyToRoster, resolveAmbiguousByRoster, getLogs: () => logs.slice(), processFrame, readGoldSetting, readGoldHud, checkHud, startEndWatch, isWildTarget, setEndWatch: w => { endWatch = w; }, get endWatch() { return endWatch; }, setGoldWatch: w => { goldWatch = w; }, get goldWatch() { return goldWatch; }, parseDialog, judgeGold, locateParty, readParty, setLastParty: p => { lastParty = p; }, get lastParty() { return lastParty; }, get partyRegion() { return partyRegion; }, scanEsc, setManualClear, setEscRequest: r => { escRequest = r; }, get escRequest() { return escRequest; } }
  };
})();
