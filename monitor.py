#!/usr/bin/env python3
import time, csv, os, argparse
from datetime import datetime
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

CSV_FILE = "file_state_counts.csv"
FIELDS = ["path", "state", "created_count", "deleted_count", "last_changed"]

WATCH_FILES = [
    "/tmp/test/a.txt",
    "/tmp/test/b.log",
    "/tmp/test/config.json",
]

def current_timestamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

class FileStateDatabase:
    """Keeps track of file states and counters, synchronized with a CSV file."""

    def __init__(self, csv_path):
        self.csv_path = csv_path
        self.records = {}  # path -> record dictionary
        self._load_from_csv()

    def _load_from_csv(self):
        if os.path.exists(self.csv_path):
            with open(self.csv_path, "r", newline="") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    row["created_count"] = int(row["created_count"])
                    row["deleted_count"] = int(row["deleted_count"])
                    self.records[row["path"]] = row

        # Ensure all watched files exist in records
        for file_path in WATCH_FILES:
            abs_path = os.path.abspath(file_path)
            if abs_path not in self.records:
                self.records[abs_path] = {
                    "path": abs_path,
                    "state": "missing",
                    "created_count": 0,
                    "deleted_count": 0,
                    "last_changed": "",
                }

    def save_if_updated(self, update_required):
        """Write CSV only if there were state changes."""
        if not update_required:
            return
        with open(self.csv_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=FIELDS)
            writer.writeheader()
            for path in sorted(self.records.keys()):
                writer.writerow(self.records[path])

    def get_state(self, path):
        return self.records[path]["state"]

    def update_state(self, path, new_state):
        """Change state if needed and update counters/timestamps."""
        record = self.records[path]
        if record["state"] == new_state:
            return False  # No change
        record["state"] = new_state
        if new_state == "exists":
            record["created_count"] += 1
        elif new_state == "missing":
            record["deleted_count"] += 1
        record["last_changed"] = current_timestamp()
        return True  # State actually changed

class FileListEventHandler(FileSystemEventHandler):
    """Handles filesystem events for only the monitored file list."""

    def __init__(self, database, watch_files):
        super().__init__()
        self.db = database
        self.watch_files = set(os.path.abspath(f) for f in watch_files)

    def on_created(self, event):
        if event.is_directory:
            return
        abs_path = os.path.abspath(event.src_path)
        if abs_path in self.watch_files:
            state_changed = self.db.update_state(abs_path, "exists")
            self.db.save_if_updated(state_changed)
            if state_changed:
                print(f"[STATE CHANGE] {abs_path} -> exists "
                      f"(created_count={self.db.records[abs_path]['created_count']})")

    def on_deleted(self, event):
        if event.is_directory:
            return
        abs_path = os.path.abspath(event.src_path)
        if abs_path in self.watch_files:
            state_changed = self.db.update_state(abs_path, "missing")
            self.db.save_if_updated(state_changed)
            if state_changed:
                print(f"[STATE CHANGE] {abs_path} -> missing "
                      f"(deleted_count={self.db.records[abs_path]['deleted_count']})")

def reconcile_on_start(database):
    """Sync CSV records with actual filesystem states at startup."""
    update_required = False
    for path in database.records.keys():
        exists_now = os.path.exists(path)
        expected_state = "exists" if exists_now else "missing"
        update_required |= database.update_state(path, expected_state)
    database.save_if_updated(update_required)
    if update_required:
        print("[Startup] CSV reconciled with current filesystem states.")
    else:
        print("[Startup] No changes; CSV already matches filesystem.")

def monitor(base_dir, recursive=True):
    database = FileStateDatabase(CSV_FILE)
    reconcile_on_start(database)

    handler = FileListEventHandler(database, WATCH_FILES)
    observer = Observer()
    observer.schedule(handler, base_dir, recursive=recursive)
    observer.start()

    print("Monitoring these files (state changes only):")
    for f in WATCH_FILES:
        print(" -", os.path.abspath(f))

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Monitor state changes of a fixed file list; update CSV only on changes."
    )
    parser.add_argument("base_dir", help="Base directory to monitor (must cover all watched files)")
    parser.add_argument("--no-recursive", action="store_true", help="Disable recursion into subdirectories")
    args = parser.parse_args()

    monitor(args.base_dir, recursive=not args.no_recursive)
