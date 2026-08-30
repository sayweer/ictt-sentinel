#!/usr/bin/env bash
# Put the project-pinned Node/pnpm on PATH for the current shell.
#
#   source scripts/use-pinned-node.sh
#
# Installs nothing globally and does not modify the system. If the pinned
# toolchain is missing, run: node scripts/bootstrap-check.mjs --install

set -u

_ictt_root="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
_ictt_version="$(tr -d '[:space:]' <"${_ictt_root}/.nvmrc")"
_ictt_bin="${_ictt_root}/.tooling/node-${_ictt_version}/bin"

if [ ! -x "${_ictt_bin}/node" ]; then
  echo "pinned Node ${_ictt_version} not found at ${_ictt_bin}" >&2
  echo "run: node scripts/bootstrap-check.mjs --install" >&2
  return 1 2>/dev/null || exit 1
fi

case ":${PATH}:" in
  *":${_ictt_bin}:"*) ;;
  *) PATH="${_ictt_bin}:${PATH}"; export PATH ;;
esac

echo "node $(node --version)  pnpm $(pnpm --version 2>/dev/null || echo 'not activated')"

unset _ictt_root _ictt_version _ictt_bin
