# pewter - cloud VM

- set LUKS password in `/tmp/pewter-luks.key`
- initrd host keys made with `ssh-keygen -t ed25519 -N "" -f /tmp/pewter-extra-files/etc/secrets/initrd/ssh_host_ed25519_key`
- tailscale authKeyFile: `echo "tskey-auth-..." > /tmp/pewter-extra-files/var/lib/tailscale/authkey`
- sops age key (see [ADR-0008](../../docs/adr/0008-sops-nixos-module-tmpfs-secrets.md)): `install -Dm400 /tmp/pewter-extra-files/var/lib/sops-nix/keys.txt /var/lib/sops-nix/keys.txt`
- `chmod 600` above files

- init VM:

  ```bash
  nix run github:nix-community/nixos-anywhere -- \
    --flake .#pewter \
    --disk-encryption-keys /tmp/secret.key /tmp/pewter-luks.key \
    --extra-files /tmp/pewter-extra-files root@<PUBLIC_IP>
  ```

- if rebooted, use `ssh pewter-luks` and `systemd-tty-ask-password-agent` to decrypt
- tailscale enabled, no need for TCP port 22 in ingress rules, but pubkeys kept in users.nix for users as backup

- check syncthing status: `ssh -L 8385:127.0.0.1:8384 pewter` -> `http://127.0.0.1:8385`

## Attic cache

The Attic cache is served at `https://cache.mippbipp.com/`. The DNS record is
Cloudflare **DNS only**, pointing to pewter's public address
`129.146.202.171`. Cloudflare's edge certificate does not cover this setup;
Nginx obtains and renews a Let's Encrypt certificate directly on pewter.

### One-time prerequisites

1. In Cloudflare DNS for `mippbipp.com`, create an `A` record named `cache`
   pointing to `129.146.202.171` with proxying disabled.
2. In the Oracle Cloud VCN security list, allow inbound TCP ports `80` and
   `443` from `0.0.0.0/0`. The NixOS firewall opens the same ports locally.
3. Add the Attic JWT environment file to the encrypted secrets file. The age
   identity configured by `modules/system/config/sops.nix` is root-readable,
   so run this with the identity path available on the host:

   ```bash
   secret=$(openssl genrsa -traditional 4096 2>/dev/null | base64 -w0)
   sudo env SOPS_AGE_KEY_FILE=/var/lib/sops-nix/keys.txt \
     sops --set "[\"attic_jwt_secret\"] \"ATTIC_SERVER_TOKEN_RS256_SECRET_BASE64=$secret\"" \
     secrets.yaml
   unset secret
   ```

### Deploy and initialize

After committing the configuration, deploy pewter with `nrs pewter`. Check
the service and certificate before initializing the cache:

```bash
systemctl status atticd nginx
journalctl -u atticd -u nginx --since today
curl -fsS https://cache.mippbipp.com/nix-cache-info
```

Create the public cache once, using the Attic administration wrapper installed
by the NixOS module. Choose a stable cache name and record its public signing
key for future `nix.settings` configuration:

```bash
sudo atticd-atticadm cache create fleet --public
sudo atticd-atticadm cache info fleet
```

The CI write token and Build gate integration belong to issue #202. Keep the
Attic JWT secret, cache write token, and signing private material out of git
and out of command output.
