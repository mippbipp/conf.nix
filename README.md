# NixOS flake

Declarative NixOS/home-manager configuration for the host machines, one `hosts/{host}/` directory each.

## Hosts

| host | role | setup |
|---|---|---|
| gram | desktop | [hosts/gram/README.md](./hosts/gram/README.md) |
| harpe | WSL guest, personal laptop | [hosts/harpe/README.md](./hosts/harpe/README.md) |
| warpe | WSL guest, work laptop (company CA) | [hosts/warpe/README.md](./hosts/warpe/README.md) |
| pewter | Oracle ARM server | [hosts/pewter/README.md](./hosts/pewter/README.md) |
| midd | Windows host (scripts only) | [hosts/midd/README.md](./hosts/midd/README.md) |

## WSL setup

Shared bootstrap for a new NixOS-WSL guest (used by harpe and warpe).

* install steps at <https://nix-community.github.io/NixOS-WSL/install.html>
* `sudo nixos-rebuild edit`:

  ```nix
  environment.systemPackages = with pkgs; [ git neovim ];
   nix.settings.extra-experimental-features = [
     "nix-command"
     "flakes"
   ];
  ```

* follow <https://nix-community.github.io/NixOS-WSL/how-to/change-username.html>
* set NixOS as default distro to prevent startup errors (`wsl -s NixOS`)
  * can rm default `nixos` user dir
* `ssh-keygen -t ed25519` with {host}_ed25519 as the filename, `ssh-add ~/.ssh/{host}_ed25519`, add pubkey to github
* `nix-shell -p git neovim` -> `git clone --recurse-submodules --remote-submodules git@github.com:mippbipp/conf.nix.git`
* set username and hostname in `flake.nix` `nixosConfigurations.{hostname}`
  * if changing hostname, change folder's name in `hosts` folder
* change variables in `hosts/{hostname}/variables.nix`
* ensure all changes are tracked in git (e.g. `git add .`)
  * push, replace https remote with ssh remote in git and `.gitmodules`, etc
* `cd ~/conf.nix && sudo nixos-rebuild boot --flake .#{hostname}`
* pwsh: `wsl -t NixOS` -> `wsl -d NixOS --user root exit` -> `wsl -t NixOS` -> open WSL
* launch terminal e.g. ghostty with a windows shortcut: `"C:\Program Files\WSL\wslg.exe" -d NixOS --cd ~ -- ghostty`

## References & Resources

* nixos
  * <https://github.com/Zaney/zaneyos>
  * <https://github.com/librephoenix/nixos-config>
  * <https://lazamar.co.uk/nix-versions>
* nvim
  * <https://github.com/ThePrimeagen/init.lua>
  * <https://github.com/nvim-lua/kickstart.nvim>
  * <https://www.lazyvim.org>

### useful commands

```sh
nix repl ~/conf.nix#nixosConfigurations.{hostname}.config
```

```sh
journalctl -b --user -u {service-name} -f
```
