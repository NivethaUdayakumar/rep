# main.py
import os, json, shutil, subprocess

def run_and_capture(rundir, log_name):
    py = "python3" if os.name != "nt" else "python"
    # Pure JSON to stdout: no extra prints, args passed via sys.argv
    code = 'import json,process,sys; print(json.dumps(process.process_log_file(sys.argv[1], sys.argv[2])))'
    if shutil.which("utilq"):
        cmd = f'utilq -Is {py} -c "{code}" "{rundir}" "{log_name}"'
    else:
        cmd = f'{py} -c "{code}" "{rundir}" "{log_name}"'
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"subprocess failed: {r.stderr.strip() or r.stdout.strip() or r.returncode}")
    out = r.stdout.strip()
    if not out:
        raise RuntimeError("No output received from child process.")
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        # Last-resort: try to extract a JSON array/object from noisy output
        import re
        m = re.findall(r'(\[[\s\S]*\]|\{[\s\S]*\})', out)
        if m:
            return json.loads(m[-1])
        raise RuntimeError(f"Invalid JSON from child:\n{out}")

if __name__ == "__main__":
    # 1) shell command to say hello
    subprocess.run("echo hello", shell=True)

    # 2) your mandatory utilq/python command (captures list)
    result = run_and_capture("/tmp/rundir", "example.log")
    print("Got:", result)

    # 3) another shell command (example)
    subprocess.run("echo done", shell=True)
