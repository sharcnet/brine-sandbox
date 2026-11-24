#!/bin/sh
# Escape probes. Run with `brine-sandbox --check` from a project directory; it runs this inside
# the same sandbox Pi gets. Every line must print PASS.
# Plausible checks are plain GETs only. Never register an account or send events.
B=$BRINE_BASE_URL
fails=0
t() { # t <expect: ok|blocked|CODE> <desc> <cmd...>
  want=$1 desc=$2; shift 2
  out=$("$@" 2>&1); rc=$?
  case $want in
    ok)      [ $rc -eq 0 ] && [ "$out" = 200 ] && r=PASS || r=FAIL ;;
    blocked) { [ $rc -ne 0 ] || echo "$out" | grep -q -E '^(4[0-9][0-9]|000)$'; } && r=PASS || r=FAIL ;;
    *)       [ "$out" = "$want" ] && r=PASS || r=FAIL ;;
  esac
  [ $r = FAIL ] && fails=$((fails+1))
  printf '%-4s %-44s %s\n' $r "$desc" "$(echo "$out" | head -c 90 | tr '\n' ' ')"
}
code() { curl -sS -m8 -o /dev/null -w '%{http_code}' "$@"; }

# Network: Brine through nono's route, nothing else.
t blocked "internet via proxy (example.com)"   code https://example.com
t blocked "internet direct, no proxy"           code --noproxy '*' https://example.com
t blocked "brine direct, no proxy"              code --noproxy '*' https://brine.sharcnet.ca/v1/models
t blocked "plausible vhost by IP"               code -k -H 'Host: x' https://199.241.160.16/register
t blocked "DNS lookup"                          getent hosts example.com
t blocked "UDP to 1.1.1.1:53"                   python3 -I -c 'import socket;s=socket.socket(2,2);s.settimeout(2);s.sendto(b"x",("1.1.1.1",53));s.recv(1)'
t 401     "CONNECT brine carries no key"        code -H "Authorization: Bearer $BRINE_API_KEY" https://brine.sharcnet.ca/v1/models
t blocked "fronting: CONNECT brine, Host: x"    sh -c "curl -sS -m8 -H 'Host: x' https://brine.sharcnet.ca/api/health | grep -q clickhouse && echo 200 || echo 404"
t ok      "brine route: GET /models"            code -H "Authorization: Bearer $BRINE_API_KEY" "$B/models"
t 403     "brine route: POST /key/generate"     code -X POST -H "Authorization: Bearer $BRINE_API_KEY" -d '{}' "$B/key/generate"
t 403     "brine route: ../ traversal"          code --path-as-is -H "Authorization: Bearer $BRINE_API_KEY" "$B/models/../../key/info"
t 401     "brine route: without session token"  code "$B/models"

# Files: the project directory and nothing else of yours.
t blocked "read the real Brine key"             cat "$BRINE_SANDBOX_KEYFILE"
t blocked "read ~/.ssh"                         ls "$HOME/.ssh"
t blocked "read ~/.pi/agent/auth.json"          cat "$HOME/.pi/agent/auth.json"
t blocked "list home directory"                 ls "$HOME"
t blocked "write to home directory"             touch "$HOME/.brine-sandbox-escape"
t blocked "rewrite the sandbox policy"          sh -c ': >>"$0"' "$BRINE_SANDBOX_CONFIG/profile.json"
t blocked "rewrite the launcher"                sh -c ': >>"$0"' "$BRINE_SANDBOX_REPO/brine-sandbox"
t blocked "read nono supervisor environ"        sh -c 'cat /proc/$(pgrep -x nono | head -1)/environ'

echo "$fails failure(s)"; [ $fails -eq 0 ]
