{
  pkgs,
  username,
  host,
}:

pkgs.writeShellApplication {
  name = "nrs";

  text = ''
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
        if [ "$target_host" == "pewter" ]; then
            # Dynamically attach --build-host if targeting ARM oracle cloud server
            build_flags="$build_flags --build-host root@$target_host"
        fi

        # shellcheck disable=SC2086
        nixos-rebuild switch --flake "/home/${username}/conf.nix?submodules=1#$target_host" $build_flags "$@"
    fi
  '';
}
