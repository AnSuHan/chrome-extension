# Chrome Web Store — 개인정보 보호 관행 탭 입력값 (Tabinet v1.1.0)

> 각 입력란은 **1,000자 제한**입니다. 아래 텍스트는 모두 그 안에 맞춰져 있습니다.

각 항목의 영문 텍스트를 그대로 붙여넣으면 됩니다. 검토자는 영어로 읽습니다.

---

## 1. 단일 목적 (Single purpose)  *(577/1,000자)*

```
Tabinet has one purpose: managing browser tabs as saved, named groups. It captures the tabs of a window (or of a single Chrome tab group) as a named, colored group, restores a saved group back into the window as a workspace, and lets the user edit those saved groups — rename, recolor, reorder, add or remove tabs, and export or import them as a JSON file. The docked side panel, the full-page editor, and the background service worker all serve that single function. The extension has no other feature, injects no content scripts, and does nothing unrelated to tab management.
```

---

## 2. 원격 코드 (Remote code)

**"아니요, 원격 코드를 사용하지 않습니다" 를 선택하세요.** 사유 입력란은 그러면 사라집니다.

코드로 확인한 근거 — 사실입니다:
- `eval()`, `new Function()`, `importScripts()` 사용 없음
- 외부 도메인에서 불러오는 `<script>`, CSS, 폰트, CDN 없음
- 모든 JS 는 패키지에 포함된 `src/**/*.js` 뿐이며, `import` 는 전부 상대 경로
- `innerHTML` 사용처는 6군데지만 전부 정적 리터럴이거나 `""`(비우기)이고, 외부에서 받은 문자열을 넣는 곳은 없음
- 네트워크 요청은 `src/background/prewarm.js` 의 `fetch` 하나뿐이며, 응답은 코드로 실행되지 않고 본문은 버려집니다 (아래 호스트 권한 항목 참조)

---

## 3. 권한별 사유 (Permission justification)

### tabs  *(487/1,000자)*

```
Reading and restoring tabs is the extension's core function. The permission is used to read the title, URL, index, and group membership of the tabs in the user's current window so a workspace can be captured, and to create, activate, move, reorder, and close tabs when a saved workspace is reopened or edited from the side panel. Only http(s) tabs are captured. Tab data is written to the user's own chrome.storage (local by default) and is never transmitted to us or to any third party.
```

### tabGroups  *(561/1,000자)*

```
When a saved workspace is restored, its tabs are bundled into a native Chrome tab group that carries the workspace's name and color, so the window shows which workspace is open and a workspace the user switches away from can stay live (collapsed) for instant switching back. The permission is also used to read an existing tab group's name, color, and membership for the "Save group" action, which snapshots only the tabs of the active tab's group. Users who turn off the "Keep workspaces live in the background" option cause no tab groups to be created at all.
```

### storage  *(479/1,000자)*

```
Used to persist the user's saved groups — group name, color, and each tab's title and URL — plus the extension's own settings, so they survive a browser restart. Data is written to chrome.storage.local by default. If the user explicitly enables the "Sync across devices" toggle, the same records are stored in chrome.storage.sync instead, so their groups appear on other Chrome profiles they are signed into. No other storage is used and no data is sent to any server we control.
```

### downloads  *(405/1,000자)*

```
Used for a single user-initiated action: the "Save" (export) button in the extension's editor writes all saved groups to a JSON backup file. The extension builds the JSON locally, creates a Blob URL, and calls chrome.downloads.download with saveAs:true so Chrome's own file dialog appears and the user chooses the location. Nothing is downloaded from the network and no file is written without that click.
```

### sidePanel  *(294/1,000자)*

```
The extension's primary interface is a docked side panel — the Safari-style sidebar where the user browses saved groups and the window's open tabs. The permission registers src/sidepanel/sidepanel.html as the panel and lets a click on the toolbar icon open it. It is not used for anything else.
```

### 호스트 권한 (host permissions — `http://*/*`, `https://*/*`)  *(980/1,000자)*

```
Used for one background feature: pre-warming the pages of a workspace the user just opened.

A restored workspace opens its tabs on a local placeholder instead of loading them all at once. The service worker then fetches those tabs' URLs (credentials:"include", redirect:"follow") so DNS/TLS is resolved, any login redirect is walked, and the document is in Chrome's HTTP cache before the click — which then lands on a signed-in page, not a cold load.

The response is never rendered, parsed, or inspected: an HTML body is drained only so it is cached, anything else is aborted after the headers. No page content is read, stored, or sent anywhere. Requests go only to sites the user saved themselves; we run no servers and involve no third party. Work is capped and aborted when the user switches away.

A cross-origin credentialed fetch from a service worker is blocked without host permissions, and the pattern must be broad because a workspace may hold any site the user saves.
```

---

## 4. 데이터 사용 인증 (Certification)

세 개 체크박스를 **모두 체크**하세요. Tabinet 은 데이터를 외부로 전송하지 않으므로 전부 사실입니다.

- 승인된 사용 사례를 위해서만 데이터를 사용/전송한다 ✔
- 데이터를 제3자에게 판매하지 않는다 ✔
- 신용도 평가나 대출 목적으로 데이터를 사용/전송하지 않는다 ✔

## 5. 데이터 수집 공개 (Data collection)

수집 항목은 **아무것도 선택하지 않습니다.** Tabinet 은 사용자 데이터를 개발자에게 전송하지 않습니다.

- 저장 위치는 `chrome.storage.local`(기기 내부) 이고, 사용자가 직접 켠 경우에만 `chrome.storage.sync`(사용자 본인의 Google 계정) 입니다. 둘 다 개발자가 접근할 수 없습니다.
- 분석·텔레메트리·광고 SDK 없음. 개발자가 운영하는 서버 자체가 없습니다.
- 프리워밍 `fetch` 는 **사용자가 저장한 사이트로** 나가는 요청이며, 응답을 읽거나 보관하지 않습니다. 개발자에게 오는 데이터가 아닙니다.

개인정보처리방침 URL 은 데이터를 수집하지 않으면 필수가 아닙니다. 다만 호스트 권한을 넓게 요청하는 항목은 검토가 길어질 수 있어, 위 3~5번 내용을 담은 한 페이지를 만들어 URL 을 넣어 두면 심사에 유리합니다.
