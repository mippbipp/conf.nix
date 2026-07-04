# wsl setup

* install steps at <https://nix-community.github.io/NixOS-WSL/install.html>
* `sudo nano /etc/nixos/configuration.nix`
  * add `environment.systemPackages = with pkgs; [git vim];`
  * edit `wsl.defaultUser` to desired username
  * follow <https://nix-community.github.io/NixOS-WSL/how-to/change-username.html>
* set NixOS as default distro to prevent startup errors (`wsl -s NixOS`)
* `git clone --recurse-submodules --remote-submodules https://github.com/mippbipp/conf.nix.git`
* set username and hostname in `flake.nix` `nixosConfigurations.{hostname}`
  * if changing hostname, change folder's name in `hosts` folder
* change variables in `hosts/{hostname}/variables.nix`
* ensure all changes are tracked in git (e.g. `git add .`)
  * push, replace https remote with ssh remote in git and `.gitmodules`, etc
* `cd ~/conf.nix && sudo nixos-rebuild boot --flake .#{hostname}` and follow the above install link to restart NixOS
