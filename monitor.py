#!/usr/bin/env python3
import time, csv, os
from datetime import datetime
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

CSV_FILE = "file_event_counts.csv"
FIELDS = ["path", "created", "deleted", "last_created", "last_deleted"]

# 🔹 List of files you care about (absolute paths recommended)
WATCH_FILES = [
    "/tmp/test/a.txt",
    "/tmp/test/b.log",
    "/tmp/test/config.json"
]

def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

class FileListHandler(FileSystemEventHandler):
    def __init__(self, watch_files):
        super().__init__()
        self.watch_files = set(os.path.abspath(f) for f in watch_files)
        self.rows = {}
        self._load_csv()

    # ----- CSV I/O -----
    def _load_csv(self):
        if not os.path.exists(CSV_FILE):
            return
        with open(CSV_FILE, "r", newline="") as f:
            r = csv.DictReader(f)
            for row in r:
                row["created"] = int(row["created"])
                row["deleted"] = int(row["deleted"])
                self.rows[row["path"]] = row

    def _save_csv(self):
        with open(CSV_FILE, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=FIELDS)
            w.writeheader()
            for row in self.rows.values():
                w.writerow(row)

    def _touch(self, path):
        if path not in self.rows:
            self.rows[path] = {
                "path": path,
                "created": 0,
                "deleted": 0,
                "last_created": "",
                "last_deleted": ""
            }
        return self.rows[path]

    # ----- Event Handlers -----
    def on_created(self, event):
        abs_path = os.path.abspath(event.src_path)
        if not event.is_directory and abs_path in self.watch_files:
            row = self._touch(abs_path)
            row["created"] += 1
            row["last_created"] = now()
            print(f"[CREATED] {abs_path} (count={row['created']})")
            self._save_csv()

    def on_deleted(self, event):
        abs_path = os.path.abspath(event.src_path)
        if not event.is_directory and abs_path in self.watch_files:
            row = self._touch(abs_path)
            row["deleted"] += 1
            row["last_deleted"] = now()
            print(f"[DELETED] {abs_path} (count={row['deleted']})")
            self._save_csv()

def monitor(path="."):
    handler = FileListHandler(WATCH_FILES)
    obs = Observer()
    obs.schedule(handler, path, recursive=True)  # must recurse to catch nested files
    obs.start()
    print(f"Monitoring only these files:\n" + "\n".join(WATCH_FILES))
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        obs.stop()
    obs.join()

if __name__ == "__main__":
    monitor("/tmp/test")  # <-- change base dir
