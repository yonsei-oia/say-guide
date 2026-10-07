// 순수 함수만 둔다. document·window·fetch 등 브라우저 전역을 참조하지 않는다.
// 이 파일이 브라우저 없이 돌아야 tests/test_lib.js가 실제 red/green을 만든다.

/**
 * RFC4180 방식 CSV 파서. 외부 라이브러리를 쓰지 않는 이유는 이 하나로 충분하고
 * 의존을 늘리면 몇 년 뒤 이 사이트를 고치는 사람이 그것부터 복원해야 하기 때문이다.
 * 빈 필드를 반드시 보존한다 — 게시본은 빈 칸이 정상이고(한줄팁·영상SNS·offmap 좌표),
 * 삼키면 컬럼이 밀려 모든 행이 조용히 어긋난다.
 */
function parseCsv(text) {
  var s = String(text == null ? '' : text);
  if (!s) return [];
  var rows = [], row = [], field = '', inQuotes = false, i = 0;
  while (i < s.length) {
    var c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  row.push(field);
  // 마지막 줄이 개행으로 끝나면 빈 행 하나가 남는다 — 그것만 버린다.
  if (!(row.length === 1 && row[0] === '')) rows.push(row);
  return rows;
}

// 게시본 CSV의 기대 헤더. 게시본 QUERY가 select B,F,G,H,I,J,K,L,M,N,O,P,Q,U,D 이므로
// 이 순서·이름으로 나온다. 순서가 바뀌면 시트 쪽 수식이 바뀐 것이니 오류로 취급한다.
var PUBLISHED_COLS = [
  '장소ID', '분류', '제목', '한줄팁', '태그', '지도_구역', '지도_X', '지도_Y',
  '구글맵_URL', '미디어유형', '사진_URL', '영상_URL', '영상SNS_URL', '크레딧', '학기',
];

function _num_(v) {
  var s = String(v == null ? '' : v).trim();
  if (s === '') return null;
  var n = Number(s);
  return isFinite(n) ? n : null;
}

/**
 * 게시본 CSV를 항목 배열로 바꾼다.
 *
 * **헤더가 없으면 0건이 아니라 오류다.** 게시본은 QUERY 수식 한 칸으로 만들어지므로,
 * 수식이 깨지면 시트가 통째로 비고 CSV도 빈 문자열이 된다. 그것을 "데이터 없음"으로
 * 읽으면 화면이 조용히 빈 지도가 되고 아무도 눈치채지 못한다 — spec 8절이 이름을 붙여
 * 막아둔 실패 유형이다. 헤더 유무가 "읽었다"와 "못 읽었다"를 가르는 신호다.
 * 예외는 아래 `#N/A` 한 가지뿐이다 — 그것은 수식이 깨진 것이 아니라 조건에 맞는
 * 행이 0건이라는 QUERY의 빈 출력 토큰이다.
 */
function parsePublished(text) {
  var rows = parseCsv(text);
  if (!rows.length) return { ok: false, reason: 'no-header' };

  // 승인된 항목이 0건이면 게시본의 QUERY 한 칸이 `#N/A`만 내보낼 수 있다. 그것은
  // QUERY의 **빈 출력** 토큰이지 고장이 아니다 — 그 상태가 곧 개시 첫날이므로
  // "불러오지 못했습니다"를 띄우면 정상 상태를 고장으로 보고하는 셈이 된다.
  // 다른 오류 토큰(#REF!·#VALUE!·#ERROR!·#NAME?·#DIV/0! 등)은 수식 자체가 깨진
  // 것이므로 여기서 봐주지 않는다 — 위 주석의 fail-loud 규칙(spec 8절)이
  // 깨진 피드를 빈 피드처럼 보이지 않게 막는 유일한 장치다.
  // 그래서 **정확히 한 행 한 칸이 `#N/A`인 모양**만 통과시킨다. 호출자가 이
  // 사실을 로그로 남길 수 있도록 queryEmpty로 표시한다.
  if (rows.length === 1 && rows[0].length === 1
      && String(rows[0][0] == null ? '' : rows[0][0]).trim() === '#N/A') {
    return { ok: true, items: [], dropped: 0, queryEmpty: true };
  }

  var head = rows[0].map(function (h) { return String(h || '').trim(); });
  if (head.length !== PUBLISHED_COLS.length) return { ok: false, reason: 'header-mismatch' };
  for (var i = 0; i < PUBLISHED_COLS.length; i++) {
    if (head[i] !== PUBLISHED_COLS[i]) return { ok: false, reason: 'header-mismatch' };
  }

  var items = [], dropped = 0;
  for (var r = 1; r < rows.length; r++) {
    var row = rows[r];
    if (row.length < PUBLISHED_COLS.length) { dropped++; continue; }
    var o = {};
    for (var c = 0; c < PUBLISHED_COLS.length; c++) {
      o[PUBLISHED_COLS[c]] = String(row[c] == null ? '' : row[c]).trim();
    }
    o.태그 = o.태그 ? o.태그.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
    o.지도_X = _num_(o.지도_X);
    o.지도_Y = _num_(o.지도_Y);
    if (!o.장소ID) { dropped++; continue; }
    items.push(o);
  }
  return { ok: true, items: items, dropped: dropped };
}

var CATEGORY_COLS = ['코드', '한국어', 'English', '아이콘', '핀색', '순서'];
var TAG_COLS = ['코드', '한국어', 'English', '그룹', '적용분류', '아이콘', '순서'];

/** 정의 CSV 공통 처리. 헤더 불일치는 게시본과 같은 이유로 오류다. */
function _parseDefs_(text, cols) {
  var rows = parseCsv(text);
  if (!rows.length) return { ok: false, reason: 'no-header' };
  var head = rows[0].map(function (h) { return String(h || '').trim(); });
  if (head.length < cols.length) return { ok: false, reason: 'header-mismatch' };
  for (var i = 0; i < cols.length; i++) {
    if (head[i] !== cols[i]) return { ok: false, reason: 'header-mismatch' };
  }
  var list = [];
  for (var r = 1; r < rows.length; r++) {
    if (rows[r].length < cols.length) continue;
    var o = {};
    for (var c = 0; c < cols.length; c++) {
      o[cols[c]] = String(rows[r][c] == null ? '' : rows[r][c]).trim();
    }
    if (!o.코드) continue;
    o.순서 = Number(o.순서) || 0;
    list.push(o);
  }
  return { ok: true, list: list };
}

function parseCategories(text) {
  return _parseDefs_(text, CATEGORY_COLS);
}

function parseTags(text) {
  var r = _parseDefs_(text, TAG_COLS);
  if (!r.ok) return r;
  r.list.forEach(function (t) {
    t.적용분류 = t.적용분류
      ? t.적용분류.split(',').map(function (s) { return s.trim(); }).filter(Boolean)
      : [];
  });
  return r;
}

// 학기 코드를 정렬 가능한 숫자로. 27S=2027·1학기, 26F=2026·2학기, 26Su·25W.
// 학기 표기는 oia 규약(YY + S|F|Su|W)이다.
function _semRank_(code) {
  var m = String(code || '').match(/^(\d{2})(S|F|Su|W)$/);
  if (!m) return 0;
  var order = { 'S': 1, 'Su': 2, 'F': 3, 'W': 4 };
  return (2000 + Number(m[1])) * 10 + (order[m[2]] || 0);
}

/**
 * 지도에 꽂을 수 있는 좌표인가. 좌표는 viewBox 기준 0~1 정규화 비율이고
 * 화면에서 `값 × 1000`으로 쓰인다 — 범위를 벗어난 값이 그대로 통과하면
 * 핀이 지도 밖 수만 px 자리에 그려지고, 헤더 숫자는 그 핀을 세는데 지도에는
 * 없고 "Not on the map" 목록에도 없는 유령이 된다.
 * penalty-app이 저장 시점에 같은 검사를 하지만(Lib.gs:372) 그 앱은 아직 한
 * 번도 배포된 적이 없어 현재 시트의 모든 행이 수기 입력이다 — 상류 검증에
 * 기대지 않는다(R8과 같은 이유).
 * 0과 1은 **둘 다 유효한 좌표**다(지도 모서리). falsy 검사를 쓰지 않는다.
 */
function _inUnit_(v) {
  return typeof v === 'number' && v >= 0 && v <= 1;
}

/**
 * 학기 코드를 화면에 낼 문구로 바꾼다. `27S` → `Spring 2027`.
 *
 * `27S`·`26F`는 OIA 내부 표기이고 이 화면의 독자는 인바운드 교환학생이다.
 * 페이지 어디에도 코드표가 없으므로 코드를 그대로 내보내면 읽는 사람이
 * 뜻을 알 방법이 없다. **표시 전용이다** — 정렬은 _semRank_가 코드 원본으로
 * 계속 계산하므로 순서는 달라지지 않는다.
 * 해석되지 않는 값은 원문 그대로 돌려준다. 빈 배지를 만드는 것보다 낫다.
 */
function semesterLabel(code) {
  var s = String(code == null ? '' : code).trim();
  var m = s.match(/^(\d{2})(S|F|Su|W)$/);
  if (!m) return s;
  var name = { 'S': 'Spring', 'Su': 'Summer', 'F': 'Fall', 'W': 'Winter' };
  return name[m[2]] + ' ' + (2000 + Number(m[1]));
}

/**
 * 항목 배열을 `장소ID` 단위로 묶어 Place 배열을 만든다.
 * 대표값(제목·분류·좌표·핀사진)은 **가장 최신 기여**에서 가져온다 — 상호가 바뀌거나
 * 이전한 경우 최신 정보가 보여야 한다. 첫 등장 순서를 유지한다.
 */
function _groupById_(items) {
  var byId = {}, order = [];
  items.forEach(function (it) {
    var id = it.장소ID;
    if (!Object.prototype.hasOwnProperty.call(byId, id)) { byId[id] = []; order.push(id); }
    byId[id].push(it);
  });

  return order.map(function (id) {
    var list = byId[id].slice().sort(function (a, b) {
      return _semRank_(b.학기) - _semRank_(a.학기);
    });
    var newest = list[0];
    var tagSet = {}, tags = [], hasVideo = false;
    list.forEach(function (c) {
      (c.태그 || []).forEach(function (tg) {
        if (!Object.prototype.hasOwnProperty.call(tagSet, tg)) { tagSet[tg] = 1; tags.push(tg); }
      });
      // 재생 아이콘과 실제 재생 가능 여부를 일치시킨다 — 아이콘만 뜨고 영상이
      // 안 나오면 핀이 거짓말을 한다.
      if (c.미디어유형 === 'video' && isDriveMedia(c.영상_URL)) hasVideo = true;
    });
    return {
      장소ID: id, 분류: newest.분류, 제목: newest.제목,
      지도_X: newest.지도_X, 지도_Y: newest.지도_Y,
      핀사진: newest.사진_URL, 영상있음: hasVideo,
      태그: tags, 기여: list,
    };
  });
}

/**
 * 항목을 장소 단위로 묶는다. 한 핀 = 한 장소, 기여는 여러 개(spec 6절).
 * 좌표가 없거나 0~1 범위를 벗어난 sinchon 항목은 억지로 꽂지 않고 offmap으로
 * 보낸다. 잘못된 위치를 보여주는 것이 위치 없음보다 나쁘다.
 *
 * **offmap도 같은 규칙으로 묶는다.** 지도에 없는 것은 동아리·교내활동처럼
 * 학기마다 되풀이되는 항목이라 오히려 같은 장소ID가 여러 학기에 걸쳐 쌓인다.
 * 묶지 않으면 목록에 같은 줄이 두 번 나오고, 화면의 장소 수도 기여 수만큼
 * 부풀어 오른다 — spec 6절의 "한 장소, 기여는 학기별로 쌓임"이 지도 밖에서만
 * 적용되지 않는 셈이었다.
 */
function groupPlaces(items) {
  var mappedItems = [], offmapItems = [];
  items.forEach(function (it) {
    var mapped = it.지도_구역 === 'sinchon' && _inUnit_(it.지도_X) && _inUnit_(it.지도_Y);
    (mapped ? mappedItems : offmapItems).push(it);
  });

  var offmap = _groupById_(offmapItems);
  // offmap 장소의 좌표는 핀으로 쓸 수 없다 — 애초에 비었거나(offmap 구역) 0~1을
  // 벗어나서 여기로 내려온 값이다. 그대로 남겨 두면 누군가 이 배열을 지도에
  // 그리는 날 유령 핀이 되살아난다. 대표값을 여기서 끊는다.
  offmap.forEach(function (p) { p.지도_X = null; p.지도_Y = null; });

  return { places: _groupById_(mappedItems), offmap: offmap };
}

/**
 * 핀 단위 필터. 분류는 OR, 태그는 AND다.
 *
 * 태그를 AND로 두는 이유: "콘센트 있는 카페"를 찾는 사람은 와이파이만 있는 곳을
 * 원하지 않는다. spec 6절이 "500개가 쌓여도 걸러지면 오히려 더 유용해진다"고 적은
 * 그 동작이다.
 *
 * 태그가 하나도 없는 핀이 태그 필터에서 빠지는 것은 **설계대로다** — spec 4.4:
 * 체크는 "확인함"이지 "없음의 반대"가 아니며, 필터는 있다고 확인된 곳만 보여준다.
 * 화면에 그 뜻을 한 줄로 밝혀야 한다(Task 10).
 */
function filterPlaces(places, sel) {
  var cats = (sel && sel.categories) || [];
  var tags = (sel && sel.tags) || [];
  return places.filter(function (p) {
    if (cats.length && cats.indexOf(p.분류) === -1) return false;
    for (var i = 0; i < tags.length; i++) {
      if ((p.태그 || []).indexOf(tags[i]) === -1) return false;
    }
    return true;
  });
}

// ─── 공개 화면에 나가는 URL 방어 ─────────────────────────────
// 저장 시점 검증은 penalty-app에 있다(Lib.gs의 _isAppDriveUrl_·_isGoogleMapsUrl_).
// 그것에만 기대면 안 된다: penalty-app은 아직 한 번도 배포되지 않았고, 배포된
// 뒤에도 대표가 시트에서 행을 손으로 승인·수정하는 것이 정상 워크플로이며
// 게시 시점 재검증이 없다. 두 레포에 걸친 가정 대신 화면 바로 앞에서 막는다.

var GOOGLE_MAP_HOSTS = [
  'goo.gl', 'maps.app.goo.gl',
  'google.com', 'www.google.com', 'maps.google.com',
  'google.co.kr', 'www.google.co.kr', 'maps.google.co.kr',
];

/** https URL의 호스트(소문자·포트 제거). https가 아니면 빈 문자열. */
function urlHost(u) {
  var m = String(u == null ? '' : u).trim().match(/^https:\/\/([^\/?#]+)/i);
  return m ? m[1].toLowerCase().replace(/:\d+$/, '') : '';
}

/** href에 넣어도 되는가. https만 통과하므로 javascript:·data:·vbscript:가 막힌다. */
function isSafeLink(u) {
  return urlHost(u) !== '';
}

/** 구글맵 링크인가. 호스트 **완전일치** — `google\.[\w.]+` 류의 오른쪽 열린
 *  패턴은 `google.evil.com`을 통과시킨다. penalty-app의 목록과 같게 유지한다. */
function isGoogleMapsLink(u) {
  var h = urlHost(u);
  for (var i = 0; i < GOOGLE_MAP_HOSTS.length; i++) {
    if (h === GOOGLE_MAP_HOSTS[i]) return true;
  }
  return false;
}

/** iframe·img의 src로 써도 되는가. 드라이브가 호스팅하는 미디어만. */
function isDriveMedia(u) {
  return urlHost(u) === 'drive.google.com';
}

/**
 * 드라이브 썸네일 URL의 **크기 힌트만** 바꾼다.
 *
 * penalty-app이 사진을 저장할 때 만드는 URL은 긴 변 1600px 하나뿐이다
 * (`https://drive.google.com/thumbnail?id=<id>&sz=w1600` · Api.gs:261) — 그
 * 문자열이 승인된 행에 그대로 박혀 게시본으로 나온다. 그래서 실측 지름
 * 24.5~51.6px인 핀과 48px 목록 썸네일까지 1600px 원본을 받는다.
 * `<img>`에는 loading="lazy"가
 * 있지만 **SVG `<image>`에는 그런 속성이 없어** 핀 사진은 지도가 자리를 잡기도
 * 전에 전부 내려받는다. 첫 주의 방문자는 대개 로밍 중이다.
 *
 * 호스트·경로·나머지 쿼리는 건드리지 않으므로 isDriveMedia 판정은 그대로다.
 * `sz=`가 없는 URL은 **그대로 돌려준다** — 모양을 모르는 URL에 파라미터를
 * 끼워 넣어 깨뜨리는 것보다 큰 이미지를 한 번 더 받는 편이 낫다.
 */
function driveThumbUrl(u, w) {
  var s = String(u == null ? '' : u);
  var n = Math.round(Number(w));
  if (!isFinite(n) || n <= 0) return s;
  return s.replace(/([?&]sz=)[^&#]*/i, '$1w' + n);
}

/**
 * raw WebView를 쓰는 앱을 감지한다. 구글은 임베디드 WebView에서의 로그인을
 * 차단하므로, 도메인 제한 GAS 앱이 그런 창에서 열리면 학생은 화면을 보기도 전에
 * 로그인 실패나 무한 루프를 만난다. 그 실패는 **우리 코드가 실행되기 전에** 일어나
 * 서버 로그에도 시트에도 흔적이 없다 — 이행률만 조용히 낮아진다.
 *
 * 주의: Gmail 앱은 Android에서 Custom Tabs, iOS에서 SFSafariViewController를 쓰며
 * 둘 다 구글 로그인이 정상 동작한다. 실제 위험은 카카오톡·네이버·라인처럼
 * raw WebView를 쓰는 앱이고, 한국에서는 메일 링크를 카톡으로 옮겨 여는 경로가 흔하다.
 *
 * 패턴이 느슨한 것은 의도다. `Line\/`에 토큰 경계가 없어 `KoreanAirline/`처럼
 * 무관한 토큰도 걸린다. 그래도 좁히지 않는다 — 두 방향의 오류가 대칭이 아니기
 * 때문이다. 오탐은 다른 앱의 내장 브라우저 사용자에게 안내 화면을 한 번 더
 * 보여주는 비용이고(그런 앱은 대개 실제로 raw WebView다), 미탐은 학생이 흔적
 * 없는 로그인 실패로 들어가는 비용이다. 실제 크롬·사파리·파이어폭스·삼성
 * 인터넷·데스크톱 UA는 어느 것도 이 패턴에 걸리지 않는 것을 확인했다.
 */
function isRawWebView(ua) {
  var s = String(ua || '');
  if (/(KAKAOTALK|NAVER\(inapp|DaumApps|Line\/|FBAN|FBAV|FB_IAB|Instagram|Snapchat|MicroMessenger|everytimeApp)/i.test(s)) {
    return true;
  }
  // 안드로이드 일반 WebView는 UA에 '; wv)'를 넣는다.
  if (/;\s*wv\)/i.test(s)) return true;
  return false;
}
