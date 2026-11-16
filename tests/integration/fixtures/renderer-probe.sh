# A renderer stand-in (docs/SANDBOX.md): Chromium runs this before each renderer
# (--renderer-cmd-prefix). It records what a renderer could reach, then becomes
# the renderer. HOME is the launch's scratch, two levels under the data
# directory, whose credentials/key.txt the confinement denies.
{
  if cat "$HOME/../../credentials/key.txt" >/dev/null 2>&1; then echo "key=readable"; else echo "key=denied"; fi
  if ls "$HOME/../../" >/dev/null 2>&1; then echo "data=listable"; else echo "data=denied"; fi
  grep '^Seccomp:' /proc/self/status 2>/dev/null
  echo "userns=$(readlink /proc/self/ns/user 2>/dev/null)"
  echo "pidns=$(readlink /proc/self/ns/pid 2>/dev/null)"
} > "$TMPDIR/renderer-probe-$$.txt" 2>&1
exec "$@"
