# NixOS flake

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

#### mounting bitlocker drive

```sh
sudo dislocker-fuse -v -V /dev/nvme1n1p1 -p{recovery_key} -- /mnt/bitlocker-fuse && sudo mount -o loop -t ntfs-3g /mnt/bitlocker-fuse/dislocker-file /mnt/windows
```

```sh
sudo umount /mnt/windows && sudo sudo umount /mnt/bitlocker-fuse
```
