import os
import json
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import pandas as pd

CSV_PATH = "records.csv"
STATE_JSON_PATH = "rerun_state.json"

# -----------------------------
# Helpers for state and CSV
# -----------------------------

def load_state(path: str) -> dict:
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(state: dict, path: str) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, path)


def write_df_sorted(df: pd.DataFrame, csv_path: str) -> None:
    if df.empty:
        return

    # df has index = file path. For CSV we want file as a column.
    out = df.reset_index().rename(columns={"index": "file"})

    # Sort ascending by modified time then file
    out = out.sort_values(["mtime_now", "file"], ascending=[True, True])

    tmp = csv_path + ".tmp"
    out.to_csv(tmp, index=False)
    os.replace(tmp, csv_path)


# -----------------------------
# Your domain-specific functions
# -----------------------------

def collect_fast(file_path: str) -> dict:
    """Fast data collection, runs on every loop for every file."""
    return {
        "size_now": os.path.getsize(file_path),
        "mtime_now": os.path.getmtime(file_path),
    }


def extract_slow(file_path: str) -> dict:
    """Slow data extraction. This runs in background threads."""
    # TODO: replace with your real slow extraction
    time.sleep(3)  # simulate slow work
    return {
        "extract_metric": 42,        # example extracted field
        "raw_result": "ok",          # example internal result
    }


def get_status(extract_result: dict) -> str:
    """Compute final status based on extraction result."""
    # TODO: replace with your real status logic
    raw = extract_result.get("raw_result", "ok")
    if raw == "ok":
        return "complete"
    return "failed"


def get_file_list() -> list[str]:
    """Return the list of files to monitor."""
    # TODO: adjust this to your real source of files
    return [str(p) for p in Path(".").glob("*.log")]  # example


# -----------------------------
# Continuous monitor
# -----------------------------

def monitor_forever(poll_interval: float = 2.0, max_workers: int = 4):
    """
    Continuous monitor loop:
    - fast collection every cycle for all files
    - slow extraction only for new/changed files
    - non-blocking: monitor does not wait for extraction
    - CSV and JSON updated when anything changes
    """

    # State per file persisted across runs
    # { file: { last_status, last_extracted_mtime, rerun_count, ... } }
    state = load_state(STATE_JSON_PATH)

    # DataFrame with index = file path
    # Columns: status, rerun_count, mtime_now, size_now, extract_metric, ...
    df = pd.DataFrame(
        columns=["status", "rerun_count", "mtime_now", "size_now", "extract_metric"]
    )
    df.index.name = "file"

    # Track ongoing extractions: future -> file_path
    future_to_file = {}

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        try:
            while True:
                dirty_csv = False       # did anything change in df that requires a CSV write
                dirty_state = False     # did state JSON change

                files = get_file_list()

                # First pass: fast data collection for all files
                for file_path in files:
                    file_path = str(file_path)
                    fast = collect_fast(file_path)
                    mtime_now = fast["mtime_now"]
                    size_now = fast["size_now"]

                    prev = state.get(file_path, {})
                    prev_status = prev.get("last_status")
                    last_extracted_mtime = prev.get("last_extracted_mtime", 0.0)
                    rerun_count = prev.get("rerun_count", 0)

                    # Decide if we need to trigger slow extraction
                    in_progress = any(file_path == f for f in future_to_file.values())
                    need_extract = False

                    if not prev:
                        # New file
                        need_extract = True
                    elif mtime_now > last_extracted_mtime:
                        # File changed since last extraction
                        need_extract = True

                    status = prev_status or "unknown"

                    if need_extract and not in_progress:
                        # If it was previously complete and we re-extract, bump rerun count
                        if prev_status == "complete":
                            rerun_count += 1
                        status = "extracting"
                        future = pool.submit(extract_slow, file_path)
                        future_to_file[future] = file_path
                        dirty_state = True  # rerun_count changed

                    # Update DataFrame row
                    if file_path in df.index:
                        row = df.loc[file_path]
                        if (
                            row["mtime_now"] != mtime_now
                            or row["size_now"] != size_now
                            or row["status"] != status
                            or row["rerun_count"] != rerun_count
                        ):
                            dirty_csv = True
                        df.loc[file_path, "mtime_now"] = mtime_now
                        df.loc[file_path, "size_now"] = size_now
                        df.loc[file_path, "status"] = status
                        df.loc[file_path, "rerun_count"] = rerun_count
                    else:
                        df.loc[file_path] = {
                            "status": status,
                            "rerun_count": rerun_count,
                            "mtime_now": mtime_now,
                            "size_now": size_now,
                            "extract_metric": prev.get("extract_metric"),
                        }
                        dirty_csv = True

                # Second pass: check which slow extractions have finished (non-blocking)
                finished_futures = [
                    fut for fut in list(future_to_file.keys()) if fut.done()
                ]

                for fut in finished_futures:
                    file_path = future_to_file.pop(fut)
                    try:
                        extract_result = fut.result()
                        # Update extraction-related fields in df
                        for k, v in extract_result.items():
                            if k not in df.columns:
                                df[k] = None
                            df.loc[file_path, k] = v

                        final_status = get_status(extract_result)
                        df.loc[file_path, "status"] = final_status
                    except Exception as e:
                        final_status = f"error: {e}"
                        df.loc[file_path, "status"] = final_status

                    # Update state for this file
                    mtime_now = float(df.loc[file_path, "mtime_now"])
                    rerun_count = int(df.loc[file_path, "rerun_count"])
                    extract_metric = df.loc[file_path, "extract_metric"]

                    state[file_path] = {
                        "last_status": final_status,
                        "last_extracted_mtime": mtime_now,
                        "rerun_count": rerun_count,
                        "extract_metric": extract_metric,
                    }

                    dirty_state = True
                    dirty_csv = True

                    print(
                        f"[extract-done] {file_path} "
                        f"status={final_status} rerun_count={rerun_count}"
                    )

                # Persist changes if any
                if dirty_csv:
                    write_df_sorted(df, CSV_PATH)

                if dirty_state:
                    save_state(state, STATE_JSON_PATH)

                time.sleep(poll_interval)

        except KeyboardInterrupt:
            print("Stopping monitor...")


if __name__ == "__main__":
    monitor_forever(poll_interval=2.0, max_workers=4)
