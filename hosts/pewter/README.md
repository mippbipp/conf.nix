# pewter - cloud VM

- set LUKS password in `/tmp/pewter-luks.key`
- initrd host keys made with `ssh-keygen -t ed25519 -N "" -f /tmp/pewter-extra-files/etc/secrets/initrd/ssh_host_ed25519_key`
- tailscale authKeyFile: `echo "tskey-auth-..." > /tmp/pewter-extra-files/var/lib/tailscale/authkey`
- `chmod 600` above files

- init VM:

  ```bash
  nix run github:nix-community/nixos-anywhere -- \
    --flake .#pewter \
    --disk-encryption-keys /tmp/secret.key /tmp/pewter-luks.key \
    --extra-files /tmp/pewter-extra-files root@<PUBLIC_IP>
  ```

- if rebooted, use `ssh pewter-luks` and `systemd-tty-ask-password-agent` to decrypt
- tailscale enabled, no need for TCP port 22 in ingress rules, but pubkeys kept in config.nix for users as backup

- check syncthing status: `ssh -L 8385:127.0.0.1:8384 pewter` -> `http://127.0.0.1:8385`
