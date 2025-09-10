import json

def process_log_file(rundir, log_name):
    # Example: return some list
    return [f"Processing {log_name}", f"in {rundir}"]

if __name__ == "__main__":
    import sys
    rundir, log_name = sys.argv[1], sys.argv[2]
    result = process_log_file(rundir, log_name)
    print(json.dumps(result))   # serialize list as JSON