# dsh-fastpdf render server (Windows PowerShell 5.1 only).
# WinRT Windows.Data.Pdf is the OS PDF engine (PDFium based). PowerShell 7 (Core)
# cannot load WinRT projections, so this script must run under powershell.exe 5.1.
#
# Protocol: one JSON request per line on stdin, one JSON response per line on stdout.
#   {"id":1,"cmd":"info","path":"C:\\a.pdf"}
#   {"id":2,"cmd":"render","path":"C:\\a.pdf","page":0,"width":1000,"out":"C:\\b.png"}
#   {"id":3,"cmd":"close","path":"C:\\a.pdf"}
#   {"id":4,"cmd":"ping"}
# Responses: {"id":1,"ok":true,"pages":2,"sizes":[[794,1123]],"ms":12}
#            {"id":2,"ok":true,"ms":52,"out":"C:\\b.png"}
#            {"id":3,"ok":true}
#            {"id":4,"ok":true,"ready":true,"engine":"winrt-pdfium"}
# Errors:    {"id":n,"ok":false,"error":"..."}
#
# ASCII only: Windows PowerShell 5.1 reads .ps1 with the ANSI code page.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Cap how many open documents stay resident.
$MaxDocs = 3

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
} catch {
  [Console]::Out.WriteLine('{"ok":false,"error":"System.Runtime.WindowsRuntime missing"}')
  [Console]::Out.Flush()
  exit 1
}

$asTaskOperation = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
})[0]

function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskOperation.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
function AwaitAction($WinRtAction) {
  $netTask = $asTaskAction.Invoke($null, @($WinRtAction))
  $netTask.Wait(-1) | Out-Null
}

try {
  [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
} catch {
  [Console]::Out.WriteLine('{"ok":false,"error":"WinRT pdf types unavailable: ' + ($_.Exception.Message -replace '"', "'") + '"}')
  [Console]::Out.Flush()
  exit 1
}

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$stdout = [Console]::Out

function Reply($payload) {
  try {
    $script:stdout.WriteLine(($payload | ConvertTo-Json -Compress -Depth 6))
    $script:stdout.Flush()
  } catch {
    $script:stdout.WriteLine('{"ok":false,"error":"serialize failed"}')
    $script:stdout.Flush()
  }
}

# WinRT IClosable does not always surface as Close()/Dispose() through the
# PowerShell projection, so release best-effort and never let it fail a request.
function Release($obj) {
  if ($null -eq $obj) { return }
  try { $obj.Close() } catch { }
  try { $obj.Dispose() } catch { }
}

# Document cache: absolute path -> PdfDocument. Insertion order used for eviction.
$docs = New-Object 'System.Collections.Generic.List[object]'

function GetDoc([string]$path) {
  foreach ($entry in $docs) {
    if ($entry.Path -eq $path) { return $entry.Doc }
  }
  if (-not [System.IO.File]::Exists($path)) { throw "file not found: $path" }
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
  while ($docs.Count -ge $MaxDocs) {
    $old = $docs[0]
    $docs.RemoveAt(0)
    Release $old.Doc
  }
  $docs.Add([pscustomobject]@{ Path = $path; Doc = $doc })
  return $doc
}

function CloseDoc([string]$path) {
  for ($i = 0; $i -lt $docs.Count; $i++) {
    if ($docs[$i].Path -eq $path) {
      Release $docs[$i].Doc
      $docs.RemoveAt($i)
      return $true
    }
  }
  return $false
}

$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))

# Announce readiness so the host does not race the first request.
Reply ([pscustomobject]@{ ok = $true; ready = $true; engine = 'winrt-pdfium' })

while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }

  $id = 0
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $req = $line | ConvertFrom-Json
    if ($req.id) { $id = $req.id }
    $cmd = [string]$req.cmd
    $path = [string]$req.path

    if ($cmd -eq 'ping') {
      Reply ([pscustomobject]@{ id = $id; ok = $true; engine = 'winrt-pdfium'; docs = $docs.Count })
      continue
    }
    if ($cmd -eq 'close') {
      $closed = CloseDoc $path
      Reply ([pscustomobject]@{ id = $id; ok = $true; closed = $closed })
      continue
    }
    if ($cmd -eq 'info') {
      $doc = GetDoc $path
      $count = [int]$doc.PageCount
      $sizes = @()
      $probe = [Math]::Min($count, 40)
      for ($i = 0; $i -lt $probe; $i++) {
        $pg = $doc.GetPage($i)
        $sizes += , @([double]$pg.Size.Width, [double]$pg.Size.Height)
        Release $pg
      }
      $sw.Stop()
      Reply ([pscustomobject]@{ id = $id; ok = $true; pages = $count; sizes = $sizes; ms = $sw.ElapsedMilliseconds })
      continue
    }
    if ($cmd -eq 'render') {
      $doc = GetDoc $path
      $pageIndex = [int]$req.page
      $width = [int]$req.width
      $out = [string]$req.out
      if ($pageIndex -lt 0 -or $pageIndex -ge [int]$doc.PageCount) { throw "page out of range: $pageIndex" }
      if ($width -lt 80) { throw "width too small: $width" }
      if ($width -gt 4000) { $width = 4000 }
      $pg = $doc.GetPage($pageIndex)
      try {
        $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
        $opts.DestinationWidth = [uint32]$width
        $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
        try {
          AwaitAction ($pg.RenderToStreamAsync($stream, $opts))
          $netStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
          try {
            $dir = [System.IO.Path]::GetDirectoryName($out)
            if (-not [System.IO.Directory]::Exists($dir)) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }
            $fs = [System.IO.File]::Create($out)
            try { $netStream.CopyTo($fs) } finally { $fs.Close() }
          } finally { $netStream.Close() }
        } finally { Release $stream }
      } finally { Release $pg }
      $sw.Stop()
      Reply ([pscustomobject]@{ id = $id; ok = $true; ms = $sw.ElapsedMilliseconds; out = $out })
      continue
    }
    throw "unknown cmd: $cmd"
  } catch {
    $sw.Stop()
    $message = $_.Exception.Message -replace '"', "'"
    if ($message.Length -gt 400) { $message = $message.Substring(0, 400) }
    Reply ([pscustomobject]@{ id = $id; ok = $false; error = $message; ms = $sw.ElapsedMilliseconds })
  }
}

foreach ($entry in $docs) { Release $entry.Doc }
