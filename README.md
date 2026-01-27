# Full Page Screenshot

URL 목록을 입력하면 각 페이지의 전체 스크린샷을 자동으로 캡처하는 Chrome 확장 프로그램입니다.

## 주요 기능

- **URL 일괄 캡처**: 여러 URL을 한 번에 입력하여 순차적으로 스크린샷 촬영
- **큐 관리**: 캡처 중에도 대기열 수정 및 URL 추가 가능
- **중지/재개**: 어느 탭에서든 팝업을 열어 캡처 중지 가능
- **IntersectionObserver 대응**: lazy-loading 콘텐츠를 스크롤 시뮬레이션으로 사전 로드
- **비-document 스크롤 컨테이너 지원**: `<html>` 외 내부 요소에 스크롤이 있는 페이지도 전체 캡처
- **클릭 셀렉터**: 캡처 전 특정 요소 클릭 (쿠키 배너 닫기 등)
- **포맷 선택**: PNG / JPEG

## 설치

1. Chrome에서 `chrome://extensions` 접속
2. 우측 상단 **개발자 모드** 활성화
3. **압축해제된 확장 프로그램을 로드합니다** 클릭
4. 이 프로젝트 폴더 선택

## 사용법

1. 툴바의 확장 프로그램 아이콘 클릭
2. URL을 한 줄에 하나씩 입력
3. 옵션 설정:
   - **Wait after load**: 페이지 로드 후 추가 대기 시간 (ms)
   - **Format**: PNG 또는 JPEG
   - **Click selector** (선택): 캡처 전 클릭할 CSS 셀렉터 (예: `.cookie-accept`)
4. **Start Capture** 클릭
5. 스크린샷은 다운로드 폴더의 `screenshots/` 하위에 저장

### 캡처 중 조작

- **Stop**: 버튼 클릭으로 캡처 중지 (다른 탭에서 팝업을 열어도 가능)
- **Update Queue**: 남은 대기열을 수정
- **Add to Queue**: 새 URL을 대기열에 추가

## 동작 원리

1. 입력된 URL마다 새 탭을 열고 페이지 로드 대기
2. (선택) 지정된 CSS 셀렉터 요소 클릭
3. 스크롤 컨테이너 감지 (document 레벨 또는 내부 요소)
4. 전체 스크롤 시뮬레이션으로 lazy-loading 콘텐츠 로드
5. 비-document 스크롤 컨테이너의 경우 CSS를 수정하여 콘텐츠 펼침
6. Chrome Debugger Protocol로 전체 페이지 캡처
7. 다운로드 후 탭 정리

## 프로젝트 구조

```
scroll-screenshot/
├── manifest.json              # 확장 프로그램 매니페스트 (v3)
├── background/
│   └── service-worker.js      # 캡처 로직, 큐 관리, 메시지 처리
├── popup/
│   ├── popup.html             # 팝업 UI
│   ├── popup.js               # 팝업 로직, 상태 동기화
│   └── popup.css              # 팝업 스타일
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## 권한

| 권한 | 용도 |
|------|------|
| `tabs` | 탭 생성 및 상태 감지 |
| `debugger` | Chrome DevTools Protocol로 전체 페이지 캡처 |
| `downloads` | 스크린샷 파일 저장 |
| `activeTab` | 현재 탭 접근 |
| `scripting` | 페이지에 스크립트 주입 (스크롤 시뮬레이션, CSS 수정) |

## 제한사항

- 스크린샷 최대 높이: 16,384px (메모리 제한)
- `chrome://` 등 브라우저 내부 페이지는 캡처 불가
- 캡처 중 개별 URL 단위로만 중지 가능 (한 URL 캡처 도중에는 완료까지 대기)
