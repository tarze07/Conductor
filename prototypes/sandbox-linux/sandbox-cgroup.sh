# sandbox-cgroup.sh - limity cgroup v2 per przebieg sandboksa (issue #15).
# Wczytywany (source) przez run-sandboxed.sh; nie uruchamiac samodzielnie.
#
# Wejscie (zmienne ustawiane przez launcher):
#   CG_MODE        required | best-effort | off
#   CG_PIDS_MAX    pids.max         (liczba albo pusty/none/max = bez limitu)
#   CG_MEMORY_MAX  memory.max       (bajty z opcjonalnym K/M/G/T, albo pusty/none/max)
#   CG_SWAP_MAX    memory.swap.max  (j.w.; ustawiany tylko razem z memory.max)
#   CG_CPU_MAX     cpu.max          ("QUOTA PERIOD", np. "200000 100000"; pusty/none/max = bez limitu)
#   CG_PARENT      jawny katalog nadrzedny w cgroupfs (np. delegowany scope systemd);
#                  pusty = wykrycie z /proc/self/cgroup i /proc/self/mountinfo
#   CG_NAME        nazwa podgrupy przebiegu
# Wyjscie:
#   CG_LEAF        katalog podgrupy (pusty, gdy brak cgroup)
#   CG_STATUS      JSON do sandbox-status.json
#   CG_EXEC        prefiks komendy, ktory przenosi proces sandboksa do CG_LEAF przed exec
#
# Strategia: podgrupa per przebieg w zapisywalnej hierarchii cgroup v2: w korzeniu
# (root bez cgroup namespace) albo w delegowanym cgroup (np. `systemd-run --user
# --scope -p Delegate=yes run-sandboxed.sh ...`). W korzeniu hierarchii launcher
# NIE wlacza kontrolerow (to bylaby zmiana konfiguracji hosta); w cgroup delegowanym
# wlacza je w cgroup.subtree_control, w razie potrzeby przenoszac wlasne procesy do
# liscia "supervisor" (zasada "no internal processes" cgroup v2).

CG_LEAF=""
CG_STATUS=""
CG_EXEC=()

_cg_json_str() { local s="${1//\\/\\\\}"; s="${s//\"/\\\"}"; printf '"%s"' "$s"; }

_cg_unset() { [[ -z "$1" || "$1" == none || "$1" == max ]]; }

cg_validate() {
  local re_mem='^([0-9]+[KMGT]?|max|none)?$'
  [[ "$CG_MODE" =~ ^(required|best-effort|off)$ ]] || { echo "nieznana polityka cgroups: $CG_MODE" >&2; return 1; }
  [[ "$CG_PIDS_MAX" =~ ^([0-9]+|max|none)?$ ]] || { echo "zle --pids-max: $CG_PIDS_MAX" >&2; return 1; }
  [[ "$CG_MEMORY_MAX" =~ $re_mem ]] || { echo "zle --memory-max: $CG_MEMORY_MAX" >&2; return 1; }
  [[ "$CG_SWAP_MAX" =~ $re_mem ]] || { echo "zle --memory-swap-max: $CG_SWAP_MAX" >&2; return 1; }
  [[ "$CG_CPU_MAX" =~ ^((max|[0-9]+)( [0-9]+)?|none)?$ ]] || { echo "zle --cpu-max: $CG_CPU_MAX" >&2; return 1; }
}

# Limity do ustawienia: "plik=wartosc" i potrzebne kontrolery.
_cg_plan() {
  CG_WRITES=(); CG_CTRLS=()
  if ! _cg_unset "$CG_PIDS_MAX"; then CG_WRITES+=("pids.max=$CG_PIDS_MAX"); CG_CTRLS+=(pids); fi
  if ! _cg_unset "$CG_MEMORY_MAX"; then
    CG_WRITES+=("memory.max=$CG_MEMORY_MAX"); CG_CTRLS+=(memory)
    [[ -n "$CG_SWAP_MAX" && "$CG_SWAP_MAX" != none ]] && CG_WRITES+=("memory.swap.max=$CG_SWAP_MAX")
  fi
  if ! _cg_unset "$CG_CPU_MAX"; then CG_WRITES+=("cpu.max=$CG_CPU_MAX"); CG_CTRLS+=(cpu); fi
  return 0
}

# Ustala katalog nadrzedny; ustawia CG_PARENT_DIR i CG_IS_ROOT albo zwraca 1 z CG_REASON.
_cg_find_parent() {
  CG_IS_ROOT=0
  if [[ -n "$CG_PARENT" ]]; then
    [[ "$(stat -f -c %T "$CG_PARENT" 2>/dev/null)" == cgroup2fs ]] \
      || { CG_REASON="$CG_PARENT nie jest katalogiem cgroup v2"; return 1; }
    CG_PARENT_DIR="$CG_PARENT"
    [[ -w "$CG_PARENT_DIR/cgroup.procs" ]] || { CG_REASON="brak prawa zapisu do $CG_PARENT_DIR"; return 1; }
    return 0
  fi
  local own="" line mnt="" mroot="" f i
  while IFS= read -r line; do [[ "$line" == 0::* ]] && own="${line#0::}"; done < /proc/self/cgroup
  [[ -n "$own" ]] || { CG_REASON="proces nie nalezy do hierarchii cgroup v2 (/proc/self/cgroup)"; return 1; }
  while IFS= read -r line; do
    read -r -a f <<< "$line"
    for ((i = 6; i < ${#f[@]}; i++)); do
      if [[ "${f[i]}" == - ]]; then
        if [[ "${f[i+1]}" == cgroup2 ]]; then
          # preferuj /sys/fs/cgroup; w trybie hybrydowym bywa /sys/fs/cgroup/unified
          if [[ -z "$mnt" || "${f[4]}" == /sys/fs/cgroup ]]; then mnt="${f[4]}"; mroot="${f[3]}"; fi
        fi
        break
      fi
    done
  done < /proc/self/mountinfo
  [[ -n "$mnt" ]] || { CG_REASON="cgroup v2 nie jest zamontowane"; return 1; }
  [[ "$mroot" == / ]] || own="${own#"$mroot"}"
  CG_PARENT_DIR="${mnt%/}${own%/}"
  [[ "${own%/}" == "" ]] && CG_IS_ROOT=1
  [[ -d "$CG_PARENT_DIR" ]] || { CG_REASON="nie znaleziono $CG_PARENT_DIR"; return 1; }
  if [[ ! -w "$CG_PARENT_DIR/cgroup.procs" ]] || [[ ! -w "$CG_PARENT_DIR" ]]; then
    CG_REASON="cgroup $CG_PARENT_DIR nie jest delegowane (brak zapisu); uruchom przez: systemd-run --user --scope -p Delegate=yes"
    return 1
  fi
}

# Wlacza kontrolery w CG_PARENT_DIR/cgroup.subtree_control (tylko poza korzeniem).
_cg_enable() {
  local c missing=()
  for c in "${CG_CTRLS[@]}"; do
    grep -qw "$c" "$CG_PARENT_DIR/cgroup.controllers" 2>/dev/null || missing+=("$c")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    CG_REASON="brak kontrolerow ${missing[*]} w $CG_PARENT_DIR/cgroup.controllers (np. przypiete do cgroup v1 w trybie hybrydowym albo niedelegowane)"
    return 1
  fi
  for c in "${CG_CTRLS[@]}"; do
    grep -qw "$c" "$CG_PARENT_DIR/cgroup.subtree_control" && continue
    if [[ $CG_IS_ROOT -eq 1 ]]; then
      CG_REASON="kontroler $c nie jest wlaczony w $CG_PARENT_DIR/cgroup.subtree_control (korzen hierarchii: launcher go nie zmienia)"
      return 1
    fi
    if ! echo "+$c" 2>/dev/null > "$CG_PARENT_DIR/cgroup.subtree_control"; then
      # "no internal processes": przenosimy procesy z rodzica do liscia supervisor
      mkdir -p "$CG_PARENT_DIR/supervisor" 2>/dev/null
      local p
      while read -r p; do echo "$p" 2>/dev/null > "$CG_PARENT_DIR/supervisor/cgroup.procs"; done < "$CG_PARENT_DIR/cgroup.procs"
      echo "+$c" 2>/dev/null > "$CG_PARENT_DIR/cgroup.subtree_control" \
        || { CG_REASON="nie mozna wlaczyc kontrolera $c w $CG_PARENT_DIR"; return 1; }
    fi
  done
}

_cg_status() {  # $1 = status, $2 = powod (opcjonalnie)
  local s='{"mode":'"$(_cg_json_str "$CG_MODE")"',"status":'"$(_cg_json_str "$1")"
  [[ -n "${2:-}" ]] && s+=',"reason":'"$(_cg_json_str "$2")"
  [[ -n "$CG_LEAF" ]] && s+=',"path":'"$(_cg_json_str "$CG_LEAF")"
  local w first=1
  s+=',"limits":{'
  for w in "${CG_WRITES[@]}"; do
    [[ $first -eq 1 ]] || s+=','; first=0
    s+="$(_cg_json_str "${w%%=*}"):$(_cg_json_str "${w#*=}")"
  done
  s+='}'
  [[ -n "${CG_NOTE:-}" ]] && s+=',"note":'"$(_cg_json_str "$CG_NOTE")"
  CG_STATUS="$s}"
}

# Zwraca 0 (kontynuuj) albo 1 (polityka required i brak cgroup: przerwij).
cgroup_setup() {
  _cg_plan
  CG_NOTE=""
  if [[ "$CG_MODE" == off ]]; then _cg_status off; return 0; fi
  if [[ ${#CG_WRITES[@]} -eq 0 && "$CG_MODE" != required ]]; then _cg_status not_requested; return 0; fi
  CG_REASON=""
  if _cg_find_parent && _cg_enable && _cg_make_leaf; then
    CG_EXEC=(sh -c 'echo $$ > "$0/cgroup.procs" || exit 125; exec "$@"' "$CG_LEAF")
    _cg_status applied
    return 0
  fi
  _cg_status unavailable "$CG_REASON"
  if [[ "$CG_MODE" == required ]]; then
    echo "sandbox: cgroup v2 wymagane (--cgroups required), ale niedostepne: $CG_REASON" >&2
    return 1
  fi
  echo "sandbox: UWAGA: limity cgroup (${CG_WRITES[*]}) nie zostana zastosowane: $CG_REASON." \
       "Zostaja rlimity i PID namespace (--cgroups best-effort)." >&2
  return 0
}

_cg_make_leaf() {
  local leaf="$CG_PARENT_DIR/$CG_NAME" w
  mkdir "$leaf" 2>/dev/null || { CG_REASON="nie mozna utworzyc $leaf"; return 1; }
  CG_LEAF="$leaf"
  for w in "${CG_WRITES[@]}"; do
    if [[ "${w%%=*}" == memory.swap.max && ! -e "$leaf/memory.swap.max" ]]; then
      CG_NOTE="memory.swap.max niedostepne (brak swap accounting)"; continue
    fi
    if ! echo "${w#*=}" 2>/dev/null > "$leaf/${w%%=*}"; then
      CG_REASON="nie mozna ustawic ${w%%=*}=${w#*=} w $leaf"
      rmdir "$leaf" 2>/dev/null; CG_LEAF=""
      return 1
    fi
  done
}

# Po zakonczeniu sandboksa: zabija ewentualne resztki, raportuje zdarzenia limitow,
# usuwa podgrupe. Idempotentne (wywolywane tez z trap EXIT).
cgroup_cleanup() {
  [[ -n "$CG_LEAF" && -d "$CG_LEAF" ]] || return 0
  local n
  if [[ -r "$CG_LEAF/pids.events" ]]; then
    n="$(awk '$1 == "max" {print $2}' "$CG_LEAF/pids.events")"
    [[ "${n:-0}" -gt 0 ]] && echo "sandbox: limit pids.max osiagniety ($n odmow fork/clone)" >&2
  fi
  if [[ -r "$CG_LEAF/memory.events" ]]; then
    n="$(awk '$1 == "oom_kill" {print $2}' "$CG_LEAF/memory.events")"
    [[ "${n:-0}" -gt 0 ]] && echo "sandbox: limit memory.max: OOM killer zabil $n proces(y)" >&2
  fi
  [[ -e "$CG_LEAF/cgroup.kill" ]] && echo 1 2>/dev/null > "$CG_LEAF/cgroup.kill"
  local _i
  for _i in $(seq 1 200); do
    rmdir "$CG_LEAF" 2>/dev/null && break
    sleep 0.01
  done
  [[ -d "$CG_LEAF" ]] && echo "sandbox: nie mozna usunac $CG_LEAF" >&2
  CG_LEAF=""
}
