<#
  Regenerates the Chrome Web Store screenshots in ../screenshots.

  It renders the REAL extension UI (src/sidepanel, src/manager — unmodified)
  in headless Chrome, with chrome-mock.js standing in for the chrome.* APIs so
  the pages come up filled with sample groups instead of an empty profile.
  frame.html wraps the side panel in a neutral browser-window mock, because a
  docked side panel only makes sense next to a page.

  Usage:  powershell -ExecutionPolicy Bypass -File make-screenshots.ps1
#>

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ext  = Resolve-Path (Join-Path $here "..\..")      # the Tabinet/ folder
$dest = Join-Path $here "..\screenshots"
$work = Join-Path $env:TEMP "tabinet-shots"

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw "chrome.exe not found" }

# ---- stage: extension sources + harness, with the mock injected -------------
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Force $work | Out-Null
Copy-Item (Join-Path $ext "src")   (Join-Path $work "src") -Recurse
Copy-Item (Join-Path $ext "icons") (Join-Path $work "icons") -Recurse
Copy-Item (Join-Path $here "chrome-mock.js"), (Join-Path $here "director.js"),
          (Join-Path $here "frame.html") $work
Copy-Item (Join-Path $here "fav") (Join-Path $work "fav") -Recurse
Copy-Item (Join-Path $ext "icons\icon48.png") (Join-Path $work "fav\tabinet.png")

foreach ($page in "sidepanel", "manager") {
  $f = Join-Path $work "src\$page\$page.html"
  $html = Get-Content $f -Raw
  $html = $html -replace '<link rel="stylesheet"',
    "<script src=`"../../chrome-mock.js`"></script>`r`n    <link rel=`"stylesheet`""
  if ($page -eq "sidepanel") {
    $html = $html -replace '(<script type="module" src="sidepanel.js"></script>)',
      "`$1`r`n    <script src=`"../../director.js`"></script>"
  }
  Set-Content $f $html -Encoding utf8
}

# ---- render ----------------------------------------------------------------
$base = "file:///" + ($work -replace '\\', '/')
$common = @(
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--allow-file-access-from-files", "--virtual-time-budget=6000",
  "--user-data-dir=$work\profile", "--window-size=1280,800"
)
$shots = @(
  @{ n = "01-side-panel";      url = "$base/frame.html";                                        dark = $false },
  @{ n = "02-open-group";      url = "$base/frame.html?expand=g-research&top=saved";            dark = $false },
  @{ n = "03-editor";          url = "$base/src/manager/manager.html";                          dark = $false },
  @{ n = "04-side-panel-dark"; url = "$base/frame.html?dark=1&expand=g-reading&top=saved";      dark = $true  },
  @{ n = "05-editor-dark";     url = "$base/src/manager/manager.html";                          dark = $true  }
)
foreach ($s in $shots) {
  $a = $common + @("--screenshot=$work\$($s.n).png")
  if ($s.dark) { $a += "--force-dark-mode" }   # flips prefers-color-scheme
  Start-Process -FilePath $chrome -ArgumentList ($a + @($s.url)) -Wait -NoNewWindow
}

# ---- normalize: exactly 1280x800, 24-bit PNG (the store rejects alpha) ------
New-Item -ItemType Directory -Force $dest | Out-Null
foreach ($s in $shots) {
  $src = [System.Drawing.Image]::FromFile("$work\$($s.n).png")
  $bmp = New-Object System.Drawing.Bitmap 1280, 800, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.Clear([System.Drawing.Color]::White)
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, 1280, 800))
  $g.Dispose()
  $bmp.Save((Join-Path $dest "$($s.n).png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose(); $src.Dispose()
  Write-Output "wrote $($s.n).png"
}
Remove-Item $work -Recurse -Force
