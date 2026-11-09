#!/usr/bin/env bash
# PRODUCTION (gateway) manifests in k8s/: static checks before Kyle applies anything. Reads files only.
# A copy of hosts/gateway/tests/manifest-test.sh in kylenguyen/sovrin; keep the two the same apart from the
# defaults below (manifest folder, no PRODUCTION header rule).
#   bash k8s/tests/manifest-test.sh                            the manifests, then every fixture (each must fail)
#   bash k8s/tests/manifest-test.sh --dir D [--debt F]         one directory only
# Rules, one id each:
#   kubeconform  kubeconform -strict passes, Kubernetes version pinned to gateway's
#   image-digest every image is pinned as image@sha256:<64 hex>
#   resources    every container has CPU and memory requests and limits
#   privileged   no privileged, hostNetwork, hostPID, hostIPC, hostPath or capabilities.add unless the line
#                above says "# allow: <reason>"
#   header       every file starts with $MANIFEST_HEADER (off here: ezbus manifests carry no header yet)
#   namespace    every namespaced resource sets metadata.namespace (cluster-scoped kinds have none)
# known-debt.txt lists today's violations, "<file> <rule> <detail>" per line. A listed violation passes; a
# listed line that no longer occurs fails, so the file can only shrink.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DIR=$HERE/..
DEBT=$HERE/known-debt.txt
FIXTURES=1
# gateway runs k3s; its exact version is not recorded yet (sovrin docs/tiers-plan.md, A1). s1's minor until C2 checks.
K8S_VERSION=${K8S_VERSION:-1.36.0}
KUBECONFORM=ghcr.io/yannh/kubeconform@sha256:85dbef6b4b312b99133decc9c6fc9495e9fc5f92293d4ff3b7e1b30f5611823c
HEADER=${MANIFEST_HEADER-}
while [ $# -gt 0 ]; do
  case $1 in
    --dir)  DIR=$2; FIXTURES=0; shift ;;
    --debt) DEBT=$2; shift ;;
    *) sed -n '2,18p' "$0"; exit 2 ;;
  esac
  shift
done
DIR=$(cd "$DIR" && pwd)
PY=python3; [ -x /usr/bin/python3 ] && PY=/usr/bin/python3

PASSED=0 FAILED=0
ok()  { PASSED=$((PASSED + 1)); printf 'ok    %s\n' "$1"; }
bad() { FAILED=$((FAILED + 1)); printf 'FAIL  %s\n' "$1"; [ -z "${2:-}" ] || printf '%s\n' "$2" | sed 's/^/      /'; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# violations <dir>: one "<file> <rule> <detail>" line per violation, files relative to <dir>.
violations() {
  local dir=$1 f rel out
  while IFS= read -r f; do
    rel=${f#"$dir"/}
    if ! out=$(docker run --rm -v "$dir:/m:ro" "$KUBECONFORM" -strict -summary=false \
        -kubernetes-version "$K8S_VERSION" "/m/$rel" 2>&1); then
      printf '%s kubeconform %s\n' "$rel" "$(printf '%s' "$out" | head -1 | tr -s ' \t' ' ' | cut -c1-120)"
    fi
  done < <(find "$dir" -path "$dir/tests" -prune -o \( -name '*.yaml' -o -name '*.yml' \) -print | sort)
  MANIFEST_HEADER=$HEADER "$PY" -I - "$dir" <<'PY'
import os, re, sys, yaml
root = sys.argv[1]
header = os.environ.get("MANIFEST_HEADER", "")
RISKY = re.compile(r"^\s*-?\s*(privileged:\s*true|hostNetwork:\s*true|hostPID:\s*true|hostIPC:\s*true|hostPath:|add:)")
CLUSTER_SCOPED = {"Namespace", "ClusterRole", "ClusterRoleBinding", "CustomResourceDefinition", "PersistentVolume",
                  "StorageClass", "PriorityClass", "IngressClass", "RuntimeClass", "APIService",
                  "ValidatingWebhookConfiguration", "MutatingWebhookConfiguration", "Node"}
out = []
for dirpath, dirs, names in os.walk(root):
    if dirpath == root and "tests" in dirs:
        dirs.remove("tests")  # the test's own fixtures, when the test lives inside the manifest folder
    for n in sorted(names):
        if not n.endswith((".yaml", ".yml")):
            continue
        path = os.path.join(dirpath, n)
        rel = os.path.relpath(path, root)
        text = open(path, encoding="utf-8").read()
        lines = text.split("\n")
        if header and not text.startswith(header):
            out.append((rel, "header", "first line is not " + header.replace(" ", "_")))
        for i, line in enumerate(lines):
            m = RISKY.match(line)
            if m:
                prev = next((l.strip() for l in reversed(lines[:i]) if l.strip()), "")
                if not re.match(r"#\s*allow:\s*\S", prev):
                    out.append((rel, "privileged", "line_%d:_%s" % (i + 1, m.group(1).split(":")[0])))
        for doc in yaml.safe_load_all(text):
            if not isinstance(doc, dict):
                continue
            kind, name = doc.get("kind", "?"), (doc.get("metadata") or {}).get("name", "?")
            if kind not in CLUSTER_SCOPED and not (doc.get("metadata") or {}).get("namespace"):
                out.append((rel, "namespace", "%s/%s" % (kind, name)))
            spec = doc.get("spec") or {}
            pod = (spec.get("jobTemplate") or {}).get("spec", {}).get("template", {}).get("spec") \
                if kind == "CronJob" else (spec.get("template") or {}).get("spec") if kind != "Pod" else spec
            if not pod:
                continue
            for c in (pod.get("containers") or []) + (pod.get("initContainers") or []):
                cname = "%s/%s:%s" % (kind, name, c.get("name"))
                if not re.search(r"@sha256:[0-9a-f]{64}$", c.get("image") or ""):
                    out.append((rel, "image-digest", "%s=%s" % (cname, c.get("image"))))
                r = c.get("resources") or {}
                missing = [f"{k}.{x}" for k in ("requests", "limits") for x in ("cpu", "memory")
                           if not (r.get(k) or {}).get(x)]
                if missing:
                    out.append((rel, "resources", "%s_missing_%s" % (cname, ",".join(missing))))
for v in out:
    print(" ".join(v))
PY
}

# check <dir> <debt file>: violations must equal the debt file (minus comments), as sets.
check() {
  local dir=$1 debt=$2
  violations "$dir" | sort -u > "$TMP/found"
  if [ -f "$debt" ]; then grep -vE '^\s*(#|$)' "$debt" | sort -u > "$TMP/debt"; else : > "$TMP/debt"; fi
  local new gone
  new=$(comm -23 "$TMP/found" "$TMP/debt")
  gone=$(comm -13 "$TMP/found" "$TMP/debt")
  if [ -z "$new" ]; then ok "no violation outside known-debt.txt ($(wc -l < "$TMP/found") known)"
  else bad "no violation outside known-debt.txt" "$new"; fi
  if [ -z "$gone" ]; then ok "every known-debt.txt line still occurs (the file only shrinks)"
  else bad "every known-debt.txt line still occurs: remove the fixed lines" "$gone"; fi
}

check "$DIR" "$DEBT"

# Fixtures: each file is a manifest set breaking one rule, named by its "# expect: <rule>" line.
if [ "$FIXTURES" = 1 ]; then
  for fx in "$HERE"/fixtures/*.yaml; do
    name=$(basename "$fx" .yaml)
    rule=$(sed -n 's/^# expect: //p' "$fx" | head -1)
    rm -rf "$TMP/fx" && mkdir -p "$TMP/fx" && cp "$fx" "$TMP/fx/"
    found=$(violations "$TMP/fx")
    if grep -q "^$name.yaml $rule " <<<"$found"; then ok "fixture $name is rejected: $rule"
    else bad "fixture $name is rejected: $rule" "${found:-no violation}"; fi
  done
fi

if [ "$FIXTURES" = 1 ]; then
  # The debt file can only shrink: a line for a violation that is gone must fail.
  { cat "$DEBT"; echo "gone.yaml header fixed_already"; } > "$TMP/stale-debt"
  if grep -qxF "gone.yaml header fixed_already" <(comm -13 "$TMP/found" <(grep -vE '^\s*(#|$)' "$TMP/stale-debt" | sort -u)); then
    ok "a known-debt.txt line that no longer occurs is caught"
  else bad "a known-debt.txt line that no longer occurs is caught"; fi
fi

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" = 0 ]
