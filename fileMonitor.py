import os
import time
import json
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
import pandas as pd

CSV_PATH = "monitor.csv"
STATE_PATH = "monitor_state.json"
POLL_SECONDS = 5


# ----------------- time helpers ----------------- #

def to_unix(ts_str):
    return time.mktime(datetime.strptime(ts_str, "%Y-%m-%d %H:%M:%S").timetuple())


def file_time_str(epoch):
    return datetime.fromtimestamp(epoch).strftime("%Y-%m-%d %H:%M:%S")


# ----------------- domain-specific stubs ----------------- #
# Replace these with your real logic

def get_monitor_files():
    import glob
    return glob.glob("*.log")  # example file scan


def parse_job_stage(file_path):
    """
    Extract job and stage fields for the record.
    This replaces the old 'name'.
    Modify this according to your real naming convention.
    """
    base = os.path.basename(file_path)       # e.g. job42.stage3.log
    parts = base.split(".")
    job = parts[0]                           # "job42"
    stage = parts[1] if len(parts) > 1 else "stage0"
    return job, stage


def db_exists(job, stage):
    """Return True if (job, stage) exists in DB."""
    return True  # replace with real DB lookup


def get_data_record(file_path):
    """
    Fast data collection, no file path stored.
    """
    st = os.stat(file_path)
    job, stage = parse_job_stage(file_path)
    return {
        "job": job,
        "stage": stage,
        "created": file_time_str(st.st_ctime),
        "modified": file_time_str(st.st_mtime),
        "size": st.st_size,
        "user": st.st_uid,
    }


def data_extraction(file_path):
    """Slow non-blocking extraction."""
    time.sleep(10)  # simulate long job


# ----------------- state + csv helpers ----------------- #

def load_state():
    try:
        with open(STATE_PATH, "r") as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state):
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_PATH)


def make_key(job, stage):
    return f"{job}::{stage}"  # unique stable identifier


def write_sorted_csv(df):
    if df.empty:
        return
    tmp = CSV_PATH + ".tmp"
    df.sort_values(["job", "stage", "modified"], ascending=[True, True, True]).to_csv(tmp, index=False)
    os.replace(tmp, CSV_PATH)


# ----------------- status + rerun logic ----------------- #

def get_status_and_update_info(job, stage, rec, info, now_unix, is_extracting):
    modified_unix = to_unix(rec["modified"])
    size = rec["size"]

    last_seen_mtime = info.get("last_seen_mtime")
    last_seen_size = info.get("last_seen_size")
    last_change_time = info.get("last_change_time")
    last_extracted_mtime = info.get("last_extracted_mtime")
    last_status = info.get("last_status")
    rerun = info.get("rerun", 0)

    # detect change
    if last_seen_mtime is None or modified_unix != last_seen_mtime or size != last_seen_size:
        last_change_time = now_unix

    exists = db_exists(job, stage)

    if is_extracting:
        status = "extracting"
    else:
        if exists:
            never_extracted = last_extracted_mtime is None
            changed = last_extracted_mtime is not None and modified_unix > last_extracted_mtime

            if never_extracted:
                status = "await extraction"
            elif changed:
                if last_status == "complete":
                    rerun += 1
                status = "await extraction"
            else:
                status = "complete"
        else:
            age = now_unix - (last_change_time if last_change_time is not None else now_unix)
            status = "file running" if age <= 900 else "file failed"  # 15 min

    info["last_seen_mtime"] = modified_unix
    info["last_seen_size"] = size
    info["last_change_time"] = last_change_time
    info["rerun"] = rerun

    return status, info


# ----------------- monitor ----------------- #

def monitor_forever():
    state = load_state()       # key => info dict
    df = pd.DataFrame()        # CSV snapshot
    future_to_key = {}         # extraction futures

    with ThreadPoolExecutor(max_workers=4) as pool:
        while True:
            now_unix = time.time()
            files = get_monitor_files()

            dirty = False
            new_keys = 0
            seen_keys = set()

            # pass 1: fast data collection
            for file_path in files:
                rec = get_data_record(file_path)
                job = rec["job"]
                stage = rec["stage"]
                key = make_key(job, stage)
                seen_keys.add(key)

                info = state.get(key, {})
                if key not in state:
                    new_keys += 1

                # is extracting?
                is_extracting = any(k == key and not fut.done() for fut, k in future_to_key.items())

                prev_status = info.get("last_status")
                prev_mtime = info.get("last_seen_mtime")
                prev_rerun = info.get("rerun", 0)

                status, info = get_status_and_update_info(job, stage, rec, info, now_unix, is_extracting)

                # start extraction if needed
                if status == "await extraction" and not is_extracting:
                    fut = pool.submit(data_extraction, file_path)
                    future_to_key[fut] = key
                    status = "extracting"

                info["last_status"] = status
                state[key] = info

                rec["status"] = status
                rec["rerun"] = info["rerun"]

                # detect changes that require CSV write
                changed = (
                    prev_mtime is None or
                    to_unix(rec["modified"]) != prev_mtime or
                    prev_status != status or
                    prev_rerun != info["rerun"]
                )

                if changed:
                    dirty = True

                # upsert into df by (job, stage)
                if df.empty:
                    df = pd.DataFrame([rec])
                else:
                    mask = (df["job"] == job) & (df["stage"] == stage)
                    if mask.any():
                        for k, v in rec.items():
                            df.loc[mask, k] = v
                    else:
                        df = pd.concat([df, pd.DataFrame([rec])], ignore_index=True)

            # pass 2: completed extraction
            finished = [fut for fut in list(future_to_key.keys()) if fut.done()]
            for fut in finished:
                key = future_to_key.pop(fut)
                info = state[key]
                try:
                    fut.result()
                    info["last_status"] = "complete"
                    info["last_extracted_mtime"] = info["last_seen_mtime"]
                    new_status = "complete"
                except Exception:
                    info["last_status"] = "file failed"
                    new_status = "file failed"

                state[key] = info

                mask = (
                    (df["job"] == key.split("::")[0]) &
                    (df["stage"] == key.split("::")[1])
                )
                df.loc[mask, "status"] = new_status
                dirty = True

            if dirty and not df.empty:
                write_sorted_csv(df)

            print(
                f"jobs_stages_monitored={len(seen_keys)} "
                f"new={new_keys} "
                f"extractions_running={len(future_to_key)}"
            )

            save_state(state)
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    monitor_forever()
