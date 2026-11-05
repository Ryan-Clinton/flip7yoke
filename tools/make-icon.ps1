# Draws the app icon (a cream 7 with a red shadow on deck navy) as PNGs at four sizes in assets\.
# tools/build.js packs them into assets\flip7yoke.ico. Our own design, not the published game's art.
Add-Type -AssemblyName System.Drawing
$out = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$navy = [System.Drawing.Color]::FromArgb(19, 42, 116)
$red = [System.Drawing.Color]::FromArgb(217, 68, 58)
$cream = [System.Drawing.Color]::FromArgb(246, 241, 231)

foreach ($s in 256, 48, 32, 16) {
  $bmp = New-Object System.Drawing.Bitmap -ArgumentList $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::Transparent)

  $d = [int]($s * 0.36)
  $e = $s - $d - 1
  $shape = New-Object System.Drawing.Drawing2D.GraphicsPath
  $shape.AddArc(0, 0, $d, $d, 180, 90)
  $shape.AddArc($e, 0, $d, $d, 270, 90)
  $shape.AddArc($e, $e, $d, $d, 0, 90)
  $shape.AddArc(0, $e, $d, $d, 90, 90)
  $shape.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush -ArgumentList $navy), $shape)

  $font = New-Object System.Drawing.Font -ArgumentList 'Segoe UI Black', ([single]($s * 0.66)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'
  $fmt.LineAlignment = 'Center'
  $off = [single]([math]::Max(1, $s * 0.045))
  $shadow = New-Object System.Drawing.RectangleF -ArgumentList $off, $off, ([single]$s), ([single]$s)
  $front = New-Object System.Drawing.RectangleF -ArgumentList ([single]0), ([single]0), ([single]$s), ([single]$s)
  $g.DrawString('7', $font, (New-Object System.Drawing.SolidBrush -ArgumentList $red), $shadow, $fmt)
  $g.DrawString('7', $font, (New-Object System.Drawing.SolidBrush -ArgumentList $cream), $front, $fmt)

  $bmp.Save((Join-Path $out "icon-$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
}

# flip7yoke.ico: the four PNGs in one icon file (PNG-compressed entries, which Windows Vista and later read).
$sizes = 256, 48, 32, 16
$pngs = $sizes | ForEach-Object { , [IO.File]::ReadAllBytes((Join-Path $out "icon-$_.png")) }
$ms = New-Object IO.MemoryStream
$w = New-Object IO.BinaryWriter($ms)
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$pngs[$i].Length); $w.Write([uint32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $w.Write($p) }
$w.Flush()
[IO.File]::WriteAllBytes((Join-Path $out 'flip7yoke.ico'), $ms.ToArray())
$w.Dispose()
