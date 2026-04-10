#!/bin/bash
set -e

DATA_DIR="/tmp/flam_data"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$SCRIPT_DIR/template.html"
OUTPUT="$SCRIPT_DIR/public/index.html"

echo "=== Convert encoding ==="
for f in "$DATA_DIR"/*.csv; do
  if file "$f" | grep -qi "shift\|iso-8859\|Non-ISO"; then
    iconv -f SHIFT_JIS -t UTF-8 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    echo "  Converted: $(basename $f)"
  else
    sed -i '1s/^\xEF\xBB\xBF//' "$f" 2>/dev/null || true
    echo "  OK: $(basename $f) ($(wc -c < "$f") bytes)"
  fi
done

echo "=== Build HTML ==="
TMPDATA="/tmp/csv_data_block.txt"

echo "<script>" > "$TMPDATA"
echo "const CSV_DATA = {" >> "$TMPDATA"

for key in dept_product_sales dept_purchase stockrecents dept_customer_sales dept_sales orders; do
  if [ -f "$DATA_DIR/$key.csv" ]; then
    echo "$key: \`" >> "$TMPDATA"
    sed 's/`//g' "$DATA_DIR/$key.csv" >> "$TMPDATA"
    echo "\`," >> "$TMPDATA"
    echo "  Embedded: $key ($(wc -l < "$DATA_DIR/$key.csv") lines)"
  fi
done

echo "budget: \`" >> "$TMPDATA"
cat "$SCRIPT_DIR/budget.csv" >> "$TMPDATA"
echo "\`," >> "$TMPDATA"

echo "};" >> "$TMPDATA"
echo "</script>" >> "$TMPDATA"

sed -n '1,/\/\/ CSV_DATA_PLACEHOLDER/p' "$TEMPLATE" | head -n -1 > "$OUTPUT"
cat "$TMPDATA" >> "$OUTPUT"
sed -n '/\/\/ END_CSV_DATA_PLACEHOLDER/,$p' "$TEMPLATE" | tail -n +2 >> "$OUTPUT"

echo "=== Build complete ==="
echo "Output: $OUTPUT ($(wc -l < "$OUTPUT") lines)"
