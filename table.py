# extract_first_table.py
# Usage:
#   python extract_first_table.py reports/summary.html out/table_only.html

import sys
import os

def _find_matching_table_block(html: str) -> str | None:
    """
    Return the substring containing the first <table ...> ... </table> block,
    handling nested tables. Case-insensitive search. Returns None if not found.
    """
    # Case-insensitive search helpers
    html_low = html.lower()
    open_tag = "<table"
    close_tag = "</table"

    start = html_low.find(open_tag)
    if start == -1:
        return None

    # Find the '>' that ends the opening <table ...> tag
    open_tag_end = html.find(">", start)
    if open_tag_end == -1:
        return None

    depth = 1
    i = open_tag_end + 1
    n = len(html)

    while i < n:
        # find next opening or closing table tag
        next_open = html_low.find(open_tag, i)
        next_close = html_low.find(close_tag, i)

        # If neither found, break (malformed; no closing tag)
        if next_open == -1 and next_close == -1:
            break

        # Decide which appears first
        if next_close != -1 and (next_open == -1 or next_close < next_open):
            # Move to end of this closing tag
            end_gt = html.find(">", next_close)
            if end_gt == -1:
                break
            depth -= 1
            i = end_gt + 1
            if depth == 0:
                # Include the full closing tag
                return html[start:i]
        else:
            # Found another nested <table ...>
            end_gt = html.find(">", next_open)
            if end_gt == -1:
                break
            depth += 1
            i = end_gt + 1

    return None  # No matching close found

def extract_first_table_html(in_path: str) -> str | None:
    with open(in_path, "r", encoding="utf-8", errors="replace") as f:
        html = f.read()
    return _find_matching_table_block(html)

def save_table_as_html(table_html: str, out_path: str, title: str = "Extracted Table") -> None:
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body {{ font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; padding: 1rem; }}
  table {{ border-collapse: collapse; width: 100%; }}
  th, td {{ border: 1px solid #ccc; padding: 8px; text-align: left; }}
  thead th {{ background: #f5f5f5; }}
</style>
</head>
<body>
{table_html}
</body>
</html>"""
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(doc)

def main():
    if len(sys.argv) != 3:
        print("Usage: python extract_first_table.py <input_html> <output_html>")
        sys.exit(2)

    in_path, out_path = sys.argv[1], sys.argv[2]
    table = extract_first_table_html(in_path)
    if table is None:
        print("No <table> found.")
        sys.exit(1)

    save_table_as_html(table, out_path, title=f"Table from {os.path.basename(in_path)}")
    print(f"Saved first <table> to: {out_path}")

if __name__ == "__main__":
    main()
