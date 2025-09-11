#!/usr/bin/env python3
# Simple log monitor (stores split path columns instead of full path)
import os, time, json
from datetime import datetime
import pandas as pd

# -------- Config --------
TRACKER_CSV = "tracker.csv"
RERUNS_JSON = "reruns.json"   # remembers rerun counts across deletions
POLL_SEC    = 10
STALL_SEC   = 15 * 60         # mark failed if size unchanged this long and no .db
PATH_DEPTH  = 8               # number of path segments to store (tail)
# ------------------------

def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def split_parts(p):
    parts = os.path.abspath(p).strip(os.sep).split(os.sep)
    parts = parts[-PATH_DEPTH:]
    return (['']*(PATH_DEPTH-len(parts))) + parts

def parts_cols(parts):
    return {f'p{i}': parts[i] for i in range(PATH_DEPTH)}

def load_tracker():
    cols = [f'p{i}' for i in range(PATH_DEPTH)] + ['first_created','last_modified','rerun_count','status']
    if os.path.exists(TRACKER_CSV):
        df = pd.read_csv(TRACKER_CSV)
        # Back-compat: expand legacy 'log_filepath' into parts if present
        if 'log_filepath' in df.columns:
            part_df = pd.DataFrame(df['log_filepath'].map(split_parts).tolist(),
                                   columns=[f'p{i}' for i in range(PATH_DEPTH)])
            df = pd.concat([part_df, df[['first_created','last_modified','rerun_count','status']]], axis=1)
        df = df.reindex(columns=cols)
        return df.fillna('')
    return pd.DataFrame(columns=cols)

def save_tracker(df):
    order = [f'p{i}' for i in range(PATH_DEPTH)]
    df.sort_values(order, inplace=True)
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
    if has_db(path): return "completed", time.time()
    if last_size is None or size > last_size: return "running", time.time()
    if time.time() - (last_change_ts or 0) >= STALL_SEC: return "failed", last_change_ts
    return "running", last_change_ts

def snapshot_paths():
    paths = set()
    for d in get_directories():
        for p in get_logs(d):
            if os.path.exists(p): paths.add(os.path.abspath(p))
    return paths

def build_snapshot(prev_df, reruns, last_sizes, last_change_ts):
    rows, current = [], snapshot_paths()
    # index previous by parts tuple
    prev_index = {tuple(getattr(r, f'p{i}') for i in range(PATH_DEPTH)): r
                  for r in prev_df.itertuples(index=False)}
    for p in current:
        size, mtime = get_file_info(p)
        parts = split_parts(p)
        key = tuple(parts)

        # carry over/increment rerun count (reruns keyed by full path)
        if key not in prev_index and p in reruns:
            reruns[p] += 1
        elif key not in prev_index and p not in reruns:
            reruns[p] = 0

        fc = prev_index[key].first_created if key in prev_index else now_str()
        status, lcts = detect_status(p, size, last_sizes.get(p), last_change_ts.get(p))
        if last_sizes.get(p) is None or size != last_sizes[p]:
            last_sizes[p] = size
            last_change_ts[p] = time.time()
            lcts = last_change_ts[p]

        rows.append({
            **parts_cols(parts),
            'first_created': fc,
            'last_modified': mtime,
            'rerun_count': int(reruns.get(p, 0)),
            'status': status
        })
    return pd.DataFrame(rows), current

def update_tracker_if_changed(old_df, new_df):
    a = old_df.sort_values([f'p{i}' for i in range(PATH_DEPTH)]).reset_index(drop=True)
    b = new_df.sort_values([f'p{i}' for i in range(PATH_DEPTH)]).reset_index(drop=True)
    if not a.equals(b):
        save_tracker(new_df)
        return True
    return False

def monitor():
    df = load_tracker()
    reruns = load_reruns()
    last_sizes, last_change_ts = {}, {}
    print("Monitoring... (Ctrl+C to stop)")
    while True:
        try:
            new_df, _ = build_snapshot(df, reruns, last_sizes, last_change_ts)
            if update_tracker_if_changed(df, new_df):
                save_reruns(reruns)
                df = new_df
        except Exception as e:
            print("Error:", e)
        time.sleep(POLL_SEC)

# ---- Replace these with your implementations ----
def get_directories():
    return ["/tmp/logs"]  # example

def get_logs(directory_path):
    return [os.path.join(directory_path, f) for f in os.listdir(directory_path) if f.endswith(".log")]
# -------------------------------------------------

if __name__ == "__main__":
    monitor()
