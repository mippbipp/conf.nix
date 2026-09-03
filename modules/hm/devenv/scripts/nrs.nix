{
  pkgs,
  username,
  host,
  lib,
  globals,
  sopsSecrets,
}:

let
  # Hosts that build for themselves (e.g. ARM boxes) need --build-host when targeted.
  remoteBuildHosts = lib.attrNames (
    lib.filterAttrs (_: peer: peer.remoteBuilds) globals.hosts
  );
in
pkgs.writeShellApplication {
  name = "nrs";

  text = ''
    REMOTE_BUILD_HOSTS="${lib.concatStringsSep " " remoteBuildHosts}"
    push_cache=false
    if [[ "''${1:-}" == "--push" ]]; then
        push_cache=true
        shift
    fi

    target_host=""
    if [ $# -gt 0 ] && [[ "$1" != -* ]]; then
        target_host="$1"
        shift
    fi

    rebuild() {
        action="$1"
        shift
        if [ -z "$target_host" ]; then
            sudo nixos-rebuild "$action" --flake "/home/${username}/conf.nix?submodules=1#${host}" "$@"
            return
        fi

        build_flags="--target-host root@$target_host"
        if [[ " $REMOTE_BUILD_HOSTS " == *" $target_host "* ]]; then
            build_flags="$build_flags --build-host root@$target_host"
        fi

        # shellcheck disable=SC2086
        nixos-rebuild "$action" --flake "/home/${username}/conf.nix?submodules=1#$target_host" $build_flags "$@"
    }

    if [ "$push_cache" = true ]; then
        rebuild build
    fi
    rebuild switch

    if [ "$push_cache" = true ]; then
        ${if sopsSecrets ? attic_cache_token then ''
          attic login cache ${globals.cache.endpoint} "$(< ${sopsSecrets.attic_cache_token.path})"
          attic push cache:${globals.cache.cacheName} result
        '' else ''
          echo "attic push skipped: no attic_cache_token on ${host} (Work host pull-only, push from pewter/warpe)" >&2
          exit 1
        ''}
    fi
  '';
}
