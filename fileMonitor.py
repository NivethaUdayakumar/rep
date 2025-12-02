import os
import time
import json
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
import pandas as pd

CSV_PATH = "monitor.csv"
STATE_PATH = "monitor_state.json"
POLL_SECONDS = 5  # how often to rescan (seconds)


# ---------------- time helpers ---------------- #

def to_unix(date_str, time_str):
    """Convert 'YYYY-MM-DD' + 'HH:MM:SS' into a unix timestamp (float seconds)."""
    ts = f"{date_str} {time_str}"
    return time.mktime(datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").timetuple())


def split_ts(epoch):
    """Split epoch into (date_str, time_str)."""
    dt = datetime.fromtimestamp(epoch)
    return dt.strftime("%Y-%m-%d"), dt.strftime("%H:%M:%S")


# ---------------- domain specific stubs ---------------- #
# Replace these with your real logic

def get_monitor_files():
    """
    Return list of file paths to monitor.
    You can replace this with your own discovery logic.
    """
    import glob
    return glob.glob("*.log")  # example: all .log files in current dir


def parse_job_stage(file_path):
    """
    Extract (job, stage) for this file.

    You must implement the rule that maps file_path to job and stage.
    Current example:
      file 'job42.stage3.log' -> job='job42', stage='stage3'
    """
    base = os.path.basename(file_path)
    parts = base.split(".")
    job = parts[0] if len(parts) > 0 else "job_unknown"
    stage = parts[1] if len(parts) > 1 else "stage0"
    return job, stage


def db_exists(job, stage):
    """
    Return True if this (job, stage) already has a DB record.
    Replace this with your real DB lookup.
    """
    return True


def get_data_record(file_path):
    """
    Very fast data collection.

    Does NOT store file_path in the record.
    Uses job + stage as unique identifiers.
    Splits created and modified into separate date and time fields.
    """
    st = os.stat(file_path)
    job, stage = parse_job_stage(file_path)

    created_date, created_time = split_ts(st.st_ctime)
    modified_date, modified_time = split_ts(st.st_mtime)

    return {
        "job": job,
        "stage": stage,
        "created_date": created_date,
        "created_time": created_time,
        "modified_date": modified_date,
        "modified_time": modified_time,
        "size": st.st_size,
        "user": st.st_uid,
    }


def data_extraction(file_path):
    """
    Very slow extraction.

    Runs in background via ThreadPoolExecutor.
    Replace this with your real extraction logic.
    """
    time.sleep(10)  # simulate slow work


# ---------------- state and CSV helpers ---------------- #

def make_key(job, stage):
    """Build a stable key for state JSON and future maps."""
    return f"{job}::{stage}"


def load_state():
    """Load per job_stage state from JSON so monitor can resume."""
    try:
        with open(STATE_PATH, "r") as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state):
    """Save state JSON in pretty format."""
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_PATH)


def write_sorted_csv(df):
    """
    Write CSV sorted by job, stage, modified_date, modified_time.
    """
    if df.empty:
        return
    tmp = CSV_PATH + ".tmp"
    df.sort_values(
        ["job", "stage", "modified_date", "modified_time"],
        ascending=[True, True, True, True],
    ).to_csv(tmp, index=False)
    os.replace(tmp, CSV_PATH)


# ---------------- status and rerun logic ---------------- #

def get_status_and_update_info(job, stage, rec, info, now_unix, is_extracting):
    """
    Compute status for this (job, stage) and update internal info.

    Status rules:
      await extraction:
        db_exists(job, stage) is True and
        (never extracted or file modified after last_extracted_mtime)

      file running:
        db_exists is False and file changed within 15 minutes

      file failed:
        db_exists is False and file did not change for more than 15 minutes

      extracting:
        data_extraction is currently running for this job_stage

      complete:
        last extraction finished successfully and file not changed since
    Rerun logic:
      New (job, stage) -> rerun = 0
      After status complete, if file modified later and needs re extraction,
      rerun increments by 1.
    """

    modified_unix = to_unix(rec["modified_date"], rec["modified_time"])
    size = rec["size"]

    last_seen_mtime = info.get("last_seen_mtime")        # unix
    last_seen_size = info.get("last_seen_size")
    last_change_time = info.get("last_change_time")      # unix
    last_extracted_mtime = info.get("last_extracted_mtime")  # unix or None
    last_status = info.get("last_status")
    rerun = info.get("rerun", 0)

    # Track when file content last changed
    if last_seen_mtime is None or modified_unix != last_seen_mtime or size != last_seen_size:
        last_change_time = now_unix

    exists = db_exists(job, stage)

    if is_extracting:
        status = "extracting"
    else:
        if exists:
            never_extracted = last_extracted_mtime is None
            changed_after_extract = (
                last_extracted_mtime is not None and modified_unix > last_extracted_mtime
            )

            if never_extracted:
                status = "await extraction"
            elif changed_after_extract:
                if last_status == "complete":
                    rerun += 1
                status = "await extraction"
            else:
                status = "complete"
        else:
            age = now_unix - (last_change_time if last_change_time is not None else now_unix)
            status = "file running" if age <= 15 * 60 else "file failed"

    # Update info for next iteration
    info["last_seen_mtime"] = modified_unix
    info["last_seen_size"] = size
    info["last_change_time"] = last_change_time
    info["rerun"] = rerun

    return status, info


# ---------------- main monitor loop ---------------- #

def monitor_forever():
    """
    Continuous monitor:

      1) Scan files: get_monitor_files()
      2) For each file:
           - get_data_record (fast)
           - compute status and rerun from state
           - start extraction non blocking if status is await extraction
           - update in memory DataFrame row
      3) For completed extractions:
           - update status to complete or file failed
           - update last_extracted_mtime
      4) If anything changed, write sorted CSV
      5) Save state JSON
      6) Sleep and repeat
    """

    state = load_state()      # key -> info dict
    df = pd.DataFrame()       # all records for CSV
    future_to_key = {}        # future -> key(job::stage)

    with ThreadPoolExecutor(max_workers=4) as pool:
        while True:
            now_unix = time.time()
            files = get_monitor_files()

            dirty_csv = False
            new_keys = 0
            seen_keys = set()

            # pass 1: fast data collection for all files
            for file_path in files:
                rec = get_data_record(file_path)
                job = rec["job"]
                stage = rec["stage"]
                key = make_key(job, stage)
                seen_keys.add(key)

                info = state.get(key, {})
                if key not in state:
                    new_keys += 1

                # check if extraction already running for this job_stage
                is_extracting = any(
                    k == key and not fut.done()
                    for fut, k in future_to_key.items()
                )

                prev_status = info.get("last_status")
                prev_mtime = info.get("last_seen_mtime")
                prev_rerun = info.get("rerun", 0)

                # decide status and update rerun before extraction
                status, info = get_status_and_update_info(job, stage, rec, info, now_unix, is_extracting)

                # start slow extraction if needed
                if status == "await extraction" and not is_extracting:
                    fut = pool.submit(data_extraction, file_path)
                    future_to_key[fut] = key
                    status = "extracting"

                info["last_status"] = status
                state[key] = info

                rerun = info["rerun"]
                rec["status"] = status
                rec["rerun"] = rerun

                # detect changes that require CSV rewrite
                modified_unix = to_unix(rec["modified_date"], rec["modified_time"])
                new_key_flag = prev_mtime is None
                modified_changed = prev_mtime is not None and modified_unix != prev_mtime
                status_changed = prev_status != status
                rerun_changed = prev_rerun != rerun

                if new_key_flag or modified_changed or status_changed or rerun_changed:
                    dirty_csv = True

                # upsert row into df for this (job, stage)
                if df.empty:
                    df = pd.DataFrame([rec])
                else:
                    mask = (df["job"] == job) & (df["stage"] == stage)
                    if mask.any():
                        for col, val in rec.items():
                            df.loc[mask, col] = val
                    else:
                        df = pd.concat([df, pd.DataFrame([rec])], ignore_index=True)

            # pass 2: handle finished extractions without blocking
            finished = [fut for fut in list(future_to_key.keys()) if fut.done()]
            for fut in finished:
                key = future_to_key.pop(fut)
                info = state.get(key, {})
                try:
                    fut.result()
                    info["last_status"] = "complete"
                    info["last_extracted_mtime"] = info.get("last_seen_mtime")
                    new_status = "complete"
                except Exception:
                    info["last_status"] = "file failed"
                    new_status = "file failed"

                state[key] = info

                # unpack key back to job and stage for df
                job, stage = key.split("::", 1)
                if not df.empty:
                    mask = (df["job"] == job) & (df["stage"] == stage)
                    if mask.any():
                        df.loc[mask, "status"] = new_status
                        dirty_csv = True

            # write CSV once per loop if something changed
            if dirty_csv and not df.empty:
                write_sorted_csv(df)

            # logging and persist state
            print(
                f"job_stage_monitored={len(seen_keys)} "
                f"new={new_keys} "
                f"extractions_running={len(future_to_key)}"
            )

            save_state(state)
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    monitor_forever()
