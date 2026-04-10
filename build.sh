#!/bin/bash
set -e

# FLAM credentials from environment/secrets
FLAM_URL="https://dnk.flam.bz"
FLAM_ID="${FLAM_ID}"
FLAM_PW="${FLAM_PW}"

COOKIE_JAR="/tmp/flam_cookies.txt"
DATA_DIR="/tmp/flam_data"
mkdir -p "$DATA_DIR"

echo "=== Step 1: Login to FLAM ==="
# Get login page first (for CSRF token if needed)
curl -s -c "$COOKIE_JAR" "$FLAM_URL/login" > /dev/null

# Login
curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  -d "data[User][email]=$FLAM_ID&data[User][password]=$FLAM_PW" \
  -L "$FLAM_URL/login" > /dev/null

echo "Logged in"

echo "=== Step 2: Download CSVs ==="
# Date range
START="2025/05/01"
END="2026/04/30"

# 1. Dept + Month sales (for Overview/Budget)
curl -s -b "$COOKIE_JAR" \
  "$FLAM_URL/sales/totalize/export?startdate=$(echo $START | sed 's/\//%2F/g')&enddate=$(echo $END | sed 's/\//%2F/g')&grouping%5B%5D=section&grouping%5B%5D=slipdate&file-format=csv" \
  -o "$DATA_DIR/dept_sales.csv"
echo "Downloaded: dept_sales"

# 2. Dept + Customer sales (for Customer Mix)
curl -s -b "$COOKIE_JAR" \
  "$FLAM_URL/sales/totalize/export?startdate=$(echo $START | sed 's/\//%2F/g')&enddate=$(echo $END | sed 's/\//%2F/g')&grouping%5B%5D=customer&grouping%5B%5D=section&file-format=csv" \
  -o "$DATA_DIR/dept_customer_sales.csv"
echo "Downloaded: dept_customer_sales"

# 3. Dept + Product + Month sales (for Sales tab)
curl -s -b "$COOKIE_JAR" \
  "$FLAM_URL/sales/totalize/export?startdate=$(echo $START | sed 's/\//%2F/g')&enddate=$(echo $END | sed 's/\//%2F/g')&grouping%5B%5D=section&grouping%5B%5D=product&grouping%5B%5D=slipdate&file-format=csv" \
  -o "$DATA_DIR/dept_product_sales.csv"
echo "Downloaded: dept_product_sales"

# 4. Dept + Supplier + Month purchase (for Purchasing tab)
curl -s -b "$COOKIE_JAR" \
  "$FLAM_URL/purchases/totalize/export?startdate=$(echo $START | sed 's/\//%2F/g')&enddate=$(echo $END | sed 's/\//%2F/g')&grouping%5B%5D=suppliers&grouping%5B%5D=section&grouping%5B%5D=slipdate&file-format=csv" \
  -o "$DATA_DIR/dept_purchase.csv"
echo "Downloaded: dept_purchase"

# 5. Orders
curl -s -b "$COOKIE_JAR" \
  "$FLAM_URL/orders/report/view/analysis/export?rt=1&sd=$(echo $START | sed 's/\//%2F/g')&ed=$(echo $END | sed 's/\//%2F/g')&fi=&file-format=csv" \
  -o "$DATA_DIR/orders.csv"
echo "Downloaded: orders"

# 6. Stock
curl -s -b "$COOKIE_JAR" \
  "$FLAM_URL/stockrecents/export/download?file-format=csv" \
  -o "$DATA_DIR/stockrecents.csv"
echo "Downloaded: stockrecents"

echo "=== Step 3: Convert encoding ==="
for f in "$DATA_DIR"/*.csv; do
  if file "$f" | grep -qi "shift"; then
    iconv -f SHIFT_JIS -t UTF-8 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    echo "Converted: $(basename $f)"
  else
    # Remove BOM if present
    sed -i '1s/^\xEF\xBB\xBF//' "$f" 2>/dev/null || true
    echo "OK: $(basename $f)"
  fi
done

echo "=== Step 4: Build HTML ==="
# Read template and inject data
TEMPLATE="$(dirname $0)/template.html"
OUTPUT="$(dirname $0)/public/index.html"

# Build CSV_DATA section
CSV_DATA="const CSV_DATA = {"

for key in dept_product_sales dept_purchase stockrecents dept_customer_sales dept_sales orders; do
  if [ -f "$DATA_DIR/$key.csv" ]; then
    CSV_DATA="$CSV_DATA
$key: \`
$(cat "$DATA_DIR/$key.csv" | sed 's/`//g')
\`,"
  fi
done

# Add budget (static for now)
CSV_DATA="$CSV_DATA
budget: \`
$(cat "$(dirname $0)/budget.csv")
\`,"

CSV_DATA="$CSV_DATA
};"

# Combine: template head + CSV_DATA + template JS
sed -n '1,/\/\/ CSV_DATA_PLACEHOLDER/p' "$TEMPLATE" | head -n -1 > "$OUTPUT"
echo "$CSV_DATA" >> "$OUTPUT"
sed -n '/\/\/ END_CSV_DATA_PLACEHOLDER/,$p' "$TEMPLATE" | tail -n +2 >> "$OUTPUT"

echo "=== Build complete ==="
echo "Output: $OUTPUT"
