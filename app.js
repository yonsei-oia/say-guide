'use strict';

// tagsOpen: 태그 필터 <details>를 방문자가 손으로 열어 뒀는지(I-5). renderFilters()가
// 클릭마다 트리를 다시 지으므로, 이 상태가 없으면 태그 그룹이 매번 닫힌 채로
// 다시 그려진다.
var STATE = { places: [], offmap: [], cats: [], tags: [], sel: { categories: [], tags: [] }, tagsOpen: false };

function $(id) { return document.getElementById(id); }

function svgEl(name) { return document.createElementNS('http://www.w3.org/2000/svg', name); }

/**
 * "불러오지 못함"과 "0건"은 화면에서 반드시 달라야 한다(spec 8절).
 * 이 사이트가 조용히 빈 지도를 띄우면 아무도 고장을 눈치채지 못한다.
 */
function showError(heading, msg) {
  $('loading').hidden = true;
  $('app').hidden = true;
  var box = $('error');
  box.textContent = '';
  box.appendChild(mk('h2', heading));
  var p = document.createElement('p');
  p.textContent = msg;
  box.appendChild(p);
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Try again';
  btn.onclick = function () { location.reload(); };
  box.appendChild(btn);
  box.hidden = false;
}

// 콘솔에만 남긴다. 공개 화면에 원인을 노출하지 않으면서, devtools에서는
// 불러오기 실패와 렌더 실패를 구분할 수 있어야 한다.
function logError(e) {
  if (typeof console !== 'undefined' && console && console.error) console.error(e);
}

// showError는 #app을 숨기므로 완화 알림에 재사용할 수 없다. 지도는 그대로 두고
// 한 줄만 알린다.
function showNotice(msg) {
  var box = $('notice');
  box.textContent = msg;
  box.hidden = false;
}

/**
 * 0건은 두 가지다. 필터를 걸어서 0건인 것과, 아직 아무것도 올라오지 않아
 * 0건인 것. 후자는 개시 첫날의 정상 상태다. 둘을 같은 문구로 덮으면
 * 방문자는 필터를 풀어야 할지 나중에 다시 와야 할지 알 수 없다.
 * (불러오기 실패는 또 다른 화면이다 — showError가 #app 자체를 숨긴다.)
 */
function showEmptyState(isEmpty) {
  var box = $('empty');
  box.textContent = '';
  if (!isEmpty) { box.hidden = true; return; }
  var filtered = STATE.sel.categories.length || STATE.sel.tags.length;
  box.appendChild(mk('h2', filtered ? 'No places match these filters' : 'Nothing here yet'));
  box.appendChild(mk('p', filtered
    ? 'Try turning one of the filters above off.'
    : 'The first places will appear here once students start sending them in.'));
  if (filtered) {
    var btn = mk('button', 'Clear filters', { type: 'button' });
    btn.onclick = function () {
      STATE.sel.categories = [];
      STATE.sel.tags = [];
      // 칩 핸들러와 같은 자리 — render() 안에서가 아니라 이벤트에서 둘을 함께 부른다.
      renderFilters(); render();
      // 칩 트리를 새로 지었으니 이 버튼도 사라진다. 포커스가 <body>로 떨어지지
      // 않게 첫 칩으로 옮긴다.
      var first = $('filters').getElementsByTagName('button')[0];
      if (first && first.focus) first.focus();
    };
    box.appendChild(btn);
  }
  box.hidden = false;
}

function fetchCsv(url) {
  if (!url) return Promise.reject(new Error('not-configured'));
  return fetch(url, { cache: 'no-store' }).then(function (res) {
    if (!res.ok) throw new Error('http-' + res.status);
    return res.text();
  });
}

function boot() {
  // 시트 초기화가 실패해도 지도는 떠야 한다. 여기서 새는 예외는 프라미스 밖이라
  // 아래 catch가 잡지 못하고, 그러면 화면이 "Loading…"에 갇힌다.
  try { initSheet(); } catch (e) { logError(e); }

  // config.js나 lib.js가 도착하지 못하면 CONFIG·parsePublished가 없다. 그대로
  // 두면 Promise를 만들기도 전에 던져서, 역시 "Loading…"에 갇힌다.
  // index.html 끝의 인라인 가드는 app.js가 없을 때만 동작하므로 여기서 따로 막는다.
  if (typeof CONFIG === 'undefined' || !CONFIG || typeof parsePublished !== 'function') {
    logError(new Error('prerequisite script missing — CONFIG=' + (typeof CONFIG)
      + ', parsePublished=' + (typeof parsePublished)));
    showError('We could not load the guide',
      'Please check your connection and try again in a moment.');
    return;
  }

  // 정의 피드는 **전송 실패까지** 완화한다(R6). 여기서 잡지 않으면 404·빈 URL·
  // 오프라인이 Promise.all을 거부시켜 바깥 catch로 떨어지고, 게시본이 멀쩡한데도
  // 사이트 전체가 오류 화면이 된다. 구글의 웹에 게시 URL은 시트를 다시 게시하면
  // 바뀌므로 404는 드문 일이 아니다.
  // 빈 문자열을 돌려주는 이유: _parseDefs_가 그것을 {ok:false, reason:'no-header'}로
  // 읽어, 아래 degraded 경로가 파싱 실패와 똑같이 처리한다. 새 분기를 만들지 않는다.
  function defsCsv(url, label) {
    return fetchCsv(url)['catch'](function (e) {
      logError(new Error('definitions feed (' + label + ') failed to load: ' + e.message));
      return '';
    });
  }

  Promise.all([
    fetchCsv(CONFIG.CSV_PUBLISHED),
    defsCsv(CONFIG.CSV_CATEGORIES, 'categories'),
    defsCsv(CONFIG.CSV_TAGS, 'tags'),
  ]).then(function (texts) {
    var pub = parsePublished(texts[0]);
    var cat = parseCategories(texts[1]);
    var tag = parseTags(texts[2]);

    // 게시본이 깨지면 크게 실패한다. 헤더가 없거나 계약과 다르면 0건이 아니라
    // 오류다 — 게시본 QUERY가 깨지면 시트가 빈 채로 게시되는데, 그것을 "데이터
    // 없음"으로 읽으면 화면이 조용히 빈 지도가 된다.
    if (!pub.ok) {
      logError(new Error('published feed not ok: ' + pub.reason));
      showError('We could not load the guide',
        'Please check your connection and try again in a moment.');
      return;
    }

    // 게시본이 정상인데 조용히 사라지는 것 두 가지를 콘솔에 남긴다. 둘 다 화면에는
    // 띄우지 않는다 — 방문자가 할 수 있는 일이 없고, 정작 고칠 사람은 대표다.
    // **셀 값은 절대 남기지 않는다.** 건수만 센다.
    if (pub.queryEmpty) {
      logError(new Error('published feed returned QUERY empty output (#N/A) — '
        + 'nothing approved yet, showing the empty state'));
    }
    if (pub.dropped) {
      logError(new Error('published feed: ' + pub.dropped + ' row(s) dropped — '
        + 'fewer columns than the header, or a blank 장소ID'));
    }

    // 분류·태그 정의가 깨진 것은 게시본이 깨진 것과 다르다. 이 사이트의 핵심
    // 가치는 "그게 어디 있나"이고 그것은 전부 게시본에 있다. 정의가 없어도
    // 핀은 기본 남색으로, 분류 줄은 생략되어, 태그는 코드 그대로 그려진다
    // (Task 9의 catOf 폴백). 길 위에 선 학생에게 필터 없는 지도가 아무것도
    // 없는 오류 화면보다 낫다. 다만 조용히 넘기지는 않는다.
    var degraded = !cat.ok || !tag.ok;

    var grouped = groupPlaces(pub.items);
    STATE.places = grouped.places;
    STATE.offmap = grouped.offmap;
    STATE.cats = cat.ok ? cat.list : [];
    STATE.tags = tag.ok ? tag.list : [];

    $('loading').hidden = true;
    $('app').hidden = false;

    if (degraded) {
      logError(new Error('definitions unavailable — categories ok=' + cat.ok
        + ', tags ok=' + tag.ok));
      showNotice((cat.ok ? 'Tag' : (tag.ok ? 'Category' : 'Some'))
        + ' filters are unavailable right now. The map below still works.');
    }

    // render()의 예외를 불러오기 실패와 같은 catch에 넣지 않는다. 섞이면 화면이
    // "인터넷을 확인하라"고 거짓말하고 진짜 원인은 devtools에도 남지 않는다.
    try {
      // 필터 칩은 데이터가 들어온 뒤 여기서 한 번 그린다. 이후에는 칩 클릭
      // 핸들러가 renderFilters()와 render()를 함께 다시 부른다.
      // render() 안에서 renderFilters()를 부르지 않는 이유는 재귀가 아니라
      // 낭비다 — 클릭 한 번에 칩 트리를 두 번 헐고 짓게 되고, 그때마다
      // 포커스가 날아간다.
      renderFilters();
      render();
    } catch (e) {
      logError(e);
      // 불러오기 실패와 다른 문구여야 한다. 같은 말을 쓰면 코드 결함이
      // 방문자에게 통신 장애로 보고된다.
      showError('Something went wrong',
        'The map could not be drawn. Please try again in a moment.');
    }
  })['catch'](function (e) {
    logError(e);
    showError('We could not load the guide',
      'Please check your connection and try again in a moment.');
  });
}

document.addEventListener('DOMContentLoaded', boot);

function catOf(code) {
  for (var i = 0; i < STATE.cats.length; i++) {
    if (STATE.cats[i].코드 === code) return STATE.cats[i];
  }
  return null;
}

// ─── 색 ────────────────────────────────────────────────
// `핀색`은 시트에서 사람이 손으로 넣는 값이고, 그대로 fill이나 style.background로
// 흘러가면 `url(...)`이 될 수 있다 — 그러면 외부 리소스 0이라는 약속이 데이터 한
// 칸으로 깨진다. hex만 통과시킨다.
function safeHex(v) {
  var s = String(v == null ? '' : v).trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s : '';
}

function pinColor(code) {
  return safeHex((catOf(code) || {}).핀색) || '#003976';
}

/** 그 색 위에 올릴 글자색. 밝은 분류색에 흰 글씨를 얹어 읽히지 않는 칩을 만들지 않는다. */
function readableOn(hex) {
  var s = hex.slice(1);
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  var lin = [0, 2, 4].map(function (i) {
    var v = parseInt(s.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  var L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return L > 0.179 ? '#16181d' : '#ffffff';
}

/**
 * "1 places"를 만들지 않는다. 개시 직후의 화면이 정확히 그 숫자다.
 * 숫자와 단위 사이는 줄바꿈 금지 공백(U+00A0)이다 — 보통 공백을 쓰면
 * 좁은 화면에서 "128 / places"처럼 끊긴다.
 */
function countPhrase(n, word) {
  return n + '\u00a0' + word + (n === 1 ? '' : 's');
}

function render() {
  var shown = filterPlaces(STATE.places, STATE.sel);
  var off = filterPlaces(STATE.offmap, STATE.sel);
  // 지도 위든 아래든 한 줄 = 한 장소이고, 기여는 그 장소에 쌓인 개수다.
  var notes = 0;
  shown.forEach(function (p) { notes += p.기여.length; });
  off.forEach(function (p) { notes += p.기여.length; });
  // 숫자는 화면에 실제로 보이는 것과 같아야 한다. offmap을 빼고 세면
  // "3 places"라고 적힌 화면에 5개가 보인다.
  // 가운뎃점 양옆은 줄바꿈 금지 공백(U+00A0)이다. 숫자와 단위 사이도 같다 — countPhrase 참고.
  $('count').textContent = countPhrase(shown.length + off.length, 'place')
    + '\u00a0·\u00a0' + countPhrase(notes, 'note');

  drawPins(layoutPins(shown));
  renderOffmap(off);

  // 지도만 비고 아래 목록에는 결과가 남은 상태. 아무 말이 없으면 방문자는
  // 지도가 고장 났다고 읽는다 — 0건 화면(#empty)도 뜨지 않으니 설명이 아예 없다.
  var note = $('mapNote');
  if (!shown.length && off.length) {
    note.textContent = 'Nothing on the map matches these filters. '
      + 'The list below still has results.';
    note.hidden = false;
  } else {
    note.textContent = '';
    note.hidden = true;
  }

  showEmptyState(shown.length + off.length === 0);
}

// ─── 핀 배치 ────────────────────────────────────────────
// 치수는 전부 지도 좌표계(1000 단위)다. 지도 매트(index.html의 --map-pad, main
// 폭의 6.5%)는 main의 max-width(720px)까지만 뷰포트에 비례해 커진다 — main이
// 720px에서 막히므로 매트도 그 이상(1440px에서도)에서는 46.80px로 고정된다.
// 그래서 1단위당 px 값도 뷰포트마다 다르되, 720px부터는 더는 안 커진다.
// 375px 기기 기준(1단위 ≈ 0.326px):
//
//  PIN_R  44 → 지름 88단위 ≈ 28.7px  보이는 사진 원
//  TAP_R  65 → 지름 130단위 ≈ 42.4px 투명한 탭 원
//
// 탭 원끼리 겹치면 위에 그려진 핀이 아래 핀의 탭을 훔친다. 그래서 최소 간격을
// 탭 지름과 같은 130단위로 두고, 겹칠 자리의 핀은 밀어내거나(NUDGE_MAX까지)
// 그래도 자리가 없으면 가장 가까운 핀에 묶는다(클러스터).
//
// 탭 지름은 뷰포트가 커질수록 함께 커진다 — 실측 320px 36.2px · 360px 40.7px ·
// 375px 42.4px · 390px 44.1px · 720px 76.2px. 프로젝트 최소치 --tap(44px)에는
// 375px 부근까지 못 미치지만 WCAG 2.5.8 AA 최소치(24px)는 모든 폭에서 넘는다.
// 매트를 줄이면 이 수치를 44px에 되돌릴 수 있지만, 그러면 가장자리 핀과
// 클러스터 뱃지가 다시 잘린다(I-1·I-2) — 잘리지 않는 쪽을 택했다(컨트롤러 판정, I-3).
var PIN_R = 44;
var TAP_R = 65;
// 핀 사진과 목록 썸네일이 요청할 폭(px). 게시본에 박혀 오는 URL은 긴 변
// 1600px 하나뿐이라(penalty-app Api.gs:261) 그대로 쓰면 손톱만 한 핀이 1600px
// 원본을 받는다. 실측한 핀 사진 지름은 24.5px(320px 뷰포트)·28.7px(375px)·
// 51.6px(720px 이상 — main의 max-width에서 매트가 고정되므로 1440px에서도
// 같다)이고 목록 썸네일은 48px 고정이다. 가장 큰 51.6px에 고밀도 화면
// (DPR 3)을 곱하면 154.8px이므로 그 위인 200px로 잡는다.
// 원본 크기는 시트를 열었을 때의 사진에만 남는다(spec 6절의 "목록용은 썸네일").
var SMALL_IMG_W = 200;
var MIN_SEP = TAP_R * 2;
var NUDGE_MAX = 56;          // 참 좌표에서 밀어낼 수 있는 한계. 지도 폭의 5.6%.
var SPIRAL_STEPS = 48;

function _tooClose_(spots, x, y) {
  for (var i = 0; i < spots.length; i++) {
    var dx = spots[i].x - x, dy = spots[i].y - y;
    if (dx * dx + dy * dy < MIN_SEP * MIN_SEP) return true;
  }
  return false;
}

/**
 * 참 좌표를 먼저 시도하고, 막히면 황금각 나선을 따라 NUDGE_MAX까지만 밀어 본다.
 * 좌표를 clamp하지 않는다 — clamp는 학생이 찍은 자리에서 핀을 조용히 옮긴다.
 * 밀어내기도 상한을 둔다: 이 지도는 손으로 그린 도식이라 몇 % 어긋남은 원래
 * 좌표의 정밀도 안이지만, 상한이 없으면 핀이 다른 동네로 걸어간다.
 * 순번만으로 결정되므로 같은 입력이면 언제나 같은 배치가 나온다.
 */
function _freeSpot_(spots, tx, ty) {
  if (!_tooClose_(spots, tx, ty)) return [tx, ty];
  for (var k = 1; k <= SPIRAL_STEPS; k++) {
    var rad = NUDGE_MAX * Math.sqrt(k / SPIRAL_STEPS);
    var ang = k * 2.399963229728653;   // 황금각. 표본이 고르게 퍼진다.
    var x = tx + rad * Math.cos(ang);
    var y = ty + rad * Math.sin(ang);
    // 밀어낸 자리는 지도 안으로만. 참 좌표는 위에서 이미 무조건 시도했다.
    if (x < 0 || x > 1000 || y < 0 || y > 1000) continue;
    if (!_tooClose_(spots, x, y)) return [x, y];
  }
  return null;
}

function _nearestSpot_(spots, x, y) {
  var best = null, bd = Infinity;
  for (var i = 0; i < spots.length; i++) {
    var dx = spots[i].x - x, dy = spots[i].y - y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = spots[i]; }
  }
  return best;
}

/**
 * 장소 배열 → 그려질 핀 자리 배열. 한 자리에 장소가 둘 이상 묶이면 클러스터다.
 * places의 원본 객체는 절대 건드리지 않는다 — 좌표는 여기서 지역 변수로만 산다.
 */
function layoutPins(places) {
  var spots = [];
  places.forEach(function (p) {
    var tx = p.지도_X * 1000, ty = p.지도_Y * 1000;
    var at = _freeSpot_(spots, tx, ty);
    if (at) { spots.push({ x: at[0], y: at[1], list: [p] }); return; }
    var host = _nearestSpot_(spots, tx, ty);
    if (host) host.list.push(p);
    else spots.push({ x: tx, y: ty, list: [p] });   // 이론상 도달하지 않는다
  });
  return spots;
}

function pinLabel(spot) {
  if (spot.list.length > 1) return spot.list.length + ' places at this spot';
  var p = spot.list[0];
  return p.영상있음 ? p.제목 + ' (has video)' : p.제목;
}

/**
 * 핀은 언제나 사진 썸네일이다(spec 6절) — 텍스트 핀은 쌓일수록 못 쓰게 된다.
 * 하나하나 눌러야 정보가 나오기 때문이다. 사진을 핀으로 쓰면 누르지 않아도
 * 지도가 이미 정보다. 영상이 있는 핀은 같은 썸네일에 재생 아이콘만 얹는다.
 *
 * 구조: <g.pin> = [투명한 탭 원] + <g.pin-art pointer-events:none>[그림]
 * 포인터를 받는 것은 탭 원 하나뿐이라 그림이 이웃의 탭을 가로채지 않는다.
 */
function drawPins(spots) {
  var svg = $('zone-sinchon');
  Array.prototype.slice.call(svg.querySelectorAll('.pin')).forEach(function (n) { n.remove(); });

  spots.forEach(function (spot, i) {
    var head = spot.list[0];
    var cx = spot.x, cy = spot.y, r = PIN_R;

    var g = svgEl('g');
    g.setAttribute('class', 'pin');
    g.setAttribute('role', 'button');
    g.setAttribute('tabindex', '0');
    g.setAttribute('aria-label', pinLabel(spot));
    g.style.animationDelay = (Math.min(i, 24) * 18) + 'ms';

    var hit = svgEl('circle');
    hit.setAttribute('class', 'pin-hit');
    hit.setAttribute('cx', cx); hit.setAttribute('cy', cy); hit.setAttribute('r', TAP_R);
    g.appendChild(hit);

    var art = svgEl('g');
    art.setAttribute('class', 'pin-art');
    g.appendChild(art);

    // clipPath id는 장소ID가 아니라 렌더 순번으로 만든다. 장소ID를 문자 치환해
    // 쓰면 'ROOM 1'과 'ROOM#1'이 같은 id가 되고, SVG는 중복 id를 문서의 첫
    // 요소로 해석하므로 한 핀의 사진이 다른 핀의 원에 잘려 엉뚱한 자리에 뜬다.
    var cid = 'clip-pin-' + i;
    var defs = svgEl('defs');
    var clip = svgEl('clipPath');
    clip.setAttribute('id', cid);
    var cc = svgEl('circle');
    cc.setAttribute('cx', cx); cc.setAttribute('cy', cy); cc.setAttribute('r', r);
    clip.appendChild(cc); defs.appendChild(clip); art.appendChild(defs);

    // 분류 색 원을 사진 **아래** 깔아 둔다. 사진이 안 뜨거나 검증에서 걸리면
    // 이 원이 그대로 남아 핀이 보인다. (예전에는 사진이 있으면 링을
    // fill:none으로 두어, 사진이 404면 거의 안 보이는 흰 테두리만 남았다.)
    var bg = svgEl('circle');
    bg.setAttribute('cx', cx); bg.setAttribute('cy', cy); bg.setAttribute('r', r);
    bg.setAttribute('fill', pinColor(head.분류));
    art.appendChild(bg);

    // 사진 URL을 여기서 한 번 더 검사한다 — 통과 못 하면 분류 색 원만 남는다.
    // 핀에는 축소본을 건다(driveThumbUrl). 호스트가 그대로라 위 검사 결과도 그대로다.
    if (isDriveMedia(head.핀사진)) {
      var img = svgEl('image');
      img.setAttribute('href', driveThumbUrl(head.핀사진, SMALL_IMG_W));
      img.setAttribute('x', cx - r); img.setAttribute('y', cy - r);
      img.setAttribute('width', r * 2); img.setAttribute('height', r * 2);
      img.setAttribute('preserveAspectRatio', 'xMidYMid slice');
      img.setAttribute('clip-path', 'url(#' + cid + ')');
      art.appendChild(img);
    }

    var ring = svgEl('circle');
    ring.setAttribute('class', 'pin-ring');
    ring.setAttribute('cx', cx); ring.setAttribute('cy', cy); ring.setAttribute('r', r);
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', '#ffffff');
    ring.setAttribute('stroke-width', '6');
    art.appendChild(ring);

    if (spot.list.length === 1 && head.영상있음) {
      var disc = svgEl('circle');
      disc.setAttribute('cx', cx); disc.setAttribute('cy', cy); disc.setAttribute('r', 18);
      disc.setAttribute('fill', 'rgba(22,24,29,.62)');
      art.appendChild(disc);
      var tri = svgEl('path');
      var s = 9;
      tri.setAttribute('d', 'M' + (cx - s / 2) + ' ' + (cy - s) + ' L' + (cx + s) + ' ' + cy
        + ' L' + (cx - s / 2) + ' ' + (cy + s) + ' Z');
      tri.setAttribute('fill', '#ffffff');
      art.appendChild(tri);
    }

    // 클러스터 배지. 밀어내기로도 자리가 나지 않아 묶인 장소가 몇 개인지 밝힌다.
    // 배지 중심은 핀 중심에서 대각선으로 (29,-29) 떨어져 있다 — 즉
    // sqrt(29²+29²) = 41.01단위(29+23=52는 오산이다, 대각 합이 아니다).
    // 여기에 배지 반지름 23 + 스트로크 절반 2.5를 더하면 핀 중심에서
    // 최대 41.01+23+2.5 = 66.51단위까지 나간다. 이 값은 지도 매트
    // (index.html의 --map-pad, 폭 비례)가 모든 뷰포트에서 덮도록 맞춰져 있다(I-1).
    if (spot.list.length > 1) {
      var n = spot.list.length;
      var bx = cx + 29, by = cy - 29;
      var bc = svgEl('circle');
      bc.setAttribute('cx', bx); bc.setAttribute('cy', by); bc.setAttribute('r', 23);
      bc.setAttribute('fill', '#16181d');
      bc.setAttribute('stroke', '#ffffff');
      bc.setAttribute('stroke-width', '5');
      art.appendChild(bc);
      var bt = svgEl('text');
      bt.setAttribute('x', bx); bt.setAttribute('y', by);
      bt.setAttribute('text-anchor', 'middle');
      bt.setAttribute('dominant-baseline', 'central');
      // 배지에 적히는 숫자는 pinLabel의 aria-label이 읽어 주는 숫자와 **같아야**
      // 한다. 예전에는 10 이상을 '9+'로 줄여, 한 컨트롤이 보는 사람과 듣는
      // 사람에게 다른 수를 말했다.
      // 자릿수가 늘어도 원을 키우지 않는다 — 반지름 23은 위 주석의 66.51단위
      // 계산(=지도 매트 폭의 근거)에 그대로 들어가는 값이다. 대신 글자를 줄인다.
      // 원의 검은 면은 반지름 23 − 5/2 = 20.5단위까지다(흰 테는 그 바깥).
      // 이 서체군의 숫자는 폭 약 0.70em·대문자 높이 약 0.72em이므로 자릿수 d의
      // 숫자 상자는 반폭 0.35·d·f, 반높이 0.36·f이고, 그 모서리가 원 안에
      // 있으려면 f ≤ 20.5 / sqrt((0.35d)² + 0.36²)이면 된다.
      // → 한 자리 40.8(그래서 28로 자름) · 두 자리 26 · 세 자리 18 · 네 자리 14.
      var digits = String(n);
      var d = digits.length;
      bt.setAttribute('font-size',
        String(Math.min(28, Math.floor(20.5 / Math.sqrt(0.35 * d * (0.35 * d) + 0.36 * 0.36)))));
      bt.setAttribute('font-weight', '700');
      bt.setAttribute('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif');
      bt.setAttribute('fill', '#ffffff');
      bt.textContent = digits;
      art.appendChild(bt);
    }

    g.addEventListener('click', function () { openPlaces(spot.list, g); });
    g.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPlaces(spot.list, g); }
    });
    svg.appendChild(g);
  });
}

function mk(tag, text, attrs) {
  var el = document.createElement(tag);
  if (text != null) el.textContent = text;
  if (attrs) Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
  return el;
}

// ─── 하단 시트 ──────────────────────────────────────────
var LAST_OPENER = null;

function initSheet() {
  var dlg = $('sheet');
  if (!dlg) return;
  // 배경을 누르면 닫힌다. 한 손으로 쥔 폰에서 우상단 X는 멀다.
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  // <dialog>는 열기 전 포커스를 되돌려 주지만, 터치로 연 핀은 애초에 포커스를
  // 가진 적이 없다. 키보드 사용자가 지도 맨 앞으로 튕기지 않게 직접 되돌린다.
  dlg.addEventListener('close', function () {
    if (LAST_OPENER && LAST_OPENER.focus) LAST_OPENER.focus();
    LAST_OPENER = null;
  });
}

function closeIcon() {
  var s = svgEl('svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', '18'); s.setAttribute('height', '18');
  s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
  var p = svgEl('path');
  p.setAttribute('d', 'M5 5 L19 19 M19 5 L5 19');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '2.4');
  p.setAttribute('stroke-linecap', 'round');
  s.appendChild(p);
  return s;
}

// 태그 <details> 토글의 화살표(I-5). 유니코드 삼각형 대신 SVG로 그린다 — closeIcon()과
// 같은 이유: 이 프로젝트는 이모지는 물론 장식용 유니코드 글리프도 쓰지 않는다.
function chevronIcon() {
  var s = svgEl('svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', '14'); s.setAttribute('height', '14');
  s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
  s.setAttribute('class', 'chev');
  var p = svgEl('path');
  p.setAttribute('d', 'M6 9 L12 15 L18 9');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '2.4');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  s.appendChild(p);
  return s;
}

/**
 * 한 장소의 기여가 학기 표시와 함께 쌓여 보인다(spec 6절).
 * 시간이 지나면 같은 장소의 정보가 학기별로 쌓인 것이 그대로 보이고,
 * 조교가 사전 입력을 하지 않는데도 검증 효과가 생긴다.
 *
 * 클러스터 핀은 묶인 장소를 **한 시트에 이어서** 보여준다. 목록 → 상세로
 * 한 단계를 더 두지 않는 이유: 시트 안에서 뒤로가기를 만들면 <dialog> 하나에
 * 화면이 두 개가 되고 포커스·Esc 동작이 갈라진다. 몇 개 되지 않으니 스크롤이 낫다.
 */
function openPlaces(list, opener) {
  var dlg = $('sheet');
  LAST_OPENER = opener || null;
  dlg.textContent = '';

  dlg.appendChild(mk('div', null, { 'class': 'sheet-grab', 'aria-hidden': 'true' }));

  var head = mk('div', null, { 'class': 'sheet-head' });
  var h2 = mk('h2', list.length > 1 ? list.length + ' places at this spot' : list[0].제목,
    { id: 'sheetTitle', tabindex: '-1' });
  head.appendChild(h2);
  var close = mk('button', null, { type: 'button', 'class': 'sheet-close', 'aria-label': 'Close' });
  close.appendChild(closeIcon());
  close.onclick = function () { dlg.close(); };
  head.appendChild(close);
  dlg.appendChild(head);

  var body = mk('div', null, { 'class': 'sheet-body' });
  list.forEach(function (p) { body.appendChild(placeBlock(p, list.length > 1)); });
  dlg.appendChild(body);

  dlg.showModal();
  // <dialog>은 첫 포커스 가능한 자손을 잡는다. 영상이 있는 기여에서는 그것이
  // iframe이라, 열자마자 포커스가 유튜브 크기의 검은 상자 안으로 사라진다.
  // 제목으로 옮긴다 — 스크린리더는 이때 시트의 이름을 읽는다.
  if (h2.focus) h2.focus();
}

function placeBlock(p, withHeading) {
  var block = mk('div', null, { 'class': 'place-block' });
  if (withHeading) block.appendChild(mk('h3', p.제목));

  var c = catOf(p.분류);
  if (c && c.English) block.appendChild(mk('span', c.English, { 'class': 'sheet-cat' }));

  if (p.태그.length) {
    var ul = mk('ul', null, { 'class': 'taglist' });
    p.태그.forEach(function (code) {
      var t = null;
      for (var i = 0; i < STATE.tags.length; i++) {
        if (STATE.tags[i].코드 === code) { t = STATE.tags[i]; break; }
      }
      ul.appendChild(mk('li', t ? t.English : code));
    });
    block.appendChild(ul);
  }

  p.기여.forEach(function (it) { block.appendChild(noteCard(it)); });
  return block;
}

/**
 * 크레딧은 학생이 고른 닉네임이거나 기본값 '익명'이다(penalty-app Api.gs:132가
 * 빈 값을 '익명'으로 채운다 — 즉 거의 모든 제출이 이 값이다). 이 화면은 영어
 * 단일이므로 그 기본값만 영어로 옮긴다. 학생이 직접 적은 닉네임은 한글이어도
 * 그대로 둔다 — 그건 UI 문구가 아니라 그 사람의 이름이다.
 */
function creditName(v) {
  return String(v) === '익명' ? 'Anonymous' : v;
}

function noteCard(it) {
  var card = mk('article', null, { 'class': 'note-card' });
  // 배지에는 학기 코드(27S)가 아니라 읽어서 아는 형태(Spring 2027)를 낸다.
  // 코드는 OIA 내부 표기인데 이 화면에는 코드표가 없다. 정렬은 lib.js의
  // _semRank_가 코드 원본으로 계속 하므로 순서는 그대로다.
  card.appendChild(mk('p', semesterLabel(it.학기), { 'class': 'note-sem' }));

  // URL 3종은 lib.js의 가드를 통과해야만 그린다. 통과 못 하면 그 요소만
  // 빠지고 나머지는 그대로 그려진다 — 한 항목의 잘못된 링크가 페이지 전체를
  // 죽이지 않는다.
  if (it.미디어유형 === 'video' && isDriveMedia(it.영상_URL)) {
    // 재생은 드라이브 원본 하나로 통일한다(spec 6절). SNS 임베드가 죽었는지
    // 정적 사이트에서 감지하는 것은 신뢰할 수 없다 — iframe 실패는 오류가 아니라
    // 빈 사각형으로 나타난다. SNS는 부가 링크로만 둔다.
    card.appendChild(mk('iframe', null, {
      src: it.영상_URL, loading: 'lazy', allowfullscreen: '',
      title: it.제목, height: '220',
    }));
  } else if (isDriveMedia(it.사진_URL)) {
    // 목록에는 썸네일, 원본은 여기서만(spec 6절). 지연 로딩도 여기서 건다.
    // width는 CSS가 잡는다 — width="100%"는 HTML 속성으로는 무효값이라
    // 브라우저가 버리고, 그러면 크기 힌트가 아예 없는 것과 같다.
    card.appendChild(mk('img', null, {
      src: it.사진_URL, alt: it.제목, loading: 'lazy', decoding: 'async',
    }));
  }

  if (it.한줄팁) card.appendChild(mk('p', it.한줄팁, { 'class': 'tip' }));

  if (isGoogleMapsLink(it.구글맵_URL)) {
    card.appendChild(mk('a', 'Open in Google Maps', {
      href: it.구글맵_URL, target: '_blank', rel: 'noopener noreferrer',
    }));
  }
  if (isSafeLink(it.영상SNS_URL)) {
    card.appendChild(mk('a', 'Watch on social media', {
      href: it.영상SNS_URL, target: '_blank', rel: 'noopener noreferrer',
    }));
  }
  if (it.크레딧) card.appendChild(mk('p', 'by ' + creditName(it.크레딧), { 'class': 'credit' }));
  return card;
}

// ─── 필터 ───────────────────────────────────────────────
function toggle(arr, v) {
  var i = arr.indexOf(v);
  if (i === -1) arr.push(v); else arr.splice(i, 1);
}

/**
 * 분류 칩은 그 분류의 핀 색을 함께 쓴다 — 칩이 곧 지도 범례가 되어, 색을
 * 따로 설명하는 줄을 만들지 않아도 된다. 색은 시트에서 온 값이라 hex만
 * 통과시키고(safeHex), 글자색은 명도로 골라 밝은 분류색 위의 흰 글씨를 막는다.
 */
function chip(label, active, code, color, kind, onClick) {
  var b = mk('button', null, {
    type: 'button', 'data-code': code, 'class': 'chip' + (kind ? ' ' + kind : ''),
  });
  b.setAttribute('aria-pressed', active ? 'true' : 'false');
  if (color) {
    var dot = mk('span', null, { 'class': 'dot' });
    if (active) {
      var fg = readableOn(color);
      b.style.background = color;
      b.style.borderColor = color;
      b.style.color = fg;
      dot.style.background = fg;
      dot.style.opacity = '.5';
    } else {
      dot.style.background = color;
    }
    b.appendChild(dot);
  }
  b.appendChild(mk('span', label));
  b.onclick = onClick;
  return b;
}

/**
 * renderFilters()가 칩 트리를 통째로 새로 만들기 때문에, 방금 누른 버튼은
 * 문서에서 사라진다. 브라우저는 포커스 노드가 사라지면 포커스를 <body>로
 * 되돌리므로, 그대로 두면 키보드 사용자가 칩 하나 누를 때마다 페이지
 * 맨 위부터 Tab을 다시 해야 한다.
 * querySelector의 속성 선택자를 쓰지 않는다 — 코드 값이 선택자 문자열에
 * 들어가면 주입 표면이 된다. 자식 버튼을 순회한다.
 */
function refocusChip(code) {
  var nodes = $('filters').getElementsByTagName('button');
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].getAttribute('data-code') === code && nodes[i].focus) {
      nodes[i].focus();
      return;
    }
  }
}

/**
 * 태그 필터가 축적의 가치를 지킨다(spec 6절) — 500개가 쌓여도 "콘센트 있는 카페",
 * "ARC 없이 되는 은행"으로 걸러지면 오히려 더 유용해진다.
 * 다만 체크는 "확인함"이지 "없음의 반대"가 아니므로(spec 4.4), 필터가 무엇을
 * 보여주는지 한 줄로 밝힌다. 그렇지 않으면 체크를 빠뜨린 좋은 장소가
 * 존재하지 않는 것처럼 취급된다.
 */
function renderFilters() {
  var box = $('filters');
  box.textContent = '';

  // 칩은 places와 offmap을 합쳐서 판정한다. offmap에만 있는 분류·태그도
  // 필터 대상이므로 칩이 없으면 방문자가 걸러낼 수단을 잃는다.
  // Object.create(null)을 쓰는 이유: 평범한 {}는 'toString' 같은 코드가
  // 프로토타입에서 truthy를 얻어 데이터 0건짜리 유령 칩을 만든다.
  var all = STATE.places.concat(STATE.offmap);
  var present = Object.create(null);
  all.forEach(function (p) { present[p.분류] = 1; });
  var cats = STATE.cats.filter(function (c) { return present[c.코드]; })
    .sort(function (a, b) { return a.순서 - b.순서; });

  if (cats.length) {
    var crow = mk('div', null, { role: 'group', 'aria-label': 'Category', 'class': 'row' });
    cats.forEach(function (c) {
      crow.appendChild(chip(c.English, STATE.sel.categories.indexOf(c.코드) !== -1,
        'cat:' + c.코드, pinColor(c.코드), 'cat', function () {
          toggle(STATE.sel.categories, c.코드);
          renderFilters(); render();
          refocusChip('cat:' + c.코드);
        }));
    });
    box.appendChild(crow);
  }

  var tagPresent = Object.create(null);
  all.forEach(function (p) { (p.태그 || []).forEach(function (t) { tagPresent[t] = 1; }); });
  var groups = Object.create(null);
  STATE.tags.filter(function (t) { return tagPresent[t.코드]; })
    .sort(function (a, b) { return a.순서 - b.순서; })
    .forEach(function (t) { (groups[t.그룹] = groups[t.그룹] || []).push(t); });

  var groupKeys = Object.keys(groups);
  if (groupKeys.length) {
    // 태그 전체를 그룹 하나로 묶는다. 행마다 role=group을 주면 이름이 전부
    // "Tags"인 형제 그룹이 여러 개 생겨 스크린리더에 오히려 모호해진다.
    // 행별로 진짜 이름을 주려면 태그정의에 그룹의 영문명 컬럼이 필요한데
    // 현재 그 컬럼이 없다(그룹 값은 한국어 표시 라벨이라 이 화면에 낼 수 없다).
    // 행은 시각적 묶음으로만 남기고 role을 주지 않는다.
    var tagWrap = mk('div', null, { role: 'group', 'aria-label': 'Tags' });
    groupKeys.forEach(function (g) {
      var row = mk('div', null, { 'class': 'row' });
      groups[g].forEach(function (t) {
        row.appendChild(chip(t.English, STATE.sel.tags.indexOf(t.코드) !== -1,
          'tag:' + t.코드, '', 'tag', function () {
            toggle(STATE.sel.tags, t.코드);
            renderFilters(); render();
            refocusChip('tag:' + t.코드);
          }));
      });
      tagWrap.appendChild(row);
    });

    // 태그 그룹은 <details> 뒤로 접는다 — 지도가 첫 화면을 차지해야 하는데
    // (spec §7) 분류에 태그까지 매번 펼쳐 그리면 그 아래로 지도가 밀린다(I-5).
    //
    // 열림 상태는 **방문자만** 정한다(라운드 2 ruling) — 선택 상태를 근거로 코드가
    // 강제로 열지 않는다. 이전 버전은 태그가 선택돼 있으면 강제로 열었는데,
    // <details>.open을 스크립트로 바꾸면 브라우저가 'toggle' 이벤트를 **비동기로
    // 큐에 넣는다.** 그 이벤트가 나중에 발화하면 아래 리스너가 "방문자가 열었다"로
    // 잘못 해석해 STATE.tagsOpen을 true로 래치했고, 태그를 전부 해제해도 다시
    // 닫히지 않았다(N-2). 그래서 여기서는 STATE.tagsOpen(방문자가 지금 열어 둔
    // 상태인지 — 리스너가 매 toggle마다 details.open을 그대로 받아 적는다)
    // 하나만 본다. 최초 로드에서는 항상 false다.
    //
    // 대신 방문자가 패널을 닫아 둔 채로 태그를 걸어 두면(N-1) 화면에 남는 유일한
    // 신호가 #count뿐이라 왜 줄었는지 알 수 없다. 그래서 <summary> 자체 텍스트에
    // 활성 태그 수를 넣는다 — aria-label을 덧붙이지 않는 이유는 텍스트에 직접
    // 넣어야 시각·비시각 사용자가 같은 문구를 보고/듣기 때문이다.
    var details = document.createElement('details');
    details.className = 'tag-disclose';
    details.open = STATE.tagsOpen;
    details.addEventListener('toggle', function () { STATE.tagsOpen = details.open; });

    var activeTagCount = STATE.sel.tags.length;
    var tagLabel = 'Tags' + (activeTagCount
      ? ' · ' + activeTagCount + ' active' : '');
    var summary = document.createElement('summary');
    summary.appendChild(mk('span', tagLabel));
    summary.appendChild(chevronIcon());
    details.appendChild(summary);
    details.appendChild(tagWrap);

    if (STATE.sel.tags.length) {
      details.appendChild(mk('p', 'Filters show places where this was confirmed. '
        + 'A place without the tag may simply not have been checked.', { 'class': 'note' }));
    }

    box.appendChild(details);
  }
}

/**
 * offmap 항목은 지도 아래 별도 목록(spec 6절). 좌표로 표현되지 않는 것
 * — 동아리·교내활동 같은 — 이 예외 처리 없이 자리를 갖는다.
 *
 * 인자는 핀과 똑같은 Place 배열이다(groupPlaces가 offmap도 장소ID로 묶는다).
 * 그래서 한 줄이 곧 한 장소이고, 그 줄을 열면 그 장소의 기여가 학기별로 전부
 * 나온다 — 지도 위의 핀과 같은 규칙이다.
 */
function renderOffmap(places) {
  var wrap = $('offmapWrap'), list = $('offmapList');
  list.textContent = '';
  if (!places.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  places.forEach(function (p) {
    var li = mk('li');
    var b = mk('button', null, { type: 'button', 'class': 'place-row' });

    // 목록은 썸네일까지만. 원본은 시트를 열었을 때 뜬다(spec 6절).
    if (isDriveMedia(p.핀사진)) {
      b.appendChild(mk('img', null, {
        src: driveThumbUrl(p.핀사진, SMALL_IMG_W), alt: '', loading: 'lazy', decoding: 'async',
        'class': 'thumb', width: '48', height: '48',
      }));
    } else {
      var sw = mk('span', null, { 'class': 'swatch', 'aria-hidden': 'true' });
      sw.style.background = pinColor(p.분류);
      b.appendChild(sw);
    }

    var rt = mk('span', null, { 'class': 'rt' });
    rt.appendChild(mk('span', p.제목, { 'class': 't' }));
    var c = catOf(p.분류);
    if (c && c.English) rt.appendChild(mk('span', c.English, { 'class': 'c' }));
    b.appendChild(rt);

    b.onclick = function () { openPlaces([p], b); };
    li.appendChild(b);
    list.appendChild(li);
  });
}
