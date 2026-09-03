# WSL guests (harpe, warpe)

Shared bootstrap and runtime notes for the NixOS-WSL guests. Both hosts import the shared module (`./default.nix`) and carry only their deltas locally.

## Bootstrap a new guest

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

## Secret store

gnome-keyring comes in via the shared module; after first launch open `seahorse` and set the Default keyring password blank so t3code connects without prompting (see [ADR 0017](../../../docs/adr/0017-wsl-secret-store-blank-keyring.md)).

## Cold boot

Cold boot took ~18s (Home Manager + nftables + tailscaled, see `systemd-analyze blame`) but WSL waits 10s for init by default, then warns `Failed to start the systemd user session`. The shared module sets `wsl.wslConf.boot.initTimeout = 30000` and disables the host firewall/nftables (NATed behind Windows; tailnet ACLs filter), keeps split-DNS off the `multi-user.target` critical chain (`../dns.nix` is `wantedBy tailscaled.service`), disables the avahi socket WSL hosts don't use, and keeps `linger` as fallback so the user manager/dbus/keyring run even when the login session races. After a cold boot verify with `journalctl -b | grep -iE 'WaitForBoot|CreateLoginSession'`, `loginctl`, and `resolvectl status` (tailscale0 keeps 100.100.100.100). After any manual `tailscale set`, run `systemctl restart tailscale-magicdns-split` — the CLI wipes the routes without restarting the daemon, so `partOf` can't re-fire.
