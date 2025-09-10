import os, json, shutil, subprocess

def run_and_capture(rundir, log_name):
    proc_py = os.path.join(os.path.dirname(__file__), "worker.py")
    py = "python3" if os.name != "nt" else "python"

    # Prefer mandatory form if available; otherwise fall back so it works on Windows.
    if shutil.which("utilq"):
        cmd = f'setenv cmd && utilq -Is {py} "{proc_py}" "{rundir}" "{log_name}"'
    else:
        cmd = f'{py} "{proc_py}" "{rundir}" "{log_name}"'

    # shell=True so the shell resolves utilq/python on PATH; capture JSON
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or f"Exited {r.returncode}")
    return json.loads(r.stdout.strip())

if __name__ == "__main__":
    out = run_and_capture("/tmp/rundir", "example.log")
    print("Got from process.py:", out)
