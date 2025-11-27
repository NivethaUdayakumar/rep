import os
import time
import json
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
import pandas as pd

CSV_PATH = "monitor.csv"
STATE_PATH = "monitor_state.json"
POLL_SECONDS = 5


# ----------------- Time helpers ----------------- #

def ts_now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def to_unix(ts_str):
    return time.mktime(datetime.strptime(ts_str, "%Y-%m-%d %H:%M:%S").timetuple())


def file_time_str(epoch):
    return datetime.fromtimestamp(epoch).strftime("%Y-%m-%d %H:%M:%S")


# ----------------- Domain functions (replace where needed) ----------------- #

def get_monitor_files():
    """Return list of files to monitor."""
    import glob
    return glob.glob("*.log")   # example


def db_exists(file_path):
    """Return True if DB entry exists for this file."""
    # Replace with real DB lookup
    return True


def get_data_record(file_path):
    """
    Fast data collection from filesystem.

    created / modified are stored as '%Y-%m-%d %H:%M:%S' strings.
    """
    st = os.stat(file_path)
    return {
        "file": file_path,
        "created": file_time_str(st.st_ctime),
        "modified": file_time_str(st.st_mtime),
        "size": st.st_size,
        "user": st.st_uid
    }


def data_extraction(file_path):
    """
    Very slow extraction work.

    Runs in background threads (non blocking for the monitor loop).
    """
    # Replace with your real extraction logic
    time.sleep(10)


# ----------------- State + CSV helpers ----------------- #

def load_state():
    """Load per file state from JSON so monitor can resume across runs."""
    try:
        with open(STATE_PATH, "r") as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state):
    """Save state as pretty printed JSON."""
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_PATH)


def write_sorted_csv(df):
    """Write CSV sorted by file and modified (both strings)."""
    if df.empty:
        return
    tmp = CSV_PATH + ".tmp"
    df.sort_values(["file", "modified"], ascending=[True, True]).to_csv(tmp, index=False)
    os.replace(tmp, CSV_PATH)


# ----------------- Status + rerun logic ----------------- #

def get_status_and_update_info(file_path, rec, info, now_unix, is_extracting):
    """
    Compute status and update state info (including rerun).

    States:
      - 'await extraction'
      - 'file running'
      - 'extracting'
      - 'file failed'
      - 'complete'
    """

    modified_unix = to_unix(rec["modified"])
    size = rec["size"]

    last_seen_mtime = info.get("last_seen_mtime")             # unix
    last_seen_size = info.get("last_seen_size")
    last_change_time = info.get("last_change_time")           # unix
    last_extracted_mtime = info.get("last_extracted_mtime")   # unix or None
    last_status = info.get("last_status")
    rerun = info.get("rerun", 0)

    # Track last time file changed (mtime or size)
    if last_seen_mtime is None or modified_unix != last_seen_mtime or size != last_seen_size:
        last_change_time = now_unix

    exists = db_exists(file_path)

    if is_extracting:
        status = "extracting"
    else:
        if exists:
            never_extracted = last_extracted_mtime is None
            changed_after_extract = last_extracted_mtime is not None and modified_unix > last_extracted_mtime

            if never_extracted:
                # first ever extraction, rerun stays at 0
                status = "await extraction"
            elif changed_after_extract:
                # file was extracted before and is now modified
                # increment rerun only when we are moving from complete to a new extraction
                if last_status == "complete":
                    rerun += 1
                status = "await extraction"
            else:
                # already extracted and up to date
                status = "complete"
        else:
            # DB does not exist yet, file might be running or stalled
            age = now_unix - (last_change_time if last_change_time is not None else now_unix)
            if age <= 15 * 60:
                status = "file running"
            else:
                status = "file failed"

    # Update info for next iterations
    info["last_seen_mtime"] = modified_unix
    info["last_seen_size"] = size
    info["last_change_time"] = last_change_time
    info["rerun"] = rerun

    return status, info


# ----------------- Main monitor ----------------- #

def monitor_forever():
    """
    Monitor behaviour (continuous loop):

    - For each iteration:
      1) get_monitor_files()
      2) For each file:
         - call get_data_record()  [fast data collection]
         - compute status using get_status_and_update_info()
         - if status == 'await extraction', start data_extraction() non blocking
         - update record in DataFrame (including rerun)
      3) Handle finished extractions:
         - set status to 'complete' or 'file failed'
         - set last_extracted_mtime when complete
      4) Write CSV once, sorted by file + modified, if anything changed
      5) Save state JSON (pretty printed)
    """

    state = load_state()         # file -> dict with last_seen_mtime, rerun, etc.
    df = pd.DataFrame()          # current snapshot of records
    future_to_file = {}          # background extractions: future -> file

    with ThreadPoolExecutor(max_workers=4) as pool:
        while True:
            now_unix = time.time()
            files = get_monitor_files()
            new_files = 0
            dirty_csv = False

            # -------- pass 1: fast data collection across all files -------- #
            for file_path in files:
                rec = get_data_record(file_path)
                file_key = rec["file"]

                info = state.get(file_key, {})
                if file_key not in state:
                    new_files += 1

                is_extracting = any(
                    f == file_key and not fut.done()
                    for fut, f in future_to_file.items()
                )

                prev_status = info.get("last_status")
                prev_mtime = info.get("last_seen_mtime")
                prev_rerun = info.get("rerun", 0)

                # compute status and possibly update rerun in info
                status, info = get_status_and_update_info(file_key, rec, info, now_unix, is_extracting)

                # start extraction for await extraction
                if status == "await extraction" and not is_extracting:
                    fut = pool.submit(data_extraction, file_key)
                    future_to_file[fut] = file_key
                    status = "extracting"  # reflect that job has started

                info["last_status"] = status
                state[file_key] = info

                rerun = info.get("rerun", 0)
                rec["status"] = status
                rec["rerun"] = rerun

                # detect if this row changed enough to require CSV rewrite
                new_file = prev_mtime is None
                modified_changed = prev_mtime is not None and to_unix(rec["modified"]) != prev_mtime
                status_changed = prev_status != status
                rerun_changed = rerun != prev_rerun

                if new_file or modified_changed or status_changed or rerun_changed:
                    dirty_csv = True

                # upsert record into df
                if df.empty:
                    df = pd.DataFrame([rec])
                else:
                    mask = df["file"] == file_key
                    if mask.any():
                        for k, v in rec.items():
                            df.loc[mask, k] = v
                    else:
                        df = pd.concat([df, pd.DataFrame([rec])], ignore_index=True)

            # -------- pass 2: handle finished extractions (non blocking) -------- #
            finished = [fut for fut in list(future_to_file.keys()) if fut.done()]
            for fut in finished:
                file_key = future_to_file.pop(fut)
                info = state.get(file_key, {})
                try:
                    fut.result()
                    info["last_status"] = "complete"
                    info["last_extracted_mtime"] = info.get("last_seen_mtime")
                    new_status = "complete"
                except Exception:
                    info["last_status"] = "file failed"
                    new_status = "file failed"

                state[file_key] = info

                if not df.empty:
                    mask = df["file"] == file_key
                    if mask.any():
                        df.loc[mask, "status"] = new_status
                        dirty_csv = True

            # -------- write CSV once per loop, sorted -------- #
            if dirty_csv and not df.empty:
                write_sorted_csv(df)

            # -------- stats + persist state -------- #
            print(
                f"monitored={len(files)} "
                f"new_files={new_files} "
                f"extractions_running={len(future_to_file)}"
            )

            save_state(state)
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    monitor_forever()
