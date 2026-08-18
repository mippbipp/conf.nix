# PC

## manual things

* initial steps
  * `sudo -i`
  * `passwd {username}`
  * `systemctl start sshd`
* [lanzaboote setup](https://nix-community.github.io/lanzaboote/)
  * just reverse and redo the steps on a new machine
* `ssh-keygen -t ed25519` with `{host}_ed25519` as the filename
* github repos
* rclone
* [winapps](https://github.com/winapps-org/winapps)
  * reset: `podman compose --file ~/.config/winapps/compose.yaml down --rmi=all --volumes`
  * install: `podman compose --file ~/.config/winapps/compose.yaml up -d`, windows will be available at `http://127.0.0.1:8006`, sign out
  * [changing `compose.yaml`](https://github.com/winapps-org/winapps/blob/main/docs/docker.md#changing-composeyaml)
  * `podman-compose --file ~/.config/winapps/compose.yaml start`
  * [test rdp if any issues](https://github.com/winapps-org/winapps#step-4-test-freerdp)
  * `winapps-setup` to install windows
  * directly start windows through vicinae after boot

### mounting bitlocker drive

```sh
sudo dislocker-fuse -v -V /dev/nvme1n1p1 -p{recovery_key} -- /mnt/bitlocker-fuse && sudo mount -o loop -t ntfs-3g /mnt/bitlocker-fuse/dislocker-file /mnt/windows
```

```sh
sudo umount /mnt/windows && sudo sudo umount /mnt/bitlocker-fuse
```
