const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sandbox = {};
vm.createContext(sandbox);
for (const f of ['config.js', 'lib.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
}

let pass = 0, fail = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; fails.push(name + ' — ' + e.message); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((label || '') + ' expected ' + b + ' got ' + a);
}
function throwsErr(fn, label) {
  try { fn(); } catch (e) { return; }
  throw new Error((label || '') + ' expected throw');
}

// ─── 케이스는 태스크마다 아래에 추가한다 ───────────────
t('하네스 자체 점검', function () { eq(1 + 1, 2, 'sanity'); });

t('parseCsv 기본', function () {
  eq(sandbox.parseCsv('a,b,c\n1,2,3'), [['a','b','c'],['1','2','3']], 'simple');
});
t('parseCsv 따옴표 안의 쉼표', function () {
  eq(sandbox.parseCsv('a,"b,c",d'), [['a','b,c','d']], 'comma in quotes');
});
t('parseCsv 따옴표 안의 줄바꿈', function () {
  // 학생이 한줄팁에 줄바꿈을 넣으면 실제로 이렇게 나온다
  eq(sandbox.parseCsv('a,"line1\nline2",c'), [['a','line1\nline2','c']], 'newline in quotes');
});
t('parseCsv 이스케이프 따옴표', function () {
  eq(sandbox.parseCsv('a,"say ""hi""",c'), [['a','say "hi"','c']], 'escaped quote');
});
t('parseCsv CRLF와 빈 줄', function () {
  eq(sandbox.parseCsv('a,b\r\n1,2\r\n'), [['a','b'],['1','2']], 'crlf, trailing newline dropped');
  eq(sandbox.parseCsv(''), [], 'empty input');
});
t('parseCsv 빈 필드를 보존한다', function () {
  eq(sandbox.parseCsv('a,,c'), [['a','','c']], 'empty middle');
  eq(sandbox.parseCsv('a,b,'), [['a','b','']], 'empty last');
});

var HEAD = '장소ID,분류,제목,한줄팁,태그,지도_구역,지도_X,지도_Y,구글맵_URL,'
         + '미디어유형,사진_URL,영상_URL,영상SNS_URL,크레딧,학기';
var ROW1 = 'P1,cafe,Blue Bottle Sinchon,Quiet upstairs,"wifi,power",sinchon,0.4,0.6,'
         + 'https://maps.app.goo.gl/x,photo,https://drive.google.com/thumbnail?id=a,,,'
         + 'seoah,27S';

t('parsePublished 정상 파싱', function () {
  var r = sandbox.parsePublished(HEAD + '\n' + ROW1);
  eq(r.ok, true, 'ok');
  eq(r.items.length, 1, 'one item');
  eq(r.items[0].장소ID, 'P1', 'place id');
  eq(r.items[0].태그, ['wifi', 'power'], 'tags split');
  eq(r.items[0].지도_X, 0.4, 'x number');
});
t('parsePublished 헤더가 없으면 0건이 아니라 오류다', function () {
  // 게시본 QUERY 수식이 깨지면 시트가 빈 채로 게시된다. 그것을 "데이터 없음"으로
  // 읽으면 잘못된 것이 조용히 나간다 — spec 8절이 명시적으로 막는 실패 유형.
  var r = sandbox.parsePublished('');
  eq(r.ok, false, 'empty is error');
  eq(r.reason, 'no-header', 'reason');
});
t('parsePublished 헤더가 계약과 다르면 오류다', function () {
  var r = sandbox.parsePublished('장소ID,분류,제목\nP1,cafe,X');
  eq(r.ok, false, 'wrong header');
  eq(r.reason, 'header-mismatch', 'reason');
});
t('parsePublished 헤더만 있고 행이 없으면 정상 0건이다', function () {
  var r = sandbox.parsePublished(HEAD);
  eq(r.ok, true, 'ok');
  eq(r.items.length, 0, 'zero items');
});
t('parsePublished offmap 행은 좌표가 null이다', function () {
  var off = 'P2,club-activity,Clubs,,"",offmap,,,,video,'
          + 'https://drive.google.com/thumbnail?id=b,https://drive.google.com/file/d/v/preview,,익명,27S';
  var r = sandbox.parsePublished(HEAD + '\n' + off);
  eq(r.items[0].지도_X, null, 'x null');
  eq(r.items[0].태그, [], 'empty tags');
  eq(r.items[0].미디어유형, 'video', 'video');
});
t('parsePublished 승인 0건의 #N/A는 고장이 아니라 0건이다', function () {
  // 게시본은 QUERY 수식 한 칸이고, 조건에 맞는 행이 없으면 본문이 #N/A 하나가
  // 된다. 그 상태가 곧 개시 첫날이라 오류 화면을 띄우면 정상 상태를 고장으로
  // 보고하게 된다.
  var r = sandbox.parsePublished('#N/A');
  eq(r.ok, true, 'ok');
  eq(r.items.length, 0, 'zero items');
  eq(r.dropped, 0, 'zero dropped');
  eq(r.queryEmpty, true, '호출자가 로그로 남길 수 있게 표시된다');
  eq(sandbox.parsePublished(' #N/A \r\n').ok, true, '공백·CRLF가 붙어도 같다');
});
t('parsePublished 다른 오류 토큰은 여전히 크게 실패한다', function () {
  // #N/A만 빈 출력이다. 나머지는 수식이 깨진 것이므로 조용히 0건으로 바꾸면
  // 깨진 피드가 빈 피드처럼 보인다(spec 8절).
  ['#REF!', '#VALUE!', '#ERROR!', '#NAME?', '#DIV/0!', '#NULL!', '#N/A extra'].forEach(function (tok) {
    eq(sandbox.parsePublished(tok).ok, false, tok);
  });
  // 한 칸이 아니라 두 칸이면 모양이 다르다 — 통과시키지 않는다.
  eq(sandbox.parsePublished('#N/A,#N/A').ok, false, '두 칸');
  eq(sandbox.parsePublished('#N/A\n#N/A').ok, false, '두 행');
});
t('parsePublished 컬럼 수가 모자란 행은 버리고 세어 둔다', function () {
  var r = sandbox.parsePublished(HEAD + '\n' + ROW1 + '\nP3,cafe');
  eq(r.items.length, 1, 'short row dropped');
  eq(r.dropped, 1, 'counted');
});

var CAT_HEAD = '코드,한국어,English,아이콘,핀색,순서';
var TAG_HEAD = '코드,한국어,English,그룹,적용분류,아이콘,순서';

t('parseCategories 정상', function () {
  var r = sandbox.parseCategories(CAT_HEAD + '\ncafe,카페,Cafe,cup,#E8590C,21');
  eq(r.ok, true, 'ok');
  eq(r.list[0].English, 'Cafe', 'label');
  eq(r.list[0].순서, 21, 'order number');
});
t('parseCategories 헤더 없으면 오류', function () {
  eq(sandbox.parseCategories('').ok, false, 'empty');
  eq(sandbox.parseCategories('코드,한국어').ok, false, 'short header');
});
t('parseTags 적용분류를 배열로 쪼갠다', function () {
  var r = sandbox.parseTags(TAG_HEAD + '\nwifi,무료 와이파이,Free Wi-Fi,편의,"cafe,bakery",wifi,60');
  eq(r.list[0].적용분류, ['cafe', 'bakery'], 'split');
});
t('parseTags 와일드카드 적용분류를 보존한다', function () {
  var r = sandbox.parseTags(TAG_HEAD + '\nenglish-staff,영어 응대,English spoken,언어,*,speech,10');
  eq(r.list[0].적용분류, ['*'], 'wildcard kept');
});
t('parseTags 헤더만 있으면 정상 0건', function () {
  var r = sandbox.parseTags(TAG_HEAD);
  eq(r.ok, true, 'ok');
  eq(r.list.length, 0, 'zero');
});

function it_(o) {
  return Object.assign({
    장소ID: 'P1', 분류: 'cafe', 제목: 'A', 한줄팁: '', 태그: [],
    지도_구역: 'sinchon', 지도_X: 0.4, 지도_Y: 0.6, 구글맵_URL: 'https://maps.app.goo.gl/x',
    미디어유형: 'photo', 사진_URL: 'https://drive.google.com/thumbnail?id=a',
    영상_URL: '', 영상SNS_URL: '', 크레딧: '익명', 학기: '27S',
  }, o);
}

t('groupPlaces 같은 장소ID를 한 핀으로 묶는다', function () {
  var r = sandbox.groupPlaces([it_({학기:'26F'}), it_({학기:'27S', 제목:'A 최신'})]);
  eq(r.places.length, 1, 'one pin');
  eq(r.places[0].기여.length, 2, 'two contributions');
  eq(r.places[0].제목, 'A 최신', 'newest title wins');
  eq(r.places[0].기여[0].학기, '27S', 'newest first');
});
t('groupPlaces 태그를 합집합으로 모은다', function () {
  var r = sandbox.groupPlaces([
    it_({태그:['wifi']}), it_({태그:['power','wifi']}),
  ]);
  eq(r.places[0].태그.sort(), ['power','wifi'], 'union, deduped');
});
t('groupPlaces 영상 기여가 하나라도 있으면 표시한다', function () {
  var r = sandbox.groupPlaces([
    it_({미디어유형:'photo'}),
    it_({미디어유형:'video', 영상_URL:'https://drive.google.com/file/d/v/preview'}),
  ]);
  eq(r.places[0].영상있음, true, 'has video');
});
t('groupPlaces 핀 사진은 최신 기여의 것이다', function () {
  var r = sandbox.groupPlaces([
    it_({학기:'26F', 사진_URL:'https://drive.google.com/thumbnail?id=old'}),
    it_({학기:'27S', 사진_URL:'https://drive.google.com/thumbnail?id=new'}),
  ]);
  eq(r.places[0].핀사진, 'https://drive.google.com/thumbnail?id=new', 'newest photo');
});
t('groupPlaces offmap을 따로 담는다', function () {
  var r = sandbox.groupPlaces([it_(), it_({장소ID:'P9', 지도_구역:'offmap', 지도_X:null, 지도_Y:null})]);
  eq(r.places.length, 1, 'one mapped');
  eq(r.offmap.length, 1, 'one offmap');
});
t('groupPlaces 좌표 없는 sinchon 항목은 핀이 될 수 없다', function () {
  // 서버가 막지만, 과거 데이터나 수기 수정으로 들어올 수 있다. 조용히 (0,0)에
  // 꽂지 말고 offmap으로 보낸다 — 잘못된 위치보다 위치 없음이 정직하다.
  var r = sandbox.groupPlaces([it_({지도_X:null, 지도_Y:null})]);
  eq(r.places.length, 0, 'no pin');
  eq(r.offmap.length, 1, 'moved to offmap');
});
t('groupPlaces offmap도 장소ID로 묶는다', function () {
  // 지도에 없는 것은 동아리처럼 학기마다 되풀이되는 항목이라 같은 장소ID가
  // 여러 학기에 쌓인다. 묶지 않으면 목록에 같은 줄이 두 번 나오고 장소 수가
  // 기여 수만큼 부풀어 오른다.
  var off = { 장소ID:'CLUB', 지도_구역:'offmap', 지도_X:null, 지도_Y:null, 분류:'club-activity' };
  var r = sandbox.groupPlaces([
    it_(Object.assign({}, off, { 학기:'26F', 제목:'Hiking Club 26F', 태그:['english-staff'] })),
    it_(Object.assign({}, off, { 학기:'27S', 제목:'Hiking Club 27S', 태그:['english-signage'] })),
  ]);
  eq(r.places.length, 0, 'no pin');
  eq(r.offmap.length, 1, '한 장소로 묶인다');
  eq(r.offmap[0].제목, 'Hiking Club 27S', '최신 기여가 줄 이름');
  eq(r.offmap[0].기여.length, 2, '기여 둘이 다 남는다');
  eq(r.offmap[0].기여[0].학기, '27S', '최신 먼저');
  eq(r.offmap[0].태그.sort(), ['english-signage','english-staff'], '태그 합집합');
});
t('groupPlaces offmap 장소의 좌표는 비워 둔다', function () {
  // 범위를 벗어나 offmap으로 내려온 값이 대표값에 남으면, 나중에 이 배열을
  // 지도에 그리는 날 유령 핀이 되살아난다.
  var r = sandbox.groupPlaces([it_({장소ID:'BIG', 지도_X:420, 지도_Y:620})]);
  eq(r.offmap[0].지도_X, null, 'x cleared');
  eq(r.offmap[0].지도_Y, null, 'y cleared');
  eq(r.offmap[0].기여[0].지도_X, 420, '원본 기여는 그대로 둔다');
});
t('groupPlaces 0~1을 벗어난 좌표는 핀이 될 수 없다', function () {
  // 좌표는 × 1000으로 화면에 쓰인다. 420이 통과하면 핀이 left=137028px로 날아가고
  // 헤더 숫자만 그 핀을 센다 — 지도에도 offmap 목록에도 없는 유령이 된다.
  var r = sandbox.groupPlaces([
    it_({장소ID:'BIG', 지도_X:420, 지도_Y:620}),
    it_({장소ID:'NEG', 지도_X:-0.2, 지도_Y:0.5}),
    it_({장소ID:'OVER', 지도_X:0.5, 지도_Y:1.0001}),
  ]);
  eq(r.places.length, 0, 'no pin');
  eq(r.offmap.length, 3, 'all three moved to offmap');
});
t('groupPlaces 0과 1은 유효한 좌표다', function () {
  // 지도 모서리는 실재하는 위치다. falsy 검사로 짜면 0이 여기서 쓸려 나간다.
  var r = sandbox.groupPlaces([
    it_({장소ID:'ZERO', 지도_X:0, 지도_Y:0}),
    it_({장소ID:'ONE', 지도_X:1, 지도_Y:1}),
  ]);
  eq(r.places.length, 2, 'both stay pins');
  eq(r.offmap.length, 0, 'none dropped to offmap');
});

function pl_(o) {
  return Object.assign({ 장소ID:'P1', 분류:'cafe', 태그:[], 기여:[] }, o);
}

t('filterPlaces 아무것도 안 고르면 전부', function () {
  var ps = [pl_(), pl_({장소ID:'P2', 분류:'bank'})];
  eq(sandbox.filterPlaces(ps, {categories:[], tags:[]}).length, 2, 'all');
});
t('filterPlaces 분류는 OR', function () {
  var ps = [pl_({분류:'cafe'}), pl_({장소ID:'P2', 분류:'bank'}), pl_({장소ID:'P3', 분류:'gym'})];
  eq(sandbox.filterPlaces(ps, {categories:['cafe','bank'], tags:[]}).length, 2, 'or');
});
t('filterPlaces 태그는 AND', function () {
  // "콘센트 있는 카페"를 찾는 사람은 둘 다 있는 곳을 원한다
  var ps = [
    pl_({장소ID:'A', 태그:['wifi','power']}),
    pl_({장소ID:'B', 태그:['wifi']}),
  ];
  var r = sandbox.filterPlaces(ps, {categories:[], tags:['wifi','power']});
  eq(r.length, 1, 'and');
  eq(r[0].장소ID, 'A', 'which');
});
t('filterPlaces 분류와 태그를 함께 적용한다', function () {
  var ps = [
    pl_({장소ID:'A', 분류:'cafe', 태그:['wifi']}),
    pl_({장소ID:'B', 분류:'bank', 태그:['wifi']}),
  ];
  var r = sandbox.filterPlaces(ps, {categories:['cafe'], tags:['wifi']});
  eq(r.length, 1, 'both');
  eq(r[0].장소ID, 'A', 'which');
});
t('filterPlaces 태그 없는 핀은 태그 필터에서 빠진다', function () {
  // spec 4.4: 체크는 "확인함"이지 "없음의 반대"가 아니다. 필터는 있다고 확인된
  // 곳만 보여준다. 태그가 하나도 없는 핀이 빠지는 것은 설계대로다.
  var ps = [pl_({태그:[]})];
  eq(sandbox.filterPlaces(ps, {categories:[], tags:['wifi']}).length, 0, 'excluded');
});

var fsx = require('fs');
t('index.html의 좌표 계약이 유지된다', function () {
  var src = fsx.readFileSync(path.join(root, 'index.html'), 'utf8');
  if (src.indexOf('viewBox="0 0 1000 1000"') === -1) throw new Error('viewBox 계약 위반');
  if (src.indexOf('id="zone-sinchon"') === -1) throw new Error('zone id 계약 위반');
});
t('index.html에 외부 리소스가 없다', function () {
  var src = fsx.readFileSync(path.join(root, 'index.html'), 'utf8');
  if (/<script[^>]+src=["']https?:/i.test(src)) throw new Error('외부 스크립트');
  if (/<link[^>]+href=["']https?:/i.test(src)) throw new Error('외부 스타일시트');
  if (/@import/i.test(src)) throw new Error('@import');
});
t('푸터에 개발자 실명이 없다', function () {
  // 공개 화면이라 제외한다(spec 6절). 업로드 앱과 다르다.
  var src = fsx.readFileSync(path.join(root, 'index.html'), 'utf8');
  if (src.indexOf('Office of International Affairs') === -1) throw new Error('푸터 없음');
  if (/Developed by/i.test(src)) throw new Error('공개 화면에 개발자 실명');
});

t('isSafeLink는 https만 통과시킨다', function () {
  eq(sandbox.isSafeLink('https://example.com/x'), true, 'https');
  eq(sandbox.isSafeLink('javascript:alert(1)'), false, 'javascript');
  eq(sandbox.isSafeLink('JavaScript:alert(1)'), false, 'javascript 대소문자');
  eq(sandbox.isSafeLink('data:text/html,x'), false, 'data');
  eq(sandbox.isSafeLink('http://example.com'), false, 'http');
  eq(sandbox.isSafeLink(''), false, 'empty');
  eq(sandbox.isSafeLink(null), false, 'null');
});
t('isGoogleMapsLink는 호스트 완전일치다', function () {
  eq(sandbox.isGoogleMapsLink('https://maps.app.goo.gl/x'), true, '모바일 공유');
  eq(sandbox.isGoogleMapsLink('https://www.google.com/maps/place/x'), true, '데스크톱');
  eq(sandbox.isGoogleMapsLink('https://google.evil.com/maps'), false, '접미 공격');
  eq(sandbox.isGoogleMapsLink('https://maps.app.goo.gl.evil.com/x'), false, '접두 공격');
  eq(sandbox.isGoogleMapsLink('http://maps.app.goo.gl/x'), false, 'http');
});
t('isDriveMedia는 드라이브 호스트만 통과시킨다', function () {
  eq(sandbox.isDriveMedia('https://drive.google.com/thumbnail?id=a'), true, 'thumbnail');
  eq(sandbox.isDriveMedia('https://drive.google.com/file/d/v/preview'), true, 'preview');
  eq(sandbox.isDriveMedia('https://docs.google.com/x'), false, 'docs');
  eq(sandbox.isDriveMedia('https://drive.google.com.evil.com/x'), false, '접미 공격');
  eq(sandbox.isDriveMedia('javascript:alert(1)'), false, 'javascript');
});

t('semesterLabel은 학기 코드를 읽을 수 있는 형태로 바꾼다', function () {
  eq(sandbox.semesterLabel('27S'), 'Spring 2027', 'S');
  eq(sandbox.semesterLabel('26F'), 'Fall 2026', 'F');
  eq(sandbox.semesterLabel('26Su'), 'Summer 2026', 'Su — 정규식 역추적');
  eq(sandbox.semesterLabel('25W'), 'Winter 2025', 'W');
  eq(sandbox.semesterLabel(' 27S '), 'Spring 2027', '공백 제거');
});
t('semesterLabel은 해석 못 한 값을 원문 그대로 둔다', function () {
  // 빈 배지를 만들지 않는다.
  eq(sandbox.semesterLabel('2027-1'), '2027-1', '다른 표기');
  eq(sandbox.semesterLabel(''), '', '빈 값');
  eq(sandbox.semesterLabel(null), '', 'null');
});
t('학기 정렬은 표시 문구가 아니라 코드로 계속 계산된다', function () {
  // semesterLabel은 표시 전용이라는 계약. 알파벳순('Fall' < 'Spring' < 'Summer'
  // < 'Winter')으로 정렬했다면 이 순서가 나오지 않는다.
  var r = sandbox.groupPlaces([
    it_({학기:'26S'}), it_({학기:'26F'}), it_({학기:'25W'}), it_({학기:'26Su'}), it_({학기:'27S'}),
  ]);
  eq(r.places[0].기여.map(function (c) { return c.학기; }),
    ['27S', '26F', '26Su', '26S', '25W'], '시간 역순 유지');
});

t('driveThumbUrl은 크기 힌트만 바꾼다', function () {
  // 저장 시점 형태(Api.gs:261)가 유일한 실입력이다.
  eq(sandbox.driveThumbUrl('https://drive.google.com/thumbnail?id=abc&sz=w1600', 200),
    'https://drive.google.com/thumbnail?id=abc&sz=w200', 'w1600 → w200');
  // 호스트가 그대로여야 isDriveMedia 판정이 그대로다.
  eq(sandbox.isDriveMedia(sandbox.driveThumbUrl('https://drive.google.com/thumbnail?id=abc&sz=w1600', 200)),
    true, '가드는 여전히 통과');
  eq(sandbox.driveThumbUrl('https://drive.google.com/thumbnail?sz=s220&id=abc', 200),
    'https://drive.google.com/thumbnail?sz=w200&id=abc', 'sz가 첫 파라미터여도 뒤를 먹지 않는다');
});
t('driveThumbUrl은 sz가 없는 URL을 건드리지 않는다', function () {
  var noSz = 'https://drive.google.com/file/d/v/preview';
  eq(sandbox.driveThumbUrl(noSz, 200), noSz, '그대로');
  eq(sandbox.driveThumbUrl('https://drive.google.com/thumbnail?id=abc', 200),
    'https://drive.google.com/thumbnail?id=abc', '쿼리는 있고 sz만 없는 경우도 그대로');
  eq(sandbox.driveThumbUrl('', 200), '', '빈 값');
  eq(sandbox.driveThumbUrl(null, 200), '', 'null');
  eq(sandbox.driveThumbUrl('https://drive.google.com/thumbnail?id=abc&sz=w1600', 0),
    'https://drive.google.com/thumbnail?id=abc&sz=w1600', '폭이 0이면 원본 그대로');
});

t('isRawWebView 카카오톡·네이버·라인을 잡는다', function () {
  eq(sandbox.isRawWebView('Mozilla/5.0 ... KAKAOTALK 10.4.0'), true, 'kakao');
  eq(sandbox.isRawWebView('Mozilla/5.0 ... NAVER(inapp; search; 1000;)'), true, 'naver');
  eq(sandbox.isRawWebView('Mozilla/5.0 ... Line/13.0.0'), true, 'line');
  eq(sandbox.isRawWebView('Mozilla/5.0 ... FBAN/FBIOS;'), true, 'facebook');
  eq(sandbox.isRawWebView('Mozilla/5.0 ... Instagram 300.0'), true, 'instagram');
});
t('isRawWebView 안드로이드 일반 WebView를 잡는다', function () {
  eq(sandbox.isRawWebView('Mozilla/5.0 (Linux; Android 14; SM-S928N; wv) Chrome/126'), true, 'wv');
});
t('isRawWebView 정상 브라우저는 통과시킨다', function () {
  eq(sandbox.isRawWebView('Mozilla/5.0 (iPhone) AppleWebKit Version/17.0 Mobile Safari'), false, 'safari');
  eq(sandbox.isRawWebView('Mozilla/5.0 (Linux; Android 14) Chrome/126 Mobile Safari'), false, 'chrome');
  eq(sandbox.isRawWebView(''), false, 'empty');
});

console.log('통과 ' + pass + ' + 실패 ' + fail + ' = 전체 ' + (pass + fail));
if (fails.length) { console.log(fails.join('\n')); process.exit(1); }
