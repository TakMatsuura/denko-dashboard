const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DATA_DIR = '/tmp/flam_data';
const SCRIPT_DIR = __dirname;
const TEMPLATE = path.join(SCRIPT_DIR, 'template.html');
const OUTPUT = path.join(SCRIPT_DIR, 'public', 'index.html');
const BUDGET = path.join(SCRIPT_DIR, 'budget.csv');

console.log('=== Convert encoding ===');
const csvFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.csv'));
for (const file of csvFiles) {
  const filePath = path.join(DATA_DIR, file);
  const buf = fs.readFileSync(filePath);
  let content;
  // 1. Try strict UTF-8 first (file is already UTF-8 if this succeeds)
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    console.log(`  UTF-8 (as-is): ${file}`);
  } catch (e) {
    // 2. Not valid UTF-8 -> decode as Shift-JIS (lossy fallback, never throws)
    content = new TextDecoder('shift_jis', { fatal: false }).decode(buf);
    console.log(`  SJIS->UTF8: ${file}`);
  }
  // Remove BOM
  content = content.replace(/^﻿/, '');
  fs.writeFileSync(filePath, content, 'utf8');
}

console.log('=== Build HTML ===');

// Read template
let template = fs.readFileSync(TEMPLATE, 'utf8');
// Normalize line endings
template = template.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

// Build CSV_DATA block
const keys = ['dept_product_sales', 'dept_purchase', 'stockrecents', 'dept_customer_sales', 'dept_sales', 'orders', 'customer_product_sales', 'sales_detail'];
let csvDataBlock = '<script>\nconst CSV_DATA = {\n';

for (const key of keys) {
  const filePath = path.join(DATA_DIR, `${key}.csv`);
  if (!fs.existsSync(filePath)) {
    console.log(`  MISSING: ${key}`);
    continue;
  }
  let content = fs.readFileSync(filePath, 'utf8');
  // Skip HTML/XML files (not CSV)
  const trimmed = content.trimStart();
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<?xml')) {
    console.log(`  SKIPPED (HTML/XML): ${key}`);
    continue;
  }
  // Remove/escape chars that would break the template literal
  content = content.replace(/\\/g, '\\\\').replace(/`/g, '').replace(/\$/g, '\\$').replace(/<\/script>/gi, '');
  const lines = content.split('\n').length;
  csvDataBlock += `${key}: \`\n${content}\n\`,\n`;
  console.log(`  Embedded: ${key} (${lines} lines)`);
}

// Add budget
const budgetContent = fs.readFileSync(BUDGET, 'utf8').replace(/\r\n/g, '\n').replace(/`/g, '');
csvDataBlock += `budget: \`\n${budgetContent}\n\`,\n`;
console.log(`  Embedded: budget`);

csvDataBlock += '};\n</script>\n';

// Replace placeholder
const placeholder = '// CSV_DATA_PLACEHOLDER';
const endPlaceholder = '// END_CSV_DATA_PLACEHOLDER';

const startIdx = template.indexOf(placeholder);
const endIdx = template.indexOf(endPlaceholder);

if (startIdx === -1 || endIdx === -1) {
  console.error('ERROR: Placeholders not found in template!');
  process.exit(1);
}

const before = template.substring(0, startIdx);
const after = template.substring(endIdx + endPlaceholder.length);

const output = before + csvDataBlock + after;

fs.mkdirSync(path.join(SCRIPT_DIR, 'public'), { recursive: true });
fs.writeFileSync(OUTPUT, output, 'utf8');

const lineCount = output.split('\n').length;
console.log(`=== Build complete ===`);
console.log(`Output: ${OUTPUT} (${lineCount} lines)`);

// Verify
const hasCSVData = output.includes('const CSV_DATA');
const scriptCount = (output.match(/<script>/g) || []).length;
console.log(`  Contains CSV_DATA: ${hasCSVData}`);
console.log(`  Script tags: ${scriptCount}`);

// Show structure around CSV_DATA
const lines = output.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('const CSV_DATA')) {
    console.log(`  CSV_DATA at line ${i+1}, prev: "${lines[i-1]?.trim()}", next: "${lines[i+1]?.trim().substring(0,50)}"`);
    break;
  }
}
