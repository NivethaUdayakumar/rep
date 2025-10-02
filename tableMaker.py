from bs4 import BeautifulSoup

def _append_cell_content(soup, td, cell):
    """
    Render a cell:
      - plain str/num -> text
      - dict with {"text", "href", ...} -> <a> link
      - dict with {"html": "<b>...</b>"} -> raw HTML (optional escape hatch)
    """
    if isinstance(cell, dict):
        if "href" in cell:  # link cell
            a = soup.new_tag("a", href=str(cell["href"]))
            a.string = str(cell.get("text", cell["href"]))
            # optional extras: target, rel, class, title
            if "target" in cell: a["target"] = cell["target"]
            if "rel" in cell: a["rel"] = cell["rel"]
            if "title" in cell: a["title"] = cell["title"]
            if "class" in cell: a["class"] = cell["class"]
            td.append(a)
        elif "html" in cell:  # raw HTML (use sparingly)
            td.append(BeautifulSoup(cell["html"], "lxml"))
        else:
            td.string = str(cell.get("text", ""))
    else:
        td.string = str(cell)

def build_table(soup, headers=None, rows=None, attrs=None):
    tbl = soup.new_tag("table", **(attrs or {}))

    if headers:
        thead = soup.new_tag("thead")
        tr = soup.new_tag("tr")
        for h in headers:
            th = soup.new_tag("th")
            th.string = str(h)
            tr.append(th)
        thead.append(tr)
        tbl.append(thead)

    if rows:
        tbody = soup.new_tag("tbody")
        for r in rows:
            tr = soup.new_tag("tr")
            for cell in r:
                td = soup.new_tag("td")
                _append_cell_content(soup, td, cell)
                tr.append(td)
            tbody.append(tr)
        tbl.append(tbody)

    return tbl

def replace_table_by_id(
    input_html_path: str,
    output_html_path: str,
    table_id: str,
    *,
    headers,
    rows,
    keep_original_attrs: bool = True,
    parser: str = "lxml"
):
    with open(input_html_path, "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f.read(), parser)

    old = soup.find("table", id=table_id)
    if old is None:
        raise ValueError(f"No <table id='{table_id}'> found in {input_html_path}")

    attrs = {"id": table_id}
    if keep_original_attrs:
        attrs = dict(old.attrs)
        attrs["id"] = table_id

    new_tbl = build_table(soup, headers=headers or [], rows=rows or [], attrs=attrs)
    old.replace_with(new_tbl)

    with open(output_html_path, "w", encoding="utf-8") as f:
        f.write(str(soup))

if __name__ == "__main__":
    headers = ["Name", "Score", "Report"]
    rows = [
        ["Alpha", 92, {"text": "View", "href": "reports/alpha.html", "target": "_blank"}],
        ["Beta",  78, {"text": "Details", "href": "reports/beta.html"}],
        # cell without link:
        ["Gamma", 61, "No report"],
        # fully custom HTML (optional):
        ["Delta", 88, {"html": '<span style="font-weight:600">Inline HTML</span>'}],
    ]

    replace_table_by_id(
        input_html_path="template.html",
        output_html_path="report_links.html",
        table_id="resultsTable",
        headers=headers,
        rows=rows,
        keep_original_attrs=True,
        parser="lxml",
    )
