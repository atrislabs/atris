# group-timeout.sh: source it, then `group_timeout <secs> <cmd...>`.
# Runs the command in its own process group. A timeout (124), or TERM/INT
# to this shell (143/130), stops the whole group, children included. A
# command killed by a signal reports 128 plus the signal, never 0.
group_timeout() {
  perl -e '
    my $secs = shift; my $pid = fork();
    if ($pid == 0) { setpgrp(0, 0); exec @ARGV or exit 127; }
    my $stop = sub { my $code = shift; kill "TERM", -$pid; sleep 5; kill "KILL", -$pid; waitpid($pid, 0); exit $code; };
    local $SIG{ALRM} = sub { $stop->(124) };
    local $SIG{TERM} = sub { $stop->(143) };
    local $SIG{INT}  = sub { $stop->(130) };
    alarm $secs; waitpid($pid, 0); my $st = $?; alarm 0; kill "TERM", -$pid;
    exit(($st & 127) ? 128 + ($st & 127) : $st >> 8);
  ' "$@" &
  local gt=$!
  # a cancel to this shell reaches the group too, not just this shell
  trap 'kill -TERM $gt 2>/dev/null; wait $gt; exit 143' TERM
  trap 'kill -INT $gt 2>/dev/null; wait $gt; exit 130' INT
  wait $gt; local code=$?
  trap - TERM INT
  return $code
}
