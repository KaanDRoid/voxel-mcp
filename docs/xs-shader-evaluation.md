# xs shader evaluation: decision record

Status: accepted (spike passed, `run_xs_shader` shipped).

## Question

MagicaVoxel xs shaders define `float map(vec3 v)` in a GLSL-like language. Can a
small, safe interpreter run a documented subset of it so that `run_xs_shader`
can apply shipped and user shaders to a model?

## Decision

Yes. `src/xsEval.ts` tokenizes and parses the shader into an expression tree and
compiles that tree into JavaScript closures. There is **no `eval`, no `Function`
constructor and no generated JavaScript source**. A shader can only operate on
numbers, small vectors and its own local variables; names are resolved at
compile time against a fixed set of globals and built-in functions, so host
objects (`globalThis`, `process`, `constructor`, ...) are unreachable.

## Supported subset

- Types: `float`, `int`, `bool`, `vec2`, `vec3`, `vec4`. Integer variables
  truncate on assignment. Arithmetic is otherwise done in floating point, so
  `int / int` is a float division until stored in an `int` variable.
- Declarations: local variables (several per statement), `const` globals,
  user functions with `in` parameters, defined **before** use (this makes
  recursion impossible).
- Statements: `if`/`else`, `for`, `while`, `break`, `continue`, `return`,
  assignment and `+= -= *= /=`, `++`/`--` as statements.
- Expressions: `+ - * / %`, comparisons, `&& || !`, `?:`, constructors
  (`float() int() bool() vec2() vec3() vec4()` including broadcast and
  concatenation), swizzle reads and writes (`xyzw`, `rgba`, `stpq`).
- Functions: `radians degrees sin cos tan asin acos atan(1|2 args) exp log exp2
  log2 sqrt inversesqrt pow abs sign floor ceil trunc round fract mod min max
  clamp mix step smoothstep length distance dot cross normalize`, plus the xs
  built-ins `voxel(vec3)`, `color_sel(float)` and `palette(float)`.
- Built-in arguments: `i_volume_size`, `i_color_index`, `i_num_color_sels`, and
  every `m_*` variable declared in the header (read-only floats).
- Not supported (rejected with a line number): preprocessor lines, `uniform`
  declarations, arrays, matrices, structs, `do`/`switch`/`discard`, `out`/`inout`
  parameters, prototypes, texture functions.

Semantics chosen where the GLSL specification or MagicaVoxel is silent:

- `step(edge, x)` is `1` when `x >= edge` (so `NaN` gives `0`).
- `mod` is floored, `round` rounds half up.
- The returned float is rounded half up and clamped to 0..255; non-finite
  results are `0`. `0` means empty (replace mode clears the voxel).
- `color_sel(k)` uses `floor(k)` clamped into the selection list.
- `voxel(v)` reads the model as it was before the run.

## Limits

| Limit | Value |
|---|---|
| Source size | 64 KiB (tool schema: 256 KiB for files) |
| Tokens | 20,000 |
| Parser nesting depth | 64 |
| Interpreter steps per voxel | 200,000 |
| Iterations per loop | 4,096 |
| Call depth | 16 |
| Wall clock per run | 20 s default, 100 ms to 120 s via `timeLimitMs` |
| Result size | 2,000,000 voxels (model limit) |

Exceeding a limit is an error and the model is left untouched (the run happens
inside a registry transaction, so success is undoable with `undo`).

The interpreter runs on the server thread rather than in a worker thread. The
step, loop and time limits bound every run, there is no way to block
indefinitely, and a worker would add a build-layout dependency (a separate
compiled entry point) for no additional guarantee. Requests are already
serialized by the tool wrapper.

## Measurements

Machine: Windows 11, Node 22, 128 x 128 x 128 volume, header default arguments,
shaders from MagicaVoxel 0.99.7.2 read in place (never copied):

| Shader | Time | Result voxels |
|---|---|---|
| sphere | 1.9 s | 1,099,136 |
| stair | 1.4 s | 16,384 |
| torus | 3.1 s | 13,848 |
| round | 4.0 s | 2,089,624 (exceeds the model limit; for timing only) |
| gear | 4.3 s | 738,304 |
| poly | 4.8 s | 680,960 |
| mandelbulb | 52 s | 396,392 |

Re-run with `XS_BENCH=1 MAGICAVOXEL_HOME=<install> npm test`.

## Gate

The roadmap gate was: at least 5 of the 7 shipped shaders run and finish a
128^3 volume in under 10 s. Six of seven pass. Mandelbulb (eight iterations of
a polar-coordinate power function per voxel) is correct but about five times
over budget at 128^3; the default time limit stops it and it is practical at
64^3 or below. Decision: **continue** with `run_xs_shader`.

## Validation

All seven shipped shaders compile. Tests compare shader output with
hand-computed voxels (sphere, rounded box, torus, stair, polygon, gear,
mandelbulb) and with `fill_sphere` for the sphere shader. CI has no MagicaVoxel
install, so the same checks run on synthetic shaders with equivalent formulas
written for the test suite; the shipped-file tests run when `MAGICAVOXEL_HOME`
or `MAGICAVOXEL_PATH` is set.

## Not done

- `install_xs_shader` (copying into the MagicaVoxel folder) was not implemented:
  the install folder stays strictly read-only for this server.
- No full GLSL compiler: `validate_xs_shader` checks structure and then reports
  whether the evaluator supports the program (`evaluable`).
