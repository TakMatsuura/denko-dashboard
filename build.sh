#!/bin/bash
set -e

FLAM_URL="https://dnk.flam.bz"
FLAM_ID="${FLAM_ID}"
FLAM_PW="${FLAM_PW}"

COOKIE_JAR="/tmp/flam_cookies.txt"
DATA_DIR="/tmp/flam_data"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DATA_DIR"

echo "=== Step 1: Login to FLAM ==="
# Step 1a: Get login page and cookies
curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$FLAM_URL/login" > /dev/null
echo "  Got login page, cookies: $(cat "$COOKIE_JAR" | grep -v '^#' | wc -l) entries"

# Step 1b: POST login
LOGIN_RESPONSE=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  -w "\nHTTP_CODE:%{http_code}\nREDIRECT:%{redirect_url}" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "data[User][loginid]=${FLAM_ID}" \
  --data-urlencode "data[User][password]=${FLAM_PW}" \
  -X POST \
  "$FLAM_URL/login" 2>&1)
echo "  Response body size: $(echo "$LOGIN_RESPONSE" | wc -c) bytes"
echo "  Contains 'login': $(echo "$LOGIN_RESPONSE" | grep -c 'loginid')"
echo "  Login response: $(echo "$LOGIN_RESPONSE" | grep HTTP_CODE)"
echo "  Redirect: $(echo "$LOGIN_RESPONSE" | grep REDIRECT)"
echo "  Cookies after login: $(cat "$COOKIE_JAR" | grep -v '^#' | wc -l) entries"

# Step 1c: Follow redirect to complete login
curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" -L "$FLAM_URL/" > /dev/null
echo "Logged in"

# Step 1d: Verify login by checking if we can access a page
VERIFY=$(curl -s -b "$COOKIE_JAR" -o /dev/null -w "%{http_code}" "$FLAM_URL/sales/totalize")
echo "  Verify access: HTTP $VERIFY"

echo "=== Step 2: Download CSVs ==="
START="2025%2F05%2F01"
END="2026%2F04%2F30"

curl -s -b "$COOKIE_JAR" "$FLAM_URL/sales/totalize/export?startdate=$START&enddate=$END&grouping%5B%5D=section&grouping%5B%5D=slipdate&file-format=csv" -o "$DATA_DIR/dept_sales.csv"
echo "Downloaded: dept_sales"

curl -s -b "$COOKIE_JAR" "$FLAM_URL/sales/totalize/export?startdate=$START&enddate=$END&grouping%5B%5D=customer&grouping%5B%5D=section&file-format=csv" -o "$DATA_DIR/dept_customer_sales.csv"
echo "Downloaded: dept_customer_sales"

curl -s -b "$COOKIE_JAR" "$FLAM_URL/sales/totalize/export?startdate=$START&enddate=$END&grouping%5B%5D=section&grouping%5B%5D=product&grouping%5B%5D=slipdate&file-format=csv" -o "$DATA_DIR/dept_product_sales.csv"
echo "Downloaded: dept_product_sales"

curl -s -b "$COOKIE_JAR" "$FLAM_URL/purchases/totalize/export?startdate=$START&enddate=$END&grouping%5B%5D=suppliers&grouping%5B%5D=section&grouping%5B%5D=slipdate&file-format=csv" -o "$DATA_DIR/dept_purchase.csv"
echo "Downloaded: dept_purchase"

curl -s -b "$COOKIE_JAR" "$FLAM_URL/orders/report/view/analysis/export?rt=1&sd=$START&ed=$END&fi=&file-format=csv" -o "$DATA_DIR/orders.csv"
echo "Downloaded: orders"

curl -s -b "$COOKIE_JAR" "$FLAM_URL/stockrecents/export/download?file-format=csv" -o "$DATA_DIR/stockrecents.csv"
echo "Downloaded: stockrecents"

echo "=== Step 3: Convert encoding ==="
for f in "$DATA_DIR"/*.csv; do
  # Debug: show file size and first bytes
  echo "  $(basename $f): $(wc -c < "$f") bytes, type: $(file -b "$f" | head -c 50)"
  # Force convert from Shift-JIS to UTF-8 (FLAM always returns Shift-JIS)
  iconv -f SHIFT_JIS -t UTF-8 "$f" > "$f.tmp" 2>/dev/null && mv "$f.tmp" "$f" && echo "  Converted: $(basename $f)" || echo "  Already UTF-8 or failed: $(basename $f)"
  # Remove BOM if present
  sed -i '1s/^\xEF\xBB\xBF//' "$f" 2>/dev/null || true
done

echo "=== Step 4: Build HTML ==="
TEMPLATE="$SCRIPT_DIR/template.html"
OUTPUT="$SCRIPT_DIR/public/index.html"

# Build CSV_DATA to a temp file (avoids bash variable size limits)
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

# Combine: template before placeholder + CSV_DATA + template after placeholder
sed -n '1,/\/\/ CSV_DATA_PLACEHOLDER/p' "$TEMPLATE" | head -n -1 > "$OUTPUT"
cat "$TMPDATA" >> "$OUTPUT"
sed -n '/\/\/ END_CSV_DATA_PLACEHOLDER/,$p' "$TEMPLATE" | tail -n +2 >> "$OUTPUT"

echo "=== Build complete ==="
echo "Output: $OUTPUT ($(wc -l < "$OUTPUT") lines)"
