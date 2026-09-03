# NixOS flake

Declarative NixOS/home-manager configuration for the host machines, one `hosts/{host}/` directory each.

## Hosts

| host | role | setup |
|---|---|---|
| gram | desktop | [hosts/gram/README.md](./hosts/gram/README.md) |
| harpe | WSL guest, personal laptop | [hosts/harpe/README.md](./hosts/harpe/README.md) |
| warpe | WSL guest, work laptop (company CA) | [hosts/warpe/README.md](./hosts/warpe/README.md) |
| pewter | Oracle ARM server | [hosts/pewter/README.md](./hosts/pewter/README.md) |
| hector | Work EC2 dev machine (aarch64, tailnet-only) | [hosts/hector/README.md](./hosts/hector/README.md) |
| midd | Windows host (scripts only) | [hosts/midd/README.md](./hosts/midd/README.md) |

## WSL setup

Shared bootstrap for the NixOS-WSL guests lives beside the module: [modules/system/config/wsl/README.md](./modules/system/config/wsl/README.md) (used by harpe and warpe).

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
# clone (general use)
cd ~ && git clone --recurse-submodules --remote-submodules git@github.com:mippbipp/conf.nix.git`
```

```sh
nix repl ~/conf.nix#nixosConfigurations.{hostname}.config
```

```sh
journalctl -b --user -u {service-name} -f
```
