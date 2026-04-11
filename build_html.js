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
  try {
    execSync(`iconv -f SHIFT_JIS -t UTF-8 "${filePath}" > "${filePath}.tmp" && mv "${filePath}.tmp" "${filePath}"`);
    console.log(`  Converted SJIS->UTF8: ${file}`);
  } catch (e) {
    console.log(`  Kept as-is: ${file}`);
  }
  // Remove BOM
  let content = fs.readFileSync(filePath, 'utf8');
  content = content.replace(/^\uFEFF/, '');
  fs.writeFileSync(filePath, content, 'utf8');
}

console.log('=== Build HTML ===');

// Read template
let template = fs.readFileSync(TEMPLATE, 'utf8');
// Normalize line endings
template = template.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

// Build CSV_DATA block
const keys = ['dept_product_sales', 'dept_purchase', 'stockrecents', 'dept_customer_sales', 'dept_sales', 'orders'];
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
  // Remove backticks and </script> tags that would break the template literal
  content = content.replace(/`/g, '').replace(/<\/script>/gi, '');
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
