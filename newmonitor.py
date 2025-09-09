#!/usr/bin/env python3
import os, time, json
from datetime import datetime
import pandas as pd

TRACKER_CSV = "tracker.csv"
RERUNS_JSON = "reruns.json"   # remembers rerun counts across deletions
POLL_SEC    = 10
STALL_SEC   = 15 * 60  # mark failed if size unchanged this long and no .db

def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def load_tracker():
    if os.path.exists(TRACKER_CSV):
        df = pd.read_csv(TRACKER_CSV)
        df = df[['log_filepath','first_created','last_modified','rerun_count','status']]
        return df
    return pd.DataFrame(columns=['log_filepath','first_created','last_modified','rerun_count','status'])

def save_tracker(df):
    df.sort_values('log_filepath', inplace=True)
    df.to_csv(TRACKER_CSV, index=False)

def load_reruns():
    if os.path.exists(RERUNS_JSON):
        with open(RERUNS_JSON,'r') as f: return json.load(f)
    return {}

def save_reruns(d):
    with open(RERUNS_JSON,'w') as f: json.dump(d, f)

def has_db(log_path):
    base, _ = os.path.splitext(log_path)
    return os.path.exists(base + ".db")

def get_file_info(p):
    st = os.stat(p)
    return st.st_size, datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S")

def detect_status(path, size, last_size, last_change_ts):
    if has_db(path):
        return "completed", time.time()
    if last_size is None or size > last_size:
        return "running", time.time()
    # unchanged size
    if time.time() - (last_change_ts or 0) >= STALL_SEC:
        return "failed", last_change_ts
    return "running", last_change_ts  # still within stall window

def snapshot_paths():
    paths = set()
    for d in get_directories():
        for p in get_logs(d):
            if os.path.exists(p): paths.add(os.path.abspath(p))
    return paths

def build_snapshot(prev_df, reruns, last_sizes, last_change_ts):
    rows = []
    current = snapshot_paths()
    prev_index = {r.log_filepath: r for r in prev_df.itertuples(index=False)}
    for p in current:
        size, mtime = get_file_info(p)
        # rerun tracking (increment on (re)appearance if previously absent)
        if p not in prev_index and p in reruns:
            reruns[p] += 1
        elif p not in prev_index and p not in reruns:
            reruns[p] = 0
        # first_created
        fc = prev_index[p].first_created if p in prev_index else now_str()
        # status via size delta
        status, lcts = detect_status(p, size, last_sizes.get(p), last_change_ts.get(p))
        if last_sizes.get(p) is None or size != last_sizes[p]:
            last_sizes[p] = size
            last_change_ts[p] = time.time()
            lcts = last_change_ts[p]
        rows.append({
            'log_filepath': p,
            'first_created': fc,
            'last_modified': mtime,
            'rerun_count': int(reruns.get(p, 0)),
            'status': status
        })
    # rows for deleted logs are intentionally omitted (not shown)
    return pd.DataFrame(rows), current

def update_tracker_if_changed(old_df, new_df):
    a = old_df.sort_values('log_filepath').reset_index(drop=True)
    b = new_df.sort_values('log_filepath').reset_index(drop=True)
    if not a.equals(b):
        save_tracker(new_df)
        return True
    return False

def monitor():
    df = load_tracker()
    reruns = load_reruns()
    last_sizes = {}      # path -> last size
    last_change_ts = {}  # path -> epoch when size last changed
    print("Monitoring... (Ctrl+C to stop)")
    while True:
        try:
            new_df, current = build_snapshot(df, reruns, last_sizes, last_change_ts)
            # if a path disappeared, we keep rerun count in reruns.json but drop from CSV
            changed = update_tracker_if_changed(df, new_df)
            if changed:
                save_reruns(reruns)
                df = new_df
        except Exception as e:
            print("Error:", e)
        time.sleep(POLL_SEC)

# ---- Your provided helpers (stubs here). Replace with your own. ----
def get_directories():
    return ["/tmp/logs"]  # example

def get_logs(directory_path):
    return [os.path.join(directory_path, f) for f in os.listdir(directory_path) if f.endswith(".log")]
# -------------------------------------------------------------------

if __name__ == "__main__":
    monitor()
