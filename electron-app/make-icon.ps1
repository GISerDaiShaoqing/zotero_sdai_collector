# zotero_sdai_collector 应用图标：深青渐变圆角方块 + 白色 "sd" 连写（Shaoqing Dai）+ 青柠句点
Add-Type -AssemblyName System.Drawing

$size = 1024
$bg = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bg)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

# 渐变圆角方块背景
$rect = New-Object System.Drawing.Rectangle(24, 24, ($size - 48), ($size - 48))
$gp = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 230
$gp.AddArc($rect.X, $rect.Y, $r, $r, 180, 90)
$gp.AddArc($rect.Right - $r, $rect.Y, $r, $r, 270, 90)
$gp.AddArc($rect.Right - $r, $rect.Bottom - $r, $r, $r, 0, 90)
$gp.AddArc($rect.X, $rect.Bottom - $r, $r, $r, 90, 90)
$gp.CloseFigure()
$c1 = [System.Drawing.ColorTranslator]::FromHtml('#1cc5b0')
$c2 = [System.Drawing.ColorTranslator]::FromHtml('#0b5e54')
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, ([System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal))
$g.FillPath($bgBrush, $gp)

# sd 字样（白，MeasureString 手动居中略下沉）
$font = New-Object System.Drawing.Font('Segoe UI', 540, ([System.Drawing.FontStyle]([System.Drawing.FontStyle]::Bold -bor [System.Drawing.FontStyle]::Italic)))
$txtBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$measured = $g.MeasureString('sd', $font)
$tx = ($size - $measured.Width) / 2
$ty = ($size - $measured.Height) / 2 + 6
$g.DrawString('sd', $font, $txtBrush, $tx, $ty)

# 青柠句点：基线右端（sd. 的收尾感）
$dotR = 52
$baselineY = ($size - $measured.Height) / 2 + $measured.Height * 0.72
$dotX = $tx + $measured.Width - 10
$limeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#a3e635'))
$g.FillEllipse($limeBrush, ($dotX - $dotR), ($baselineY - $dotR), (2 * $dotR), (2 * $dotR))

# 降采样到 256 输出
$out = New-Object System.Drawing.Bitmap(256, 256)
$g2 = [System.Drawing.Graphics]::FromImage($out)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g2.DrawImage($bg, 0, 0, 256, 256)
$g.Dispose(); $g2.Dispose()
$out.Save((Join-Path $PSScriptRoot 'assets\icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$out.Dispose(); $bg.Dispose()
Write-Output 'icon generated'
