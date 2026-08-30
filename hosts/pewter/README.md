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

The public cache endpoint is `https://cache.mippbipp.com/fleet`. Attic uses
PostgreSQL metadata and stores objects under
`/var/lib/atticd/storage-postgresql`; Nginx terminates TLS and proxies to the
loopback-bound Attic service.

### Network prerequisites

The public `cache.mippbipp.com` endpoint requires infrastructure outside this
repository:

1. In Cloudflare DNS for `mippbipp.com`, create an `A` record named `cache`
   pointing to pewter's public address `129.146.202.171`. Set it to **DNS
   only**, not proxied; Nginx obtains the certificate directly from Let's
   Encrypt.
2. In the Oracle Cloud VCN security list, allow inbound TCP ports `80` and
   `443` from `0.0.0.0/0`.
3. Deploy the NixOS configuration. Its firewall declaration opens the same
   ports on pewter.

### Manual initialization

The NixOS module declares the Attic service, database, storage, and proxy, but
cache creation and client credentials are Attic state. After the first
deployment, initialize the public `fleet` cache once:

```bash
token=$(sudo atticd-atticadm make-token \
  --sub admin \
  --validity '1 year' \
  --create-cache fleet \
  --pull fleet \
  --push fleet)
attic login cache https://cache.mippbipp.com "$token"
attic cache create cache:fleet --public  # only if fleet does not exist
attic cache info cache:fleet
unset token
```

Record the `Public Key` from `attic cache info` in
`modules/system/config/nix.nix` and the Build gate workflow. The private
signing material stays in Attic's database; client write tokens belong in
`secrets.yaml` and must never be committed in plaintext.

Deploy configuration changes with `nrs pewter`, then check:

```bash
systemctl status atticd nginx
curl -fsS https://cache.mippbipp.com/fleet/nix-cache-info
nix show-config | grep -E 'substituters|trusted-public-keys'
```

All NixOS hosts are configured to substitute from this cache. Normal `nrs`
rebuilds only read from it. To publish a successful local rebuild explicitly,
use the write-capable token provisioned through sops-nix:

```bash
nrs --push
nrs --push pewter
```

The first command switches the current host and pushes its `result` closure;
the second targets pewter. The token has pull and push access to `fleet` and is
not part of the Nix configuration or shell history.
