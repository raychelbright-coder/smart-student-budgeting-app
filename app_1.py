# Main Flask backedn for the Smart Student Budgeting App
# This file handles: 
# 1. OCR receipt scanning
# 2. saving reecipts to SQLite
# 3. extracting item-level products with OpenAI
# 4. generating personalised budgeting advice
# 5. returning chart data to teh React frontend
import os
import json
import tempfile
import re
import sqlite3

from openai import OpenAI
from datetime import datetime
from flask import Response
from flask import Flask, jsonify, request
from flask_cors import CORS

from PIL import Image
import pytesseract
from dateutil import parser as dateparser

pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".pdf"}
MAX_MB = 10

app = Flask(__name__)
CORS(app)
client = OpenAI()
app.config["MAX_CONTENT_LENGTH"] = MAX_MB * 1024 * 1024


# ─────────────────────────────────────────────
#  DATABASE
# ─────────────────────────────────────────────
# SQLite database file used by the app
# receipts table = stores overall receipt info
# items table = stores individual products/services extracted from each receipt
DB_PATH = os.path.join(os.path.dirname(__file__), "budget.db")

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn
# Create database tables when the server starts
# receipts = one row per receipt
# items = one row per extracted product on a receipt
def init_db():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS receipts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            merchant    TEXT    NOT NULL,
            date        TEXT,
            total       REAL    NOT NULL,
            raw_text    TEXT,
            created_at  TEXT    NOT NULL
        )
    """)
    # NEW items table — one row per product extracted from a receipt
    cur.execute("""
        CREATE TABLE IF NOT EXISTS items (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            receipt_id  INTEGER NOT NULL,
            name        TEXT    NOT NULL,
            cost        REAL,
            date        TEXT,
            created_at  TEXT    NOT NULL,
            FOREIGN KEY (receipt_id) REFERENCES receipts(id) ON DELETE CASCADE
        )
    """)
    conn.commit()
    conn.close()

init_db()


# ─────────────────────────────────────────────
#  OCR HELPERS
# ─────────────────────────────────────────────
# Small helper to get the file extension from uploaded files
def _get_ext(filename):
    _, ext = os.path.splitext(filename.lower())
    return ext

MONEY_RE = re.compile(r"(?:£\s*)?(\d{1,4}(?:[.,]\d{2}))")
# Try to find the total amount from OCR text
# First looks around lines that contain the word "total"
# If that fails, it falls back to the largest money value in the recipt
def guess_total(text):
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    # Try common total-related keywords in order of priority
    TOTAL_KEYWORDS = [
        "total", "amount due", "amount paid", "to pay", "balance due",
        "balance", "payment", "grand total", "net total", "you paid",
        "card payment", "cash", "visa", "mastercard", "contactless"
    ]
    for keyword in TOTAL_KEYWORDS:
        for i, ln in enumerate(lines):
            if keyword in ln.lower():
                chunk = " ".join(lines[i:i+3])
                amounts = [float(m.group(1).replace(",", ".")) for m in MONEY_RE.finditer(chunk)]
                if amounts:
                    return max(amounts)
    # Fallback: return the largest amount found anywhere on the receipt
    amounts = [float(m.group(1).replace(",", ".")) for m in MONEY_RE.finditer(text)]
    return max(amounts) if amounts else None
# Try to detect a date from the OCR text
# dayfirst = True is used because UK recipts usually use day/month/year
def guess_date(text):
    patterns = [
        r"\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b",        # ISO: 2026-03-05
        r"\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b",         # DD/MM/YYYY or MM/DD/YYYY
        r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2}\b",          # DD/MM/YY
        r"\b\d{1,2}\s+\w{3,9}\s+\d{2,4}\b",          # 5 March 2026 or 05 Mar 26
        r"\b\w{3,9}\s+\d{1,2},?\s+\d{4}\b",          # March 5, 2026
    ]
    for pat in patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            try:
                dt = dateparser.parse(m.group(0), settings={"PREFER_DAY_OF_MONTH": "first", "DATE_ORDER": "DMY"})
                if dt:
                    return dt.date().isoformat()
            except Exception:
                pass
    return ""
# Try to detect the shop/merchant name from the top of the recipt
# First checks known brands, otheriwse uses the first clean line of text
def guess_merchant(text):
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    top = " ".join(lines[:15]).upper()
    for brand in ["TESCO", "ASDA", "SAINSBURY", "LIDL", "ALDI", "MORRISONS", "WAITROSE",
                  "COSTA", "STARBUCKS", "MCDONALDS", "GREGGS", "BOOTS", "SUPERDRUG"]:
        if brand in top:
            return brand.title()
    for ln in lines[:10]:
        if len(ln) >= 3 and not any(x in ln.lower() for x in ["www", "http", "tel", "vat"]):
            return ln[:60]
    return ""


# ─────────────────────────────────────────────
#  GPT STEP 1: Extract items from OCR text
# ─────────────────────────────────────────────
# GPT STEP1: 
# This takes the raw OCR text and asks OpenAI to turn it into a clean list of products/services with prices, for example: [{"name": "Whole Milk", "cost": 1.29}, {"name":"Eggs", "cost": 2.10}]
# This is important because the advice should be based on what the student is actually buying
def extract_items_with_gpt(raw_text, merchant, date):
    """
    First GPT call: parse OCR text into a structured list of {name, cost}.
    Returns list of dicts, e.g. [{"name": "Whole Milk 2L", "cost": 1.29}, ...]
    """
    if not raw_text or not raw_text.strip():
        return []
    if not os.getenv("OPENAI_API_KEY"):
        return []
# We ask for JSON only so it can be stored safely in teh database
    prompt = (
        "You are a receipt parser. Extract every individual product or service line from the receipt text below.\n"
        "Return ONLY a valid JSON array with no extra text. Each element must have:\n"
        "  \"name\": short product name (string, max 6 words)\n"
        "  \"cost\": price as a float, or null if not found\n\n"
        "Do NOT include: totals, subtotals, VAT lines, discounts, loyalty points, or store info.\n"
        "If a quantity is shown (e.g. '2x'), list it as one entry with the combined cost.\n"
        "Return [] if no individual items can be identified.\n\n"
        f"Merchant: {merchant}\nDate: {date}\n\n"
        f"Receipt text:\n{raw_text[:1500]}"
    )

    try:
        resp = client.responses.create(model="gpt-4o-mini", input=prompt, timeout=20)
        text = (resp.output_text or "").strip()
        text = re.sub(r"^```(?:json)?\s*", "", text) #sometimes GPT wraps JSON in ```json...```
        text = re.sub(r"\s*```$", "", text) # so remove code fences before trying json.loads
        parsed = json.loads(text)
        if isinstance(parsed, list):
            clean = []
            for item in parsed:
                if isinstance(item, dict) and item.get("name"):
                    clean.append({
                        "name": str(item["name"])[:100],
                        "cost": float(item["cost"]) if item.get("cost") is not None else None
                    })
            return clean
    except Exception:
        pass
    return []


# ─────────────────────────────────────────────
#  GPT STEP 2: Personalised advice from item subtotals
# ─────────────────────────────────────────────
# This uses the monthly subtotal per item + budget + lifestyle goal
# to generate more spcific advcie, for example what to cut down on
# what to swap for a cheaper option and what to priortise
def get_personalised_advice(item_subtotals, budget, goal, receipt_rows):
    """
    Second GPT call: given monthly item subtotals, generate specific advice.
    item_subtotals: [{"name": "...", "monthly_total": 5.16, "purchase_count": 3}, ...]
    """
    if not os.getenv("OPENAI_API_KEY"):
        return None
# If item-level data exists, use that for advice
# Otherwise fall back to receipt-level summaries
    if item_subtotals:
        items_text = "\n".join(
            f"  - {i['name']}: £{i['monthly_total']:.2f} this month (bought {i['purchase_count']}x)"
            for i in item_subtotals[:20]
        )
    else:
        # Fall back to receipt-level summaries if no items parsed yet
        items_text = "\n".join(
            f"  - {r['merchant']}: £{r['total']} on {r.get('date', 'unknown date')}"
            for r in receipt_rows[:10]
        )

    prompt = (
        "You are a friendly, non-judgmental budgeting coach for a UK university student.\n\n"
        f"Weekly budget: £{budget if budget else 'not set'}\n"
        f"Lifestyle goal: {goal if goal else 'not specified'}\n\n"
        "Below is the student's spending broken down by product/service for this month:\n"
        f"{items_text}\n\n"
        "Give exactly 4-5 short, specific, actionable tips. You MUST:\n"
        "- Cover ALL categories of spending shown (food, clothing, transport, toiletries, entertainment etc.) — do NOT focus only on food\n"
        "- Name specific products they could cut down on or swap for cheaper alternatives\n"
        "- Highlight the biggest spending items by name\n"
        "- Suggest at least one concrete swap (e.g. 'swap X for own-brand Y to save roughly £Z')\n"
        "- If clothing, transport or non-food items appear, give advice on those too\n"
        "- Be encouraging and non-judgmental\n"
        "- Format as a numbered list, one tip per line, no extra text before or after\n"
        "- Do NOT give generic advice — reference their actual products and categories"
    )

    try:
        resp = client.responses.create(model="gpt-4o-mini", input=prompt, timeout=20)
        text = (resp.output_text or "").strip()
        lines = [ln.strip("•-0123456789. \t") for ln in text.splitlines() if ln.strip()]
        lines = [ln for ln in lines if len(ln) > 15]
        return lines[:5] if lines else None
    except Exception:
        return None


# ─────────────────────────────────────────────
#  FALLBACK (no OpenAI key)
# ─────────────────────────────────────────────
# Backup advcie if OpenAI is not available
# This keeps the app working even without an API key
# but the advice will be more general than the GPT version
def fallback_advice(rows, budget=None, goal=None):
    if not rows:
        return ["No receipts yet. Add a receipt first, then I can give tips."]
    totals = [float(r["total"]) for r in rows if r.get("total") is not None]
    if not totals:
        return ["Save one receipt with a total first."]
    avg = sum(totals) / len(totals)
    biggest = max(totals)
    merch_counts = {}
    for r in rows:
        m = (r.get("merchant") or "").strip()
        if m:
            merch_counts[m] = merch_counts.get(m, 0) + 1
    top_merchant = max(merch_counts, key=merch_counts.get) if merch_counts else None
    tips = [
        f"Your average receipt is about £{avg:.2f}. A weekly spending target can help keep this steady.",
        f"Your largest receipt was £{biggest:.2f}. If that was a one-off, try to balance it with lighter days.",
    ]
    if top_merchant:
        tips.append(f"You visit {top_merchant} most often. Try planning your shop in advance to avoid impulse buys.")
    if budget:
        try:
            b = float(budget)
            total_spent = sum(totals)
            if total_spent > b:
                tips.append(f"You've spent £{total_spent:.2f} against your £{b:.2f} budget. Try cutting one non-essential.")
            else:
                tips.append(f"You've spent £{total_spent:.2f} of your £{b:.2f} budget — you're on track!")
        except:
            pass
    tips.append("Pick one small saving goal for next week and check back to see if you hit it.")
    return tips[:5]


# ─────────────────────────────────────────────
#  ROUTES
# ─────────────────────────────────────────────

@app.get("/")
def home():
    return "Backend is running!"

@app.get("/api/health")
def health():
    return jsonify(status="ok")

# Route: scan uploaded receipt image with OCR
# Returns: raw OCR text, guessed merchant, guessed date, guessed total
#
# The image is deleted immediately after processing for privacy
@app.post("/api/ocr")
def ocr():
    if "file" not in request.files:
        return jsonify(error="No file field found. Use form-data key: file"), 400
    f = request.files["file"]
    if not f or not f.filename:
        return jsonify(error="No file selected"), 400
    ext = _get_ext(f.filename)
    if ext not in ALLOWED_EXTENSIONS:
        return jsonify(error=f"Unsupported file type {ext}. Use JPG/PNG."), 400

    tmp_path = None
    try:
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
        tmp_path = tmp.name
        tmp.close()
        f.save(tmp_path)

        if ext == ".pdf":
            return jsonify(error="PDF OCR not enabled yet. Please upload JPG/PNG."), 400

        img = Image.open(tmp_path).convert("L")
        w, h = img.size
        img = img.resize((w * 2, h * 2))
        img = img.point(lambda p: 255 if p > 160 else 0)
        raw_text = pytesseract.image_to_string(img, lang="eng", config=r"--oem 3 --psm 6")

        return jsonify(
            message="OCR complete. File deleted after processing.",
            raw_text=raw_text,
            merchant_guess=guess_merchant(raw_text),
            date_guess=guess_date(raw_text),
            total_guess=guess_total(raw_text),
        )
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass

# Route: save a reviewed receipt into the database
# Date is mandatory because spending analysis depends on correct time grouping
#
# After saving the receipt, GPT Step 1 is called to extract item-level products and those are stored in the items table
@app.post("/api/receipts")
def save_receipt():
    data = request.get_json(silent=True) or request.form.to_dict()

    merchant = (data.get("merchant") or "").strip()
    date_str = (data.get("date") or "").strip()
    total    = data.get("total")
    raw_text = data.get("raw_text", "")

    if not merchant:
        return jsonify(error="merchant is required"), 400
    if not date_str:
        return jsonify(error="date is required for spending analysis"), 400
    try:
        total = float(total)
    except Exception:
        return jsonify(error="total must be a number"), 400

    created_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"

    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO receipts (merchant, date, total, raw_text, created_at) VALUES (?, ?, ?, ?, ?)",
        (merchant, date_str, total, raw_text, created_at),
    )
    receipt_id = cur.lastrowid
    conn.commit()

    # GPT Step 1: extract and store items
    # Save each extracted item into the items table so we can later calculate monthly subtotals per product for personalised advice
    items = extract_items_with_gpt(raw_text, merchant, date_str)
    for item in items:
        cur.execute(
            "INSERT INTO items (receipt_id, name, cost, date, created_at) VALUES (?, ?, ?, ?, ?)",
            (receipt_id, item["name"], item.get("cost"), date_str, created_at)
        )
    conn.commit()
    conn.close()

    return jsonify(message="Saved", id=receipt_id, items_extracted=len(items))

# Route: return saved receipt history to the frontend
# Used by the History table and weekly spending tracker
@app.get("/api/receipts")
def list_receipts():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id, merchant, date, total, created_at FROM receipts ORDER BY id DESC")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return jsonify(rows)

# Route: delete a receipt from the database
# This allows the user to remove mistakes or old entries
@app.delete("/api/receipts/<int:receipt_id>")
def delete_receipt(receipt_id: int):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("DELETE FROM receipts WHERE id = ?", (receipt_id,))
    conn.commit()
    deleted = cur.rowcount
    conn.close()
    if deleted == 0:
        return jsonify(error="Not found"), 404
    return jsonify(message="Deleted", id=receipt_id)

# Route: return extracted item-level rows
# Useful for checking what products/services were identified from receipts
@app.get("/api/items")
def list_items():
    """Return all stored items with optional ?days= filter."""
    try:
        days = int(request.args.get("days", "30"))
    except Exception:
        days = 30
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT i.id, i.name, i.cost, i.date, r.merchant, i.receipt_id
        FROM items i
        JOIN receipts r ON r.id = i.receipt_id
        WHERE i.date >= date('now', ?)
        ORDER BY i.date DESC
    """, (f"-{days} days",))
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return jsonify(rows)

# Route: return subtotal spending per item over the last X days
# Example:
# Eggs -> £6.40 this month
# Coffee -> £12.30 this month
#
# This is the main data used for personalised product-level advice
@app.get("/api/items/subtotals")
def item_subtotals():
    """Monthly subtotal per item name — used by frontend breakdown panel."""
    try:
        days = int(request.args.get("days", "30"))
    except Exception:
        days = 30
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT
            name,
            ROUND(SUM(cost), 2)  AS monthly_total,
            COUNT(*)             AS purchase_count
        FROM items
        WHERE cost IS NOT NULL
          AND date >= date('now', ?)
        GROUP BY name
        ORDER BY monthly_total DESC
        LIMIT 30
    """, (f"-{days} days",))
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return jsonify(rows)

# Route: generate budgeting advice
#
# Flow:
# 1. get recent receipts
# 2. get item subtotals from the items table
# 3. if OpenAI is available, generate product-aware advice
# 4. otherwise return fallback advice
@app.get("/api/advice")
def advice():
    budget = (request.args.get("budget") or "").strip()
    goal   = (request.args.get("goal") or "").strip()

    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT merchant, date, total, raw_text, created_at
        FROM receipts ORDER BY id DESC LIMIT 10
    """)
    receipt_rows = [dict(r) for r in cur.fetchall()]

    # Get monthly item subtotals for GPT Step 2
    cur.execute("""
        SELECT name, ROUND(SUM(cost),2) AS monthly_total, COUNT(*) AS purchase_count
        FROM items
        WHERE cost IS NOT NULL AND date >= date('now', '-30 days')
        GROUP BY name
        ORDER BY monthly_total DESC
        LIMIT 20
    """)
    subtotals = [dict(r) for r in cur.fetchall()]
    conn.close()

    if not receipt_rows:
        return jsonify(advice=["No receipts yet. Add a receipt first."], source="fallback")
    # Always prepare fallback advice first, so the app still works if GPT fails
    fb = fallback_advice(receipt_rows, budget=budget, goal=goal)

    if not os.getenv("OPENAI_API_KEY"):
        return jsonify(advice=fb, source="fallback", note="No API key set")
    # Main personalised advice call using item-level data
    tips = get_personalised_advice(subtotals, budget, goal, receipt_rows)
    if tips:
        return jsonify(advice=tips, source="openai", item_count=len(subtotals))

    return jsonify(advice=fb, source="fallback", note="Empty AI output")

# Route: export receipt history as JSON
# Useful if the data needs to be reused elsewhere
@app.get("/api/export.json")
def export_json():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id, merchant, date, total, created_at FROM receipts ORDER BY id DESC")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return jsonify(rows)

# Route: export receipt history as CSV
# Useful for spreadsheet analysis outside the app
@app.get("/api/export.csv")
def export_csv():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id, merchant, date, total, created_at FROM receipts ORDER BY id DESC")
    rows = cur.fetchall()
    conn.close()
    lines = ["id,merchant,date,total,created_at"]
    for r in rows:
        merchant = (r["merchant"] or "").replace('"', '""')
        lines.append(f'{r["id"]},"{merchant}",{r["date"] or ""},{r["total"]},{r["created_at"]}')
    return Response("\n".join(lines), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=receipts.csv"})

# Route: return summary data for charts
# - daily_totals = spending over time
# - merchant_totals = top shops by total spend
@app.get("/api/summary")
def summary():
    try:
        days = int(request.args.get("days", "30"))
    except Exception:
        days = 30
    days = max(1, min(days, 365))

    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT COALESCE(date, substr(created_at,1,10)) AS day,
               ROUND(SUM(total),2) AS total
        FROM receipts
        WHERE datetime(created_at) >= datetime('now', ?)
        GROUP BY day ORDER BY day ASC
    """, (f"-{days} days",))
    daily_totals = [{"day": r["day"], "total": float(r["total"] or 0)} for r in cur.fetchall()]

    cur.execute("""
        SELECT merchant, ROUND(SUM(total),2) AS total
        FROM receipts
        WHERE datetime(created_at) >= datetime('now', ?)
        GROUP BY merchant ORDER BY total DESC LIMIT 10
    """, (f"-{days} days",))
    merchant_totals = [{"merchant": r["merchant"], "total": float(r["total"] or 0)} for r in cur.fetchall()]

    conn.close()
    return jsonify(days=days, daily_totals=daily_totals, merchant_totals=merchant_totals)


@app.errorhandler(413)
def too_large(_e):
    return jsonify(error=f"File too large. Max {MAX_MB}MB."), 413


if __name__ == "__main__":
    # Run Flask development server
    # host=0.0.0.0 makes it reachable on the local network if needed
    app.run(host="0.0.0.0", port=5000, debug=True) 
