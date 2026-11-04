'use strict';

/**
 * 生成便携交付包 dist/ECT-portable/ 并压缩为 dist/ECT-portable.zip。
 *
 * 用法：项目根执行  node scripts/make-portable.js
 * 前提：Windows 环境（复制 node.exe、生成 .bat/.ps1、调用 PowerShell Compress-Archive）；
 *       node_modules/ 已存在（本脚本绝不执行 npm install，只复制现有产物）。
 *
 * 数据安全：重新打包**不删除**包内 data/ 与 logs/。旧实现是整目录 rmSync，
 * 会把用户上传的历史（snapshots 动辄上百 MB）一起删掉；现在只清理代码产物。
 * 压缩包从临时暂存目录（不含 data/logs）生成，保证分发出去的包里没有用户数据。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const TARGET = path.join(DIST, 'ECT-portable');
const ZIP = path.join(DIST, 'ECT-portable.zip');
const STAGE = path.join(DIST, '_stage-portable');

// 代码产物清单：重新打包时只清理这些，data/ 与 logs/ 原样保留
const CODE_ITEMS = ['src', 'public', 'node_modules', 'package.json', 'README.md', 'node.exe', '启动.bat', '创建快捷方式.ps1', '使用说明.txt'];

function rel(p) {
  return path.relative(ROOT, p);
}

/* ---------- 1. 只清理代码产物（保留 data/ 与 logs/） ---------- */

fs.mkdirSync(TARGET, { recursive: true });
for (const item of CODE_ITEMS) {
  const p = path.join(TARGET, item);
  if (!fs.existsSync(p)) continue;
  console.log(`清理旧产物：${rel(p)}`);
  fs.rmSync(p, { recursive: true, force: true });
}
if (fs.existsSync(ZIP)) {
  console.log(`清空旧压缩：${rel(ZIP)}`);
  fs.rmSync(ZIP, { force: true });
}

/* ---------- 2. 复制内容 ---------- */

if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
  console.error('缺少 node_modules/（请先在项目根 npm install 后再打包）。');
  process.exit(1);
}

for (const item of ['src', 'public', 'package.json', 'node_modules']) {
  console.log(`复制 ${item} ...`);
  fs.cpSync(path.join(ROOT, item), path.join(TARGET, item), { recursive: true });
}
fs.mkdirSync(path.join(TARGET, 'data'), { recursive: true });
fs.mkdirSync(path.join(TARGET, 'logs'), { recursive: true });
console.log('创建空目录 data/ logs/');

/* ---------- 3. 复制当前运行的 node.exe ---------- */

if (process.platform !== 'win32') {
  console.log('提示：当前平台非 Windows，node.exe / .bat / .ps1 / Compress-Archive 均为 Windows 交付用途。');
}
console.log(`复制 node.exe（来源：${process.execPath}）`);
fs.cpSync(process.execPath, path.join(TARGET, 'node.exe'));

/* ---------- 4. 启动.bat ---------- */

// UTF-8 无 BOM + 首行 chcp 65001（BOM 会让 cmd 把第一行解析成乱码命令）
const bat = [
  '@echo off',
  'chcp 65001 >nul',
  'set "ECT_ROOT=%~dp0"',
  'cd /d "%~dp0"',
  'echo ECT 便携版启动中... 若浏览器未自动打开，请按下方提示的地址手动访问。',
  'echo 关闭本窗口即退出程序（数据保存在本包 data\\ 目录内）。',
  'echo.',
  'node.exe src/server.js --open',
  'pause',
  '',
].join('\r\n');
fs.writeFileSync(path.join(TARGET, '启动.bat'), bat, 'utf8');
console.log('生成 启动.bat');

/* ---------- 5. 创建快捷方式.ps1 ---------- */

// 带 BOM 的 UTF-8：Windows PowerShell 5.1 对无 BOM 的 UTF-8 按 ANSI 解析，中文会乱码
const ps = '﻿' + [
  '$ErrorActionPreference = "Stop"',
  '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
  "$desktop = [Environment]::GetFolderPath('Desktop')",
  '$ws = New-Object -ComObject WScript.Shell',
  "$lnk = $ws.CreateShortcut((Join-Path $desktop 'Excel 变更对比.lnk'))",
  "$lnk.TargetPath = Join-Path $root '启动.bat'",
  '$lnk.WorkingDirectory = $root',
  "$lnk.IconLocation = (Join-Path $root 'node.exe') + ',0'",
  "$lnk.Description = 'Excel 字段级变更追踪工具'",
  '$lnk.Save()',
  "Write-Host ('已在桌面创建快捷方式：Excel 变更对比.lnk → ' + $lnk.TargetPath)",
  '',
].join('\r\n');
fs.writeFileSync(path.join(TARGET, '创建快捷方式.ps1'), ps, 'utf8');
console.log('生成 创建快捷方式.ps1');

/* ---------- 6. 使用说明.txt ---------- */

const txt = '﻿' + [
  'Excel 字段级变更追踪工具（ECT）· 便携版使用说明',
  '================================================',
  '',
  '1. 启动：双击包内的「启动.bat」；或右键「创建快捷方式.ps1」→「使用 PowerShell 运行」',
  '   在桌面生成「ECT 审计工具」快捷方式后，双击该快捷方式启动。',
  '',
  '2. 浏览器：启动后一般会自动打开页面；若没有打开，请手动访问命令行窗口里提示的地址',
  '   （默认 http://127.0.0.1:3000，仅本机可访问）。',
  '',
  '3. 数据在哪里：全部保存在本包内的 data\\ 目录（版本线、快照、变更记录、原始 Excel 备份），',
  '   运行日志在 logs\\app.log。不会写到电脑其它位置。',
  '',
  '4. 备份：把整个 data\\ 文件夹复制走即可（拷到 U 盘或网盘）；恢复时放回原位。',
  '',
  '5. 退出：直接关闭命令行窗口即可；或在命令行窗口按 Ctrl+C 结束。',
  '',
  '6. 端口被占用：默认端口 3000 被占用时会自动改用 3001-3005 中第一个可用端口，',
  '   命令行窗口会提示实际访问地址，按提示看即可；若 3000-3005 全部被占用会给出中文错误，',
  '   请关闭其它 ECT 实例后重试。',
  '',
  '7. 注意：本工具只读取你上传的 .xlsx 文件，绝不修改原始 Excel；',
  '   仅支持 .xlsx 格式，单文件不超过 20MB；插入/删除行列造成的位移变更会带“可能由行列位移引起”标记，请人工复核。',
  '',
].join('\r\n');
fs.writeFileSync(path.join(TARGET, '使用说明.txt'), txt, 'utf8');
console.log('生成 使用说明.txt');

/* ---------- 7. PowerShell 压缩（从暂存目录生成，不含 data/logs） ---------- */

const ZIP_ITEMS = ['src', 'public', 'package.json', 'node_modules', 'node.exe', '启动.bat', '创建快捷方式.ps1', '使用说明.txt'];
fs.rmSync(STAGE, { recursive: true, force: true });
const stagePkg = path.join(STAGE, 'ECT-portable');
fs.mkdirSync(stagePkg, { recursive: true });
for (const item of ZIP_ITEMS) {
  const from = path.join(TARGET, item);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(stagePkg, item), { recursive: true });
}
// 分发包里保留空的 data/ 与 logs/，用户首次解压即可用
fs.mkdirSync(path.join(stagePkg, 'data'), { recursive: true });
fs.mkdirSync(path.join(stagePkg, 'logs'), { recursive: true });

const psCmd = `Compress-Archive -Path '${stagePkg}' -DestinationPath '${ZIP}' -Force`;
console.log('压缩中（Compress-Archive）...');
const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], {
  encoding: 'utf8',
  windowsHide: true,
});
fs.rmSync(STAGE, { recursive: true, force: true });
if (r.status !== 0) {
  console.error('Compress-Archive 失败：' + (r.stderr || r.stdout || '未知错误'));
  process.exit(1);
}

const size = fs.statSync(ZIP).size;
console.log('\n打包完成：');
console.log(`  包目录：${TARGET}`);
console.log(`  压缩包：${ZIP}`);
console.log(`  体积：${(size / 1024 / 1024).toFixed(1)} MB`);
