# /path/to/worker_task.py
def compute(a: int, b: int):
    return {"sum": a + b, "prod": a * b}

# main.py
from bg_shell import run_two_shell_steps_hidden

fut = run_two_shell_steps_hidden(
    first_cmd=["ls", "-1"],                 # any shell command; no terminal pops up
    py_file="/path/to/worker_task.py",
    func_name="compute",
    func_args=(3, 5),
)
result = fut.result()
print(result["first"]["returncode"])
print(result["function_result"])  # {'sum': 8, 'prod': 15}
print(result["function_error"])   # None if OK
