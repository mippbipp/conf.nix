{
  pkgs,
  username,
  host,
  lib,
  globals,
}:

let
  # Hosts that build for themselves (e.g. ARM boxes) need --build-host when targeted.
  remoteBuildHosts = lib.attrNames (
    lib.filterAttrs (_: peer: peer.remoteBuilds or false) globals.hosts
  );
in
pkgs.writeShellApplication {
  name = "nrs";

  text = ''
    REMOTE_BUILD_HOSTS="${lib.concatStringsSep " " remoteBuildHosts}"
    if [ $# -eq 0 ]; then
        # No arguments, rebuild default host
        sudo nixos-rebuild switch --flake "/home/${username}/conf.nix?submodules=1#${host}"
    elif [[ "$1" == -* ]]; then
        # First argument is a flag, assume default host and pass all args as flags
        sudo nixos-rebuild switch --flake "/home/${username}/conf.nix?submodules=1#${host}" "$@"
    else
        # First argument is likely a specific target host
        target_host="$1"
        shift # Remove the hostname from the arguments

        build_flags="--target-host root@$target_host"
        if [[ " $REMOTE_BUILD_HOSTS " == *" $target_host "* ]]; then
            build_flags="$build_flags --build-host root@$target_host"
        fi

        # shellcheck disable=SC2086
        nixos-rebuild switch --flake "/home/${username}/conf.nix?submodules=1#$target_host" $build_flags "$@"
    fi
  '';
}
