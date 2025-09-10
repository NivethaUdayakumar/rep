# bg_shell.py
from __future__ import annotations
import json, os, shlex, subprocess
from pathlib import Path
from typing import Any, Mapping, Sequence, Optional, Dict
from concurrent.futures import ThreadPoolExecutor, Future

_EXEC = ThreadPoolExecutor(max_workers=4)

def _python_func_cmd(py_file: str, func_name: str, args: Sequence[Any], kwargs: Mapping[str, Any]) -> list[str]:
    """Build `python3 -c` command that loads a module by path, calls a function, prints JSON result."""
    py_path = str(Path(py_file).resolve())
    code = (
        "import importlib.util, json, sys, pathlib;"
        "p,f,a,k=sys.argv[1:5]; a=json.loads(a); k=json.loads(k);"
        "spec=importlib.util.spec_from_file_location(pathlib.Path(p).stem,p);"
        "m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m);"
        "res=getattr(m,f)(*a,**k); print(json.dumps(res))"
    )
    return ["python3", "-c", code, py_path, func_name, json.dumps(list(args)), json.dumps(dict(kwargs))]

def _run_bg(cmd: Sequence[str] | str, *, cwd: Optional[str]=None,
            env: Optional[Mapping[str, str]]=None, capture: bool=True,
            new_session: bool=True, timeout: Optional[float]=None) -> Dict[str, Any]:
    """
    Run one command with no terminal UI. If capture=True, collect stdout/stderr; else silence them.
    """
    if isinstance(cmd, str):
        cmd = shlex.split(cmd)

    # Detach from any TTY; no window opens.
    stdin = subprocess.DEVNULL
    stdout = subprocess.PIPE if capture else subprocess.DEVNULL
    stderr = subprocess.PIPE if capture else subprocess.DEVNULL

    p = subprocess.Popen(
        cmd, cwd=cwd, env=env, stdin=stdin, stdout=stdout, stderr=stderr,
        preexec_fn=(os.setsid if new_session else None),  # Linux/macOS: its own session, no controlling TTY
        text=True,
    )
    try:
        out, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        p.kill()
        out, err = p.communicate()
        return {"argv": list(cmd), "returncode": -9, "stdout": out or "", "stderr": err or "timeout"}

    return {"argv": list(cmd), "returncode": p.returncode, "stdout": out or "", "stderr": err or ""}

def run_two_shell_steps_hidden(
    first_cmd: Sequence[str] | str,
    *,
    # second step = call python function in another file (via shell)
    py_file: str,
    func_name: str,
    func_args: Sequence[Any] = (),
    func_kwargs: Mapping[str, Any] = {},
    cwd: Optional[str] = None,
    env: Optional[Mapping[str, str]] = None,
    timeout_each: Optional[float] = None,
) -> Future:
    """
    Background job:
      1) run `first_cmd` (hidden, optionally captured)
      2) run `python3 -c ...` that imports `py_file` and calls `func_name(*args, **kwargs)`,
         printing JSON to stdout, which we parse and return.
    Returns a Future -> dict with both step results + parsed `function_result`.
    """
    py_cmd = _python_func_cmd(py_file, func_name, func_args, func_kwargs)

    def job():
        step1 = _run_bg(first_cmd, cwd=cwd, env=env, capture=True, timeout=timeout_each)
        step2 = _run_bg(py_cmd,     cwd=cwd, env=env, capture=True, timeout=timeout_each)

        fn_res = None
        fn_err = None
        if step2["returncode"] == 0:
            try:
                fn_res = json.loads(step2["stdout"] or "null")
            except json.JSONDecodeError as e:
                fn_err = f"JSON decode failed: {e}; raw: {step2['stdout']!r}"
        else:
            fn_err = f"exit {step2['returncode']}: {step2['stderr'] or step2['stdout']}"
        return {"first": step1, "second": step2, "function_result": fn_res, "function_error": fn_err}

    return _EXEC.submit(job)
