# 建立 dsh-path-guard 的端到端验收夹具。
#
#   pwsh -File scripts/make-fixture.ps1
#
# 生成的目录结构与 docs/ACCEPTANCE.md 里的规则一一对应。
# 夹具放在仓库外（默认 D:\dsh-path-guard-fixture），不会被提交，也不受仓库影响。

param(
  [string]$Root = 'D:\dsh-path-guard-fixture'
)

$ErrorActionPreference = 'Stop'

if (Test-Path $Root) { Remove-Item $Root -Recurse -Force }
New-Item -ItemType Directory -Path $Root | Out-Null

# 档位一：完全不可见 —— 目录结构、文件名、内容都不该被 AI 看到
New-Item -ItemType Directory -Path "$Root\hidden" | Out-Null
Set-Content "$Root\hidden\secret.txt"  'TOP-SECRET-CONTENT-AAA'
Set-Content "$Root\hidden\another.txt" 'TOP-SECRET-CONTENT-BBB'

# 档位二·半访问之「仅文件名」—— 能看到文件名，读不到内容
New-Item -ItemType Directory -Path "$Root\listed" | Out-Null
Set-Content "$Root\listed\visible-name.txt" 'LISTED-CONTENT-CCC'

# 档位二·半访问之「只读」—— 能读，不能写
New-Item -ItemType Directory -Path "$Root\readonly" | Out-Null
Set-Content "$Root\readonly\report.md" 'READONLY-CONTENT-DDD'

# 豁免：整目录仅文件名，其中一个文件豁免为可读（模拟 .ssh + .ssh/README.md）
New-Item -ItemType Directory -Path "$Root\sshlike" | Out-Null
Set-Content "$Root\sshlike\README.md" 'EXEMPT-READABLE-EEE'
Set-Content "$Root\sshlike\id_rsa"    'PRIVATE-KEY-FFF'

# 符号链接绕过尝试：指向 hidden/secret.txt 的"无辜"链接
New-Item -ItemType Directory -Path "$Root\open" | Out-Null
New-Item -ItemType SymbolicLink -Path "$Root\open\innocent-link" -Target "$Root\hidden\secret.txt" | Out-Null

# 对照组：不受任何规则覆盖的普通文件
Set-Content "$Root\open\normal.txt" 'NORMAL-GGG'

Write-Host "fixture ready: $Root"
Get-ChildItem $Root -Recurse -Force | Select-Object FullName, LinkType
