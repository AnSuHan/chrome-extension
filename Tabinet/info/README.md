# Store submission material

Everything needed to fill in the Chrome Web Store listing for Tabinet. None of
this ships with the extension — the upload package contains only
`manifest.json`, `icons/`, and `src/`.

| Path | What it is |
|---|---|
| `store-description-en.txt` | The listing's **설명 / Description** field (3,454 of 16,000 chars). |
| `store-privacy-justifications.md` | The **개인정보 보호 관행** tab: single-purpose statement, the six permission justifications, remote-code answer, data-collection and certification guidance. Every block fits the 1,000-char field limit. |
| `screenshots/` | The five listing screenshots, 1280×800, 24-bit PNG (the store rejects alpha). |
| `screenshot-harness/` | Regenerates those screenshots from the real UI — see its own README. |
| `webstore-listing-form.png` | Reference capture of the dashboard form. |

## Listing values

| Field | Value |
|---|---|
| Category | Workflow & Planning |
| Language | English (United States) |
| Store icon | `../icons/icon128.png` |
| Privacy policy URL | <https://ansuhan.github.io/chrome-extension/tabinet/privacy.html> (source: `docs/tabinet/privacy.html`) |

## Building the upload package

The zip is a build artifact and is git-ignored (`dist/`). From the repo root:

```powershell
$ver  = (Get-Content Tabinet\manifest.json -Raw | ConvertFrom-Json).version
$stage = "$env:TEMP\tabinet-pack\Tabinet"
Remove-Item "$env:TEMP\tabinet-pack" -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$stage\icons" | Out-Null
Copy-Item Tabinet\manifest.json $stage
Copy-Item Tabinet\src "$stage\src" -Recurse
Copy-Item Tabinet\icons\*.png "$stage\icons"

Add-Type -AssemblyName System.IO.Compression.FileSystem
New-Item -ItemType Directory -Force dist | Out-Null
$zip = "dist\Tabinet-v$ver.zip"
Remove-Item $zip -Force -ErrorAction SilentlyContinue
$a = [System.IO.Compression.ZipFile]::Open((Resolve-Path .).Path + "\$zip", 'Create')
Get-ChildItem $stage -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($stage.Length + 1).Replace('\','/')
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($a, $_.FullName, $rel, 'Optimal') | Out-Null
}
$a.Dispose()
Remove-Item "$env:TEMP\tabinet-pack" -Recurse -Force
```

`Compress-Archive` is deliberately not used: it writes entry paths with
backslashes, which the store can reject. `manifest.json` must sit at the zip
root, and `docs/`, `test/`, and `info/` must stay out of it.
