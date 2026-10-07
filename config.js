// 대표에게 받는 값. 전부 채워지기 전에는 사이트가 "정보를 불러오지 못했습니다"를 띄운다.
// 게시 URL 만드는 법: 구글시트 → 파일 → 공유 → 웹에 게시 → 해당 탭 선택 → CSV → 게시.
//   결과 형태: https://docs.google.com/spreadsheets/d/e/<PUBLISH_ID>/pub?gid=<GID>&single=true&output=csv
// ⚠️ 제출항목 탭은 절대 게시하지 않는다 — 파견ID와 미승인·반려 행이 들어 있다.
var CONFIG = {
  CSV_PUBLISHED: '',   // 게시본
  CSV_CATEGORIES: '',  // 분류정의
  CSV_TAGS: '',        // 태그정의
  // 업로드 앱 GAS 배포의 /exec URL. upload/index.html이 여기로 보낸다.
  UPLOAD_EXEC_URL: '',
};
