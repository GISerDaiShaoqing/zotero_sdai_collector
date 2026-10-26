Add-Type -AssemblyName System.Drawing
$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)
# 微信绿圆底
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 7, 193, 96))
$g.FillEllipse($brush, 6, 6, 244, 244)
# 白色 Z
$font = New-Object System.Drawing.Font('Segoe UI', 130, [System.Drawing.FontStyle]::Bold)
$white = [System.Drawing.Brushes]::White
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = 'Center'
$fmt.LineAlignment = 'Center'
$rect = New-Object System.Drawing.RectangleF(0, 4, $size, $size)
$g.DrawString('Z', $font, $white, $rect, $fmt)
$dir = 'E:\Workspace\wechat_zotero_assistant\electron-app\assets'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$bmp.Save("$dir\icon.png", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host "icon saved"
