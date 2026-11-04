'use strict';
/**
 * 生成一对**完全虚构**的演示文件：demo/v1.xlsx 与 demo/v2.xlsx。
 * 不用任何真实业务数据，随便改、随便传，用来体验「上传两版看差异」。
 *
 * 两版的差别（可在界面上核对）：
 *   物料表：改 2 行（名称、单位）、删 1 行（SKU-0020）、加 1 行（SKU-0031）
 *   BOM 表：改 1 行（用量 2 → 3）
 *
 * 用法：node scripts/make-demo-files.js
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const OUT_DIR = path.join(__dirname, '..', 'demo');
// 两版必须**同名**：本工具按文件名归组，文件名不同就是两条互不相干的版本线
const DEMO_NAME = 'sample-materials.xlsx';
const MATERIAL_HEADER = ['物料编码', '物料名称', '规格型号', '单位', '默认仓库', '是否启用'];
const BOM_HEADER = ['父项编码', '子项编码', '用量', '单位', '备注'];

function materialRows(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    const code = 'SKU-' + String(i).padStart(4, '0');
    rows.push([code, '示例物料' + String(i).padStart(2, '0'), 'R-' + String(100 + i), i % 3 === 0 ? 'pcs' : 'kg', '主仓', '是']);
  }
  return rows;
}

function bomRows(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push(['SKU-0001', 'SKU-' + String(i + 1).padStart(4, '0'), i % 2 ? 2 : 1, 'pcs', '示例说明 ' + i]);
  }
  return rows;
}

function build(version) {
  const materials = materialRows(version === 1 ? 30 : 31);
  const bom = bomRows(20);

  if (version === 2) {
    // 改：名称 + 单位
    materials[4][1] = '示例物料05（改版）';
    materials[11][3] = 'pcs';
    // 删：SKU-0020
    materials.splice(19, 1);
    // 加：SKU-0031 已在末尾（materialRows 生成 31 行）
    // BOM 改用量
    bom[0][2] = 3;
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([MATERIAL_HEADER, ...materials]), '物料');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([BOM_HEADER, ...bom]), 'BOM');
  return wb;
}

function main() {
  for (const v of [1, 2]) {
    const dir = path.join(OUT_DIR, v === 1 ? '第1版' : '第2版');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, DEMO_NAME);
    XLSX.writeFile(build(v), file, { bookType: 'xlsx' });
    const kb = (fs.statSync(file).size / 1024).toFixed(1);
    console.log(`已生成 ${path.relative(path.join(__dirname, '..'), file)}  (${kb} KB)`);
  }
  console.log('\n用法：先上传 demo/第1版/sample-materials.xlsx，再上传 demo/第2版/sample-materials.xlsx（同名才会进同一条版本线）。');
  console.log('预期看到 4 行变化：改 2 行（名称、单位）、删 1 行（SKU-0020）、加 1 行（SKU-0031）。');
}

main();
