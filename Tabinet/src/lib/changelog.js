/**
 * Tabinet — release notes shown on the version page (src/about/).
 *
 * Newest first. Keep it in step with CHANGELOG.md and manifest.json's version:
 * the version page marks the entry matching the installed version as current.
 *
 * Each note: { type: "new" | "improved" | "fixed", text: { en, ko, ja } }.
 * A language missing from `text` falls back to English.
 */
export const CHANGELOG = [
  {
    version: "1.2.0",
    date: "2026-11-13",
    notes: [
      {
        type: "fixed",
        text: {
          en: "Saved groups no longer pile up: switching from an untracked window now adds unsaved tabs to one shared “Backup” group (and skips tabs that are already saved) instead of creating a new backup group every time.",
          ko: "저장 그룹이 계속 늘어나던 문제 해결: 추적되지 않은 창에서 전환할 때마다 새 백업 그룹을 만들던 동작을, 이미 저장된 탭은 건너뛰고 저장 안 된 탭만 하나의 공용 “백업” 그룹에 모으도록 변경했습니다.",
          ja: "保存グループが増え続ける問題を修正：追跡されていないウィンドウから切り替えるたびに新しいバックアップグループを作る代わりに、保存済みのタブは除き、未保存のタブだけを共通の「バックアップ」グループ1つにまとめるようにしました。",
        },
      },
      {
        type: "fixed",
        text: {
          en: "Tab groups no longer multiply after a browser restart: restored workspaces are re-attached to their saved groups, and stray duplicate copies are merged back.",
          ko: "브라우저 재시작 후 탭 그룹이 복제되어 늘어나던 문제 해결: 복원된 워크스페이스를 저장 그룹에 다시 연결하고, 중복된 사본은 하나로 합칩니다.",
          ja: "ブラウザ再起動後にタブグループが増殖する問題を修正：復元されたワークスペースを保存グループに再接続し、重複したコピーは1つに統合します。",
        },
      },
      {
        type: "fixed",
        text: {
          en: "“Save window” no longer saves the same set of tabs twice, and only saves the tabs you can see (not other workspaces hidden in collapsed groups).",
          ko: "“창 저장”이 같은 탭 구성을 중복 저장하지 않으며, 화면에 보이는 탭만 저장합니다(접힌 그룹에 숨은 다른 워크스페이스 제외).",
          ja: "「ウィンドウを保存」で同じタブ構成を重複保存しなくなり、表示中のタブだけを保存します（折りたたまれたグループ内の他のワークスペースは除外）。",
        },
      },
      {
        type: "new",
        text: {
          en: "Version page: see the installed version and the full release history (ⓘ in the side panel, or the version link in the editor).",
          ko: "버전 페이지 추가: 설치된 버전과 전체 패치 내역을 확인할 수 있습니다(사이드 패널의 ⓘ 또는 편집기의 버전 링크).",
          ja: "バージョンページを追加：インストール中のバージョンと更新履歴を確認できます（サイドパネルの ⓘ、またはエディタのバージョンリンク）。",
        },
      },
      {
        type: "new",
        text: {
          en: "Multiple languages: English, Korean and Japanese. Follows Chrome's language by default; pick one under Language in the editor.",
          ko: "다국어 지원: 영어·한국어·일본어. 기본은 크롬 언어를 따르며, 편집기의 언어 설정에서 직접 고를 수 있습니다.",
          ja: "多言語対応：英語・韓国語・日本語。既定では Chrome の言語に従い、エディタの「言語」で変更できます。",
        },
      },
    ],
  },
  {
    version: "1.1.0",
    date: "2026-08-26",
    notes: [
      {
        type: "new",
        text: {
          en: "Two auto-save options, each on/off: save where tabs navigate, and save tabs you add or close.",
          ko: "자동 저장 옵션 2개(개별 on/off): 탭 이동 반영, 탭 추가·닫기(개수 변경) 반영.",
          ja: "自動保存オプションを2つ追加（個別にオン/オフ）：タブの移動先を保存、タブの追加・クローズを保存。",
        },
      },
      {
        type: "improved",
        text: {
          en: "No more cold loading on click: opening a workspace loads its tabs in the background, so a clicked tab is already rendered.",
          ko: "클릭 시 cold loading 제거: 워크스페이스를 열면 탭을 백그라운드에서 미리 로딩해, 클릭하면 이미 렌더된 페이지가 뜹니다.",
          ja: "クリック時のコールドロードを解消：ワークスペースを開くとタブをバックグラウンドで読み込むため、クリック時には表示済みです。",
        },
      },
      {
        type: "new",
        text: {
          en: "New setting: Pre-load tabs when a workspace opens (on by default).",
          ko: "새 설정: 워크스페이스를 열 때 탭 미리 로딩(기본 켬).",
          ja: "新しい設定：ワークスペースを開くときにタブを先読み（既定でオン）。",
        },
      },
    ],
  },
  {
    version: "1.0.0",
    date: "2026-08-15",
    notes: [
      {
        type: "new",
        text: {
          en: "First release: Safari-style side panel, workspace switching without reloads, save / edit / sync of tab groups.",
          ko: "첫 정식 버전: Safari 스타일 사이드 패널, 재로딩 없는 워크스페이스 전환, 탭 그룹 저장·편집·동기화.",
          ja: "最初のリリース：Safari 風サイドパネル、再読み込みなしのワークスペース切り替え、タブグループの保存・編集・同期。",
        },
      },
      {
        type: "new",
        text: {
          en: "Background pre-warming on switch, and control over tab-group chips in the bookmarks bar.",
          ko: "전환 시 백그라운드 프리워밍, 북마크바 탭 그룹 칩 노출 제어.",
          ja: "切り替え時のバックグラウンド事前ウォームアップと、ブックマークバーのタブグループ表示の制御。",
        },
      },
      {
        type: "new",
        text: {
          en: "JSON export / import (merge or replace) and Sync across devices.",
          ko: "JSON 내보내기/가져오기(병합·전체 교체), 기기 간 동기화.",
          ja: "JSON のエクスポート/インポート（統合・置換）とデバイス間同期。",
        },
      },
    ],
  },
];
