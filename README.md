# NixOS flake

Declarative NixOS/home-manager configuration for the host machines, one `hosts/{host}/` directory each.

## Hosts

| host | role | setup |
|---|---|---|
| gram | personal laptop | [hosts/gram/README.md](./hosts/gram/README.md) |
| harpe | WSL guest, personal laptop | [hosts/harpe/README.md](./hosts/harpe/README.md) |
| warpe | WSL guest, work laptop (company CA) | [hosts/warpe/README.md](./hosts/warpe/README.md) |
| pewter | Oracle ARM server | [hosts/pewter/README.md](./hosts/pewter/README.md) |
| midd | Windows host (scripts only) | [hosts/midd/README.md](./hosts/midd/README.md) |

## WSL setup

Shared bootstrap for the NixOS-WSL guests lives beside the module: [modules/system/config/wsl/README.md](./modules/system/config/wsl/README.md) (used by harpe and warpe).

## TypeScript packages

The repo root is a pnpm workspace with turbo. Its packages sit next to the Nix modules that run them, and `pnpm-workspace.yaml` lists them:

* [`hosts/pewter/flake-updater/`](./hosts/pewter/flake-updater/): the Updater (ADR 0009)
* [`hosts/gram/x-blocklist/`](./hosts/gram/x-blocklist/): the X blocklist job on gram

`modules/llm/opencode/kiro/` is a Bun project with its own setup and stays outside the workspace. Versions shared across packages, Effect included, are pinned in the catalogs in `pnpm-workspace.yaml`.

```sh
pnpm install
pnpm test      # every package's tests
pnpm ox        # lint, format check and typecheck
pnpm ox:fix    # fix lint and format issues
```

Nix never runs turbo. Each package's `package.nix` builds from the repo root and runs the same checks for that package, so the Build gate tests every package in a host's closure. See ADR 0022. After a dependency change, set that package's `pnpmDeps.hash` to `lib.fakeHash`, build, and copy the hash from the error.

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
